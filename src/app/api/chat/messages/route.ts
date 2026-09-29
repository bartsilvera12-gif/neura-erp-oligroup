import { NextRequest, NextResponse } from "next/server";
import { pgLoadConversationForSend, pgSelectChatMessagesForInboxApi } from "@/lib/chat/chat-send-persist-pg";
import { filterConversationIdsByOmnicanalScope } from "@/lib/chat/omnicanal-scope";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { attachCampaignTemplateDisplay } from "@/lib/chat/attach-campaign-template-display";

/**
 * GET /api/chat/messages?conversation_id=…
 * Historial de mensajes de una conversación de la empresa (service role).
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const conversationId = request.nextUrl.searchParams.get("conversation_id")?.trim() ?? "";
    if (!conversationId) {
      return NextResponse.json(errorResponse("conversation_id requerido"), { status: 400 });
    }

    const { supabase, auth } = ctx;
    const usuarioId = (auth.usuarioCatalogId ?? "").trim();

    const dataSchema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
    const pool = getChatPostgresPool();
    const tenantPg = Boolean(pool && isLikelyUnexposedTenantChatSchema(dataSchema));

    if (tenantPg && pool) {
      const conv = await pgLoadConversationForSend(pool, dataSchema, conversationId);
      if (!conv || conv.empresa_id !== auth.empresa_id) {
        return NextResponse.json(errorResponse("Conversación no encontrada"), { status: 404 });
      }

      if (usuarioId) {
        try {
          const catalogSr = createServiceRoleClient();
          const visible = await filterConversationIdsByOmnicanalScope(
            supabase,
            catalogSr,
            auth.empresa_id,
            usuarioId,
            [conversationId]
          );
          if (!visible.has(conversationId)) {
            return NextResponse.json(errorResponse("Sin acceso a esta conversación"), { status: 403 });
          }
        } catch (e) {
          console.error("[api/chat/messages] validación de alcance omnicanal omitida:", e);
        }
      }

      const rows = await pgSelectChatMessagesForInboxApi(pool, dataSchema, conversationId);
      return NextResponse.json(
        successResponse(await attachCampaignTemplateDisplay(auth.empresa_id, rows as Record<string, unknown>[]))
      );
    }

    const { data: conv, error: cErr } = await supabase
      .from("chat_conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (cErr) {
      return NextResponse.json(errorResponse(cErr.message), { status: 400 });
    }
    if (!conv) {
      return NextResponse.json(errorResponse("Conversación no encontrada"), { status: 404 });
    }

    if (usuarioId) {
      try {
        const catalogSr = createServiceRoleClient();
        const visible = await filterConversationIdsByOmnicanalScope(
          supabase,
          catalogSr,
          auth.empresa_id,
          usuarioId,
          [conversationId]
        );
        if (!visible.has(conversationId)) {
          return NextResponse.json(errorResponse("Sin acceso a esta conversación"), { status: 403 });
        }
      } catch (e) {
        console.error("[api/chat/messages] validación de alcance omnicanal omitida:", e);
      }
    }

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, from_me, message_type, content, raw_payload, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }
    return NextResponse.json(
      successResponse(await attachCampaignTemplateDisplay(auth.empresa_id, (data ?? []) as Record<string, unknown>[]))
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
