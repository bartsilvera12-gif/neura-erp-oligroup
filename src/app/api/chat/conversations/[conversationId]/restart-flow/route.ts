import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { restartWhatsappConversationToFlowStart } from "@/lib/chat/resolve-whatsapp-active-flow";
import { createFlowEngine } from "@/lib/chat/flow-engine-service";

const EVENT_OK = "manual_flow_restart" as const;
const EVENT_FAIL = "manual_flow_restart_failed" as const;

/**
 * POST /api/chat/conversations/:conversationId/restart-flow
 *
 * Reinicia la conversación al PRIMER nodo del flujo activo con una SESIÓN NUEVA
 * (los datos de la sesión anterior —cédula, nombre, comprobante, orden— no se
 * reutilizan porque viven por `chat_flow_data.flow_session_id`). Fuerza modo bot
 * y presenta la bienvenida. Es la acción correcta para un cliente que ya compró
 * y quiere empezar otra compra; a diferencia de `resend-current-node`, NO reenvía
 * el nodo actual (que en el nodo final sería re-mandar la confirmación).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const { conversationId: rawId } = await context.params;
    const conversationId = (rawId ?? "").trim();
    if (!conversationId) {
      return NextResponse.json({ ok: false, error: "Falta conversationId" }, { status: 400 });
    }

    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);

    const { data: conv, error: convErr } = await supabase
      .from("chat_conversations")
      .select("id, empresa_id, flow_code, status")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr) {
      return NextResponse.json({ ok: false, error: convErr.message }, { status: 400 });
    }
    if (!conv) {
      return NextResponse.json({ ok: false, error: "Conversación no encontrada" }, { status: 404 });
    }
    const empresaIdRow = String((conv as { empresa_id?: string }).empresa_id ?? "").trim();
    if (empresaIdRow !== auth.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
    }
    if ((conv as { status?: string | null }).status === "closed") {
      return NextResponse.json(
        { ok: false, error: "La conversación está cerrada. Reabrila antes de reiniciar el flujo." },
        { status: 400 }
      );
    }

    const prevFlow = String((conv as { flow_code?: string | null }).flow_code ?? "").trim() || null;
    const operatorLabel = (auth.nombre ?? auth.user.email ?? "").trim() || null;

    const rr = await restartWhatsappConversationToFlowStart(supabase, auth.empresa_id, conversationId, {
      preferFlowCode: prevFlow,
      trigger: "inbox_manual_restart",
      preserveReferralFromPreviousSession: true,
    });

    if (!rr.restarted) {
      const { error: evErr } = await supabase.from("chat_flow_events").insert({
        empresa_id: auth.empresa_id,
        conversation_id: conversationId,
        flow_code: prevFlow,
        node_code: null,
        event_type: EVENT_FAIL,
        payload: { source: "inbox", operator_user_id: auth.user.id, operator_label: operatorLabel, reason: rr.reason },
      });
      if (evErr) console.error("[restart-flow] audit insert failed:", evErr.message);
      return NextResponse.json(
        {
          ok: false,
          error:
            rr.reason === "no_active_flow"
              ? "No hay un flujo de WhatsApp activo para reiniciar."
              : "No se pudo reiniciar el flujo. Revisá los logs.",
        },
        { status: 400 }
      );
    }

    // Presentar el primer nodo (bienvenida; el motor encadena hasta el primer paso con input).
    const engine = createFlowEngine({ supabase });
    const sent = await engine.sendCurrentFlowNode({ conversationId });

    const { error: okEvErr } = await supabase.from("chat_flow_events").insert({
      empresa_id: auth.empresa_id,
      conversation_id: conversationId,
      flow_code: rr.flow_code,
      node_code: rr.flow_current_node,
      flow_session_id: rr.new_flow_session_id ?? null,
      event_type: EVENT_OK,
      payload: {
        source: "inbox",
        operator_user_id: auth.user.id,
        operator_label: operatorLabel,
        new_flow_session_id: rr.new_flow_session_id ?? null,
        presented: sent.ok,
        present_error: sent.ok ? null : (sent.error ?? "send_failed"),
      },
    });
    if (okEvErr) console.error("[restart-flow] audit insert failed:", okEvErr.message);

    return NextResponse.json({
      ok: true,
      flow_code: rr.flow_code,
      flow_current_node: rr.flow_current_node,
      node_code: sent.nodeCode ?? rr.flow_current_node,
      presented: sent.ok,
      ...(sent.ok ? {} : { present_error: sent.error ?? "send_failed" }),
    });
  } catch (e) {
    console.error("[restart-flow]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
