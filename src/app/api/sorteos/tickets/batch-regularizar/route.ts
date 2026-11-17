import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { createServiceRoleClientForEmpresa } from "@/lib/supabase/empresa-data-schema";
import {
  buildOrderResultFromEntradaId,
  flowDataStubFromEntrada,
} from "@/lib/sorteos/sorteo-ticket-admin";
import {
  maybeGenerateAndSendSorteoTicketDelivery,
  resendSorteoTicketByDeliveryId,
} from "@/lib/sorteos/sorteo-ticket-delivery";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/sorteos/tickets/batch-regularizar
 *
 * Regulariza boletas que se generaron con el banner "PROVISORIA" (ventana del
 * 16/11 antes del fix "boleta al cliente siempre normal"): por cada orden
 * CONFIRMADA regenera el PNG SIN banner (misma numeración, nueva revisión
 * is_current — la regeneración usa `maybeGenerateAndSendSorteoTicketDelivery`,
 * que ya fuerza provisional=false) y, si `reenviar`, lo reenvía por WhatsApp.
 *
 * Body: { numeros_orden: number[], reenviar?: boolean }  (reenviar por defecto true)
 */
const CAPTION_REGULARIZACION =
  "Te reenviamos tu boleta de participación, ya confirmada. ¡Gracias y muchos éxitos en el sorteo! 🍀";

export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;

    const body = (await request.json().catch(() => ({}))) as {
      numeros_orden?: unknown;
      reenviar?: unknown;
    };
    const numeros = Array.isArray(body.numeros_orden)
      ? Array.from(
          new Set(
            body.numeros_orden
              .map((n) => Number(n))
              .filter((n) => Number.isFinite(n) && n > 0)
          )
        )
      : [];
    const reenviar = body.reenviar !== false; // default true
    if (numeros.length === 0) {
      return NextResponse.json(errorResponse("Faltan numeros_orden"), { status: 400 });
    }
    if (numeros.length > 60) {
      return NextResponse.json(errorResponse("Máximo 60 órdenes por tanda"), { status: 400 });
    }

    const sbFlow = await getChatServiceClientForEmpresa(empresaId);
    const sb = await createServiceRoleClientForEmpresa(empresaId);

    const resultados: Array<Record<string, unknown>> = [];
    for (const numero of numeros) {
      const res: Record<string, unknown> = { numero_orden: numero };
      try {
        const { data: ent } = await sb
          .from("sorteo_entradas")
          .select("id, chat_conversation_id, conversacion_id, estado_pago")
          .eq("empresa_id", empresaId)
          .eq("numero_orden", numero)
          .maybeSingle();
        if (!ent) {
          res.status = "no_existe";
          resultados.push(res);
          continue;
        }
        const row = ent as {
          id: string;
          chat_conversation_id?: string | null;
          conversacion_id?: string | null;
          estado_pago?: string | null;
        };
        // Guarda: solo regularizamos órdenes CONFIRMADAS (no mandar boleta válida
        // a una compra que todavía no se confirmó).
        if (String(row.estado_pago ?? "").trim() !== "confirmado") {
          res.status = "no_confirmado_skip";
          res.estado_pago = row.estado_pago ?? null;
          resultados.push(res);
          continue;
        }
        const entradaId = row.id;
        const conversationId = row.chat_conversation_id ?? row.conversacion_id ?? null;

        // 1) Regenerar PNG normal (sin banner, misma numeración): nueva revisión is_current.
        await sb
          .from("sorteo_ticket_deliveries")
          .update({ is_current: false, updated_at: new Date().toISOString() })
          .eq("entrada_id", entradaId)
          .eq("empresa_id", empresaId);

        const orderResult = await buildOrderResultFromEntradaId(sb, entradaId, empresaId);
        const fd = await flowDataStubFromEntrada(sb, entradaId);
        if (!orderResult) {
          res.status = "orderResult_null";
          resultados.push(res);
          continue;
        }
        const gen = await maybeGenerateAndSendSorteoTicketDelivery({
          supabase: sbFlow,
          empresaId,
          sorteoId: orderResult.sorteoId,
          entradaId,
          conversationId,
          flowSessionId: null,
          contactId: "",
          channelId: "",
          orderResult,
          flowData: fd,
          trigger: "confirmacion_final",
          skipWhatsApp: true,
        });
        res.regenerado = gen.ok !== false;
        if (gen.skipped) res.regen_skip = gen.reason ?? true;

        if (!reenviar) {
          res.status = "ok_regenerado";
          resultados.push(res);
          continue;
        }

        // 2) Reenviar la nueva revisión por WhatsApp.
        const { data: cur } = await sb
          .from("sorteo_ticket_deliveries")
          .select("id")
          .eq("entrada_id", entradaId)
          .eq("empresa_id", empresaId)
          .eq("is_current", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const newId = (cur as { id?: string } | null)?.id;
        if (!newId) {
          res.status = "sin_delivery_nueva";
          resultados.push(res);
          continue;
        }
        const snd = await resendSorteoTicketByDeliveryId({
          supabase: sbFlow,
          empresaId,
          deliveryId: newId,
          captionOverride: CAPTION_REGULARIZACION,
        });
        res.reenviado = snd.ok;
        if (!snd.ok) res.reenvio_error = snd.error ?? "error";
        res.status = snd.ok ? "ok_enviado" : "regenerado_sin_enviar";
      } catch (e) {
        res.status = "error";
        res.error = e instanceof Error ? e.message.slice(0, 200) : String(e);
      }
      resultados.push(res);
    }

    const ok = resultados.filter(
      (r) => r.status === "ok_enviado" || r.status === "ok_regenerado"
    ).length;
    return NextResponse.json(
      successResponse({ total: numeros.length, ok, resultados })
    );
  } catch (err) {
    return NextResponse.json(
      errorResponse(err instanceof Error ? err.message : "Error"),
      { status: 500 }
    );
  }
}
