import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import {
  pgInsertChatMessageOutbound,
  pgLoadConversationForSend,
  pgMarkFirstHumanReplyIfUnset,
  pgTouchConversationLastMessage,
} from "@/lib/chat/chat-send-persist-pg";
import { markFirstHumanOperatorReply } from "@/lib/chat/conversation-sla-markers";
import { maybeAutoTakeoverOnHumanSend } from "@/lib/chat/auto-takeover";
import {
  resolveOutboundTextContextFromIds,
  sendOutboundTextMessage,
} from "@/lib/chat/outbound-send-dispatch";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";

/**
 * POST /api/chat/send
 * Envía texto por WhatsApp (Meta Graph o YCloud) y persiste mensaje saliente.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const conversationId =
      body && typeof body === "object" && typeof (body as { conversation_id?: string }).conversation_id === "string"
        ? (body as { conversation_id: string }).conversation_id
        : null;
    const message =
      body && typeof body === "object" && typeof (body as { message?: string }).message === "string"
        ? (body as { message: string }).message.trim()
        : "";
    const senderTypeInput =
      body && typeof body === "object" && typeof (body as { sender_type?: string }).sender_type === "string"
        ? (body as { sender_type: string }).sender_type
        : "human";
    const automationSource =
      body && typeof body === "object" && typeof (body as { automation_source?: string }).automation_source === "string"
        ? (body as { automation_source: string }).automation_source.trim()
        : "";
    const senderType: "human" | "ai" | "system" =
      senderTypeInput === "ai" || senderTypeInput === "system" ? senderTypeInput : "human";

    if (!conversationId || !message) {
      return NextResponse.json(
        { ok: false, error: "Se requiere conversation_id y message" },
        { status: 400 }
      );
    }

    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    const dataSchema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const pool = getChatPostgresPool();
    const tenantPg = Boolean(pool && isLikelyUnexposedTenantChatSchema(dataSchema));

    let conv: {
      empresa_id: string;
      contact_id: string;
      channel_id: string;
    } | null = null;

    if (tenantPg && pool) {
      conv = await pgLoadConversationForSend(pool, dataSchema, conversationId);
    } else {
      const { data: cdata, error: cErr } = await supabase
        .from("chat_conversations")
        .select("id, empresa_id, contact_id, channel_id")
        .eq("id", conversationId)
        .maybeSingle();
      if (cErr || !cdata) {
        return NextResponse.json({ ok: false, error: "Conversación no encontrada" }, { status: 404 });
      }
      conv = {
        empresa_id: cdata.empresa_id as string,
        contact_id: cdata.contact_id as string,
        channel_id: cdata.channel_id as string,
      };
    }

    if (!conv) {
      return NextResponse.json({ ok: false, error: "Conversación no encontrada" }, { status: 404 });
    }

    if (conv.empresa_id !== auth.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 403 });
    }

    let outbound;
    try {
      outbound = await resolveOutboundTextContextFromIds(
        supabase,
        {
          contactId: conv.contact_id,
          channelId: conv.channel_id,
        },
        { dataSchema, empresaId: conv.empresa_id }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Datos de envío incompletos";
      let status = 400;
      if (msg.includes("desactivado")) status = 403;
      else if (msg.includes("configuración completa")) status = 400;
      else if (msg.includes("token") || msg.includes("ycloud_api_key")) status = 500;
      return NextResponse.json({ ok: false, error: msg }, { status });
    }

    if (outbound.provider === "ycloud") {
      console.info("[api/chat/send] ycloud_outbound", { conversationId });
    }

    const sendResult = await sendOutboundTextMessage(outbound, message);

    if (!sendResult.ok) {
      return NextResponse.json(
        { ok: false, error: sendResult.error, meta: sendResult.raw },
        { status: 502 }
      );
    }

    const empresaId = conv.empresa_id;
    const ts = new Date().toISOString();

    if (tenantPg && pool) {
      try {
        await pgInsertChatMessageOutbound(pool, dataSchema, {
          empresa_id: empresaId,
          conversation_id: conversationId,
          wa_message_id: sendResult.waMessageId ?? null,
          from_me: true,
          sender_type: senderType,
          sent_by_user_id: senderType === "human" ? auth.user.id : null,
          sent_by_user_name: senderType === "human" ? auth.nombre ?? auth.user.email ?? null : null,
          automation_source: automationSource || (senderType === "ai" ? "automation" : null),
          message_type: "text",
          content: message,
          raw_payload: (sendResult.raw ?? {}) as Record<string, unknown>,
        });
      } catch (insE) {
        const msg = insE instanceof Error ? insE.message : String(insE);
        return NextResponse.json(
          { ok: false, error: "Mensaje enviado pero no guardado: " + msg },
          { status: 500 }
        );
      }

      await pgTouchConversationLastMessage(pool, dataSchema, conversationId, ts, message);
      if (senderType === "human") {
        await pgMarkFirstHumanReplyIfUnset(pool, dataSchema, empresaId, conversationId, ts);
      }

      // FASE 4: si el envío es de un operador humano autenticado, promovemos
      // la conversación a modo humano (idempotente, sin tocar al cliente).
      // El flow-engine ya respeta `human_taken_over=true` y dejará de
      // procesar inbounds de esta conversación hasta que se vuelva al bot.
      await maybeAutoTakeoverOnHumanSend({
        supabase,
        pool,
        schema: dataSchema,
        useTenantPg: true,
        empresaId,
        conversationId,
        senderType,
        byUserId: senderType === "human" ? auth.user.id : null,
        byUserName: senderType === "human" ? auth.nombre ?? auth.user.email ?? null : null,
      });
    } else {
      const { error: insErr } = await supabase.from("chat_messages").insert({
        empresa_id: empresaId,
        conversation_id: conversationId,
        wa_message_id: sendResult.waMessageId,
        from_me: true,
        sender_type: senderType,
        sent_by_user_id: senderType === "human" ? auth.user.id : null,
        sent_by_user_name: senderType === "human" ? auth.nombre ?? auth.user.email ?? null : null,
        automation_source: automationSource || (senderType === "ai" ? "automation" : null),
        message_type: "text",
        content: message,
        raw_payload: (sendResult.raw ?? {}) as Record<string, unknown>,
      });

      if (insErr) {
        return NextResponse.json(
          { ok: false, error: "Mensaje enviado pero no guardado: " + insErr.message },
          { status: 500 }
        );
      }

      await supabase
        .from("chat_conversations")
        .update({
          last_message_at: ts,
          last_message_preview: message.slice(0, 280),
          updated_at: ts,
        })
        .eq("id", conversationId);

      await markFirstHumanOperatorReply(supabase, empresaId, conversationId, {
        from_me: true,
        sender_type: senderType,
      });

      // FASE 4: idem rama PostgREST (cuando NO es tenantPg directo).
      await maybeAutoTakeoverOnHumanSend({
        supabase,
        pool: null,
        schema: dataSchema,
        useTenantPg: false,
        empresaId,
        conversationId,
        senderType,
        byUserId: senderType === "human" ? auth.user.id : null,
        byUserName: senderType === "human" ? auth.nombre ?? auth.user.email ?? null : null,
      });
    }

    return NextResponse.json({
      ok: true,
      wa_message_id: sendResult.waMessageId,
    });
  } catch (e) {
    console.error("[api/chat/send]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
