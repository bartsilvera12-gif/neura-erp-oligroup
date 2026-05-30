import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { resendSorteoTicketByDeliveryId } from "@/lib/sorteos/sorteo-ticket-delivery";

/**
 * Caption fijo para REENVÍO MANUAL desde el botón "Reenviar WA" del listado
 * de Tickets. NO afecta el envío automático original del flujo (ese sigue
 * derivando el caption desde `ticket_image_config` del sorteo).
 */
const TRIPLE7_RESEND_DEFAULT_CAPTION =
  "Te reenviamos tu comprobante de participación de TRIPLE 7. Guardalo como respaldo. ¡Éxitos!";

const WA_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const { id } = await params;
    const sb = await getChatServiceClientForEmpresa(empresaId);

    // ----- Validación server-side de la ventana de 24h de WhatsApp -----
    // No confiamos en el frontend: si la ventana está vencida (o no se puede
    // determinar), bloqueamos antes de hablar con Meta y antes de tocar
    // sorteo_ticket_deliveries / chat_messages.
    const { data: ticketRow, error: tErr } = await sb
      .from("sorteo_ticket_deliveries")
      .select("id, conversation_id")
      .eq("id", id)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (tErr) {
      console.error("[api/sorteos/tickets/resend] ticket_lookup_error", {
        empresaId,
        ticketId: id,
        message: tErr.message,
      });
      return NextResponse.json(errorResponse("ticket_lookup_failed"), { status: 500 });
    }
    if (!ticketRow) {
      return NextResponse.json(errorResponse("not_found"), { status: 404 });
    }

    const convId = (ticketRow as { conversation_id?: string | null }).conversation_id;
    if (!convId) {
      return NextResponse.json(
        errorResponse(
          "Este ticket no tiene conversación asociada. No se puede determinar la ventana de 24h de WhatsApp."
        ),
        { status: 409 }
      );
    }

    const { data: lastInboundRow, error: msgErr } = await sb
      .from("chat_messages")
      .select("created_at")
      .eq("conversation_id", convId)
      .eq("from_me", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (msgErr) {
      console.error("[api/sorteos/tickets/resend] inbound_lookup_error", {
        empresaId,
        ticketId: id,
        message: msgErr.message,
      });
      return NextResponse.json(errorResponse("inbound_lookup_failed"), { status: 500 });
    }

    const lastInboundIso =
      (lastInboundRow as { created_at?: string } | null)?.created_at ?? null;

    if (!lastInboundIso) {
      return NextResponse.json(
        errorResponse(
          "Ventana de 24h desconocida (sin mensajes inbound del cliente). Para reenviar este comprobante se requiere una plantilla aprobada."
        ),
        { status: 409 }
      );
    }
    const lastMs = Date.parse(lastInboundIso);
    if (!Number.isFinite(lastMs)) {
      return NextResponse.json(
        errorResponse(
          "Ventana de 24h desconocida (timestamp inválido). Para reenviar este comprobante se requiere una plantilla aprobada."
        ),
        { status: 409 }
      );
    }
    const elapsed = Date.now() - lastMs;
    if (elapsed >= WA_WINDOW_MS) {
      return NextResponse.json(
        errorResponse(
          "La ventana de 24h de WhatsApp está vencida. Para reenviar este comprobante se requiere una plantilla aprobada."
        ),
        { status: 409 }
      );
    }

    // ----- Ventana abierta: delegamos al resend existente -----
    const r = await resendSorteoTicketByDeliveryId({
      supabase: sb,
      empresaId,
      deliveryId: id,
      captionOverride: TRIPLE7_RESEND_DEFAULT_CAPTION,
    });
    if (!r.ok) {
      const st =
        r.error === "not_found" ? 404 : r.error === "no_file" || r.error === "no_conversation" ? 400 : 500;
      return NextResponse.json(errorResponse(r.error ?? "failed"), { status: st });
    }
    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
