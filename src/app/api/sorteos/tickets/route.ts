import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * GET /api/sorteos/tickets — lista entregas de tickets (reservorio).
 *
 * Mejoras vs versión anterior:
 *  - Projection liviana: solo columnas usadas por la UI (sin payload_snapshot,
 *    config_snapshot, cupones, raw_payload, etc.).
 *  - Búsqueda `q` en el servidor (ilike sobre cliente_nombre / documento /
 *    teléfono / numero_orden), no en cliente.
 *  - Paginación: ?limit (default 100, max 200), ?offset (default 0). Devuelve
 *    `total`, `hasMore`, `limit`, `offset` en el body.
 *  - Estado de la ventana de 24h de WhatsApp por ticket de esta página:
 *    `whatsapp_window_status` ("open" | "expired" | "unknown"),
 *    `whatsapp_window_label`, `whatsapp_window_remaining_ms`, `last_inbound_at`.
 *    La ventana se calcula desde el último mensaje inbound del cliente
 *    (chat_messages.from_me=false), NO desde el último outbound.
 *
 * No genera signed URLs en el listado (las hace on-demand /signed-url o resend).
 * No toca el flujo, el webhook, ni la generación automática de tickets.
 */

const TICKET_FIELDS = [
  "id",
  "sorteo_id",
  "entrada_id",
  "status",
  "cliente_nombre",
  "cliente_documento",
  "telefono",
  "numero_orden",
  "created_at",
  "conversation_id",
  "channel_id",
  "storage_bucket",
  "storage_path",
].join(", ");

const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

type TicketBaseRow = {
  id: string;
  sorteo_id: string | null;
  entrada_id: string | null;
  status: string;
  cliente_nombre: string | null;
  cliente_documento: string | null;
  telefono: string | null;
  numero_orden: string | null;
  created_at: string;
  conversation_id: string | null;
  channel_id: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

type WindowStatus = "open" | "expired" | "unknown";

function computeWindow(lastInboundIso: string | null): {
  whatsapp_window_status: WindowStatus;
  whatsapp_window_label: string;
  whatsapp_window_remaining_ms: number | null;
  last_inbound_at: string | null;
} {
  if (!lastInboundIso) {
    return {
      whatsapp_window_status: "unknown",
      whatsapp_window_label: "Ventana WA desconocida",
      whatsapp_window_remaining_ms: null,
      last_inbound_at: null,
    };
  }
  const last = Date.parse(lastInboundIso);
  if (!Number.isFinite(last)) {
    return {
      whatsapp_window_status: "unknown",
      whatsapp_window_label: "Ventana WA desconocida",
      whatsapp_window_remaining_ms: null,
      last_inbound_at: lastInboundIso,
    };
  }
  const elapsed = Date.now() - last;
  if (elapsed >= WA_WINDOW_MS) {
    return {
      whatsapp_window_status: "expired",
      whatsapp_window_label: "Ventana WA vencida · usar plantilla",
      whatsapp_window_remaining_ms: 0,
      last_inbound_at: lastInboundIso,
    };
  }
  const remaining = elapsed <= 0 ? WA_WINDOW_MS : WA_WINDOW_MS - elapsed;
  const h = Math.floor(remaining / (60 * 60 * 1000));
  const m = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
  return {
    whatsapp_window_status: "open",
    whatsapp_window_label: `Ventana WA: quedan ${h}h ${m}m`,
    whatsapp_window_remaining_ms: remaining,
    last_inbound_at: lastInboundIso,
  };
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const url = new URL(request.url);
    const sorteoId = url.searchParams.get("sorteo_id")?.trim() || "";
    const status = url.searchParams.get("status")?.trim() || "";
    const q = url.searchParams.get("q")?.trim() || "";

    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const rawOffset = Number.parseInt(url.searchParams.get("offset") ?? "", 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100));
    const offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);

    const sb = await getChatServiceClientForEmpresa(empresaId);
    let query = sb
      .from("sorteo_ticket_deliveries")
      .select(TICKET_FIELDS, { count: "exact" })
      .eq("empresa_id", empresaId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (sorteoId) query = query.eq("sorteo_id", sorteoId);
    if (status && ["pending", "generated", "sent", "error"].includes(status)) {
      query = query.eq("status", status);
    }
    if (q) {
      // Sanitizamos caracteres que rompen el parser del `or` de PostgREST.
      const term = q.replace(/[(),%*]/g, " ").trim();
      if (term) {
        const like = `*${term}*`; // PostgREST ilike acepta `*` como wildcard
        query = query.or(
          `cliente_nombre.ilike.${like},cliente_documento.ilike.${like},telefono.ilike.${like},numero_orden.ilike.${like}`
        );
      }
    }

    const { data, error, count } = await query;
    if (error) {
      const hint = /sorteo_ticket_deliveries|does not exist|relation/i.test(error.message)
        ? " Verificá que la migración sorteo_ticket_deliveries esté aplicada en el schema tenant (erp_*)."
        : "";
      console.error("[api/sorteos/tickets] list_error", { empresaId, message: error.message });
      return NextResponse.json(errorResponse(`${error.message}${hint}`), { status: 400 });
    }

    const rows = (data ?? []) as unknown as TicketBaseRow[];

    // ---- Ventana WhatsApp 24h: una sola query para todos los conv de la página ----
    const convIds = Array.from(
      new Set(rows.map((r) => r.conversation_id).filter((v): v is string => !!v))
    );
    const lastInboundByConv = new Map<string, string>();
    if (convIds.length > 0) {
      // Traemos los inbound de esos conv ordenados DESC y nos quedamos con el
      // primero por conversation_id. Topamos para evitar respuestas enormes.
      const safetyCap = Math.min(5000, Math.max(convIds.length * 50, 500));
      const { data: msgs, error: msgErr } = await sb
        .from("chat_messages")
        .select("conversation_id, created_at")
        .in("conversation_id", convIds)
        .eq("from_me", false)
        .order("created_at", { ascending: false })
        .limit(safetyCap);
      if (msgErr) {
        console.warn("[api/sorteos/tickets] inbound_lookup_warn", {
          empresaId,
          message: msgErr.message,
        });
      } else {
        for (const m of (msgs ?? []) as Array<{ conversation_id: string; created_at: string }>) {
          if (!lastInboundByConv.has(m.conversation_id)) {
            lastInboundByConv.set(m.conversation_id, m.created_at);
          }
        }
      }
    }

    const enriched = rows.map((r) => {
      const last = r.conversation_id ? lastInboundByConv.get(r.conversation_id) ?? null : null;
      return { ...r, ...computeWindow(last) };
    });

    const total = typeof count === "number" ? count : null;
    const hasMore =
      total != null ? offset + enriched.length < total : enriched.length >= limit;

    return NextResponse.json({
      success: true,
      data: enriched,
      total,
      limit,
      offset,
      hasMore,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
