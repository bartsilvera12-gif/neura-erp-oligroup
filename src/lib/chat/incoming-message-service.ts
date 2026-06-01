/**
 * Entrada omnicanal: persistencia central de mensajes entrantes y contacto/conversación.
 * WhatsApp en producción sigue pasando por `processInboundWebhookValue` (flujos, CRM, media);
 * este módulo concentra la escritura en BD reutilizable y el route genérico `/api/webhooks/[channel]`.
 */
import { assignConversation } from "@/lib/chat/assign-conversation-service";
import { ensureCentralChatConversationMirror } from "@/lib/chat/central-chat-conversation-mirror";
import { markFirstHumanOperatorReply } from "@/lib/chat/conversation-sla-markers";
import { maybeRedistributeInitialAssignment } from "@/lib/chat/initial-assignment-redistribution";
import { createWhatsappConversationWithActiveFlow } from "@/lib/chat/whatsapp-conversation-bootstrap";
import { markCampaignReplyFromInbound } from "@/lib/campaigns/campaign-inbound-hook";
import { executeCampaignButtonActionForMatchedRecipient } from "@/lib/campaigns/campaign-button-action-service";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { normalizeWaPhone } from "@/lib/chat/wa-phone";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getSingleClientSchemaOrNull, isSingleClientMode } from "@/lib/instance/single-client";

export const CHAT_CHANNEL_TYPES = ["whatsapp", "instagram", "facebook", "email", "linkedin"] as const;
export type ChatChannelType = (typeof CHAT_CHANNEL_TYPES)[number];

export function isChatChannelType(s: string): s is ChatChannelType {
  return (CHAT_CHANNEL_TYPES as readonly string[]).includes(s);
}

export type SaveIncomingMessageChannel = {
  id: string;
  empresa_id: string;
  type: ChatChannelType;
};

export type SaveIncomingMessageContactData = {
  /** Identificador estable del contacto en el canal (tel normalizado, email, id social, etc.) */
  address: string;
  display_name?: string | null;
};

export type SaveIncomingMessageMessageData = {
  message_type: string;
  content: string | null;
  raw_payload: Record<string, unknown>;
  created_at?: string;
  from_me?: boolean;
  sender_type?: "contact" | "ai" | "human" | "system";
};

export type SaveIncomingMessageParams = {
  supabase: SupabaseAdmin;
  channel: SaveIncomingMessageChannel;
  /** ID del mensaje en el proveedor (p. ej. wa_message_id de Meta). */
  external_id: string;
  contact_data: SaveIncomingMessageContactData;
  message_data: SaveIncomingMessageMessageData;
  /**
   * Tras asegurar conversación y antes de insertar el mensaje (p. ej. reinicios / handoff WhatsApp).
   * Si actualiza `chat_conversations`, el paso final de `saveIncomingMessage` relee la fila.
   */
  adjustConversationBeforePersist?: (ctx: {
    supabase: SupabaseAdmin;
    empresaId: string;
    channelId: string;
    conversationId: string;
    contactId: string;
  }) => Promise<void>;
};

export type SaveIncomingMessageResult =
  | { ok: true; skipped_duplicate: true }
  | {
      ok: true;
      skipped_duplicate: false;
      conversation_id: string;
      contact_id: string;
      message_id: string;
    }
  | { ok: false; error: string };

type ConversationRowLite = {
  id: string;
  status: string;
  unread_count: number;
  flow_code: string | null;
  flow_current_node: string | null;
  flow_status: string;
  human_taken_over: boolean;
  active_flow_session_id?: string | null;
};

function normalizeContactAddress(type: ChatChannelType, address: string): string {
  const t = address.trim();
  if (!t) return "";
  if (type === "whatsapp") return normalizeWaPhone(t);
  if (type === "email") return t.toLowerCase();
  return t;
}

export type PersistInboundChatMessageInput = {
  supabase: SupabaseAdmin;
  empresaId: string;
  conversationId: string;
  externalMessageId: string;
  messageType: string;
  content: string | null;
  rawPayload: Record<string, unknown>;
  timestampIso: string;
  preview: string;
  fromMe?: boolean;
  senderType?: string;
  /** Estado de conversación a persistir junto con el bump del último mensaje. */
  conversationState: {
    flow_code?: string | null;
    flow_current_node?: string | null;
    flow_status?: string;
    human_taken_over?: boolean;
    unread_count: number;
    status?: string;
  };
};

export type PersistInboundChatMessageResult =
  | { ok: true; message_id: string }
  | { ok: false; error: string; duplicate?: boolean };

/** Input para el persist temprano e idempotente del inbound (single_client). */
export type PersistInboundEarlyInput = {
  empresaId: string;
  conversationId: string;
  externalMessageId: string;
  messageType: string;
  content: string | null;
  rawPayload: Record<string, unknown>;
  timestampIso: string;
  preview: string;
  /** unread_count actual de la conversación, antes del bump. */
  unreadCount: number;
};

export type PersistInboundEarlyResult =
  | { ok: true; message_id: string; duplicate: false }
  | { ok: true; message_id: string | null; duplicate: true }
  | { ok: false; error: string };

/**
 * Persistencia "temprana" e idempotente del inbound vía PG directo (single_client).
 *
 * El handler webhook tiene un try/catch externo que captura excepciones a `errors[]`
 * entre `restart-intent` y el `persistInboundChatMessageAndBump` regular. Si algún
 * paso intermedio (ensure_session, CRM lead, assign, etc.) tira excepción, el persist
 * "regular" nunca se ejecuta y el inbound queda sin registrar en chat_messages.
 *
 * Esta función se invoca **antes** del restart-intent y guarda el inbound +
 * actualiza el bump de conversación de forma atómica y resistente a:
 *  - reintentos de Meta (UNIQUE wa_message_id → `ON CONFLICT DO NOTHING`)
 *  - excepciones del flujo posterior
 *  - RLS PostgREST (bypass total con pg.Pool)
 *
 * Retorna `null` si el pool/schema no están disponibles (caller decide qué hacer).
 *
 * Convención de inbound:
 *  - `from_me=false`, `sender_type='contact'`
 *  - El bump de `unread_count` solo se aplica cuando NO es duplicate, para no
 *    incrementar dos veces ante reintentos de Meta.
 */
export async function persistInboundEarlyViaPg(
  input: PersistInboundEarlyInput
): Promise<PersistInboundEarlyResult | null> {
  const pool = getChatPostgresPool();
  const schema = getSingleClientSchemaOrNull();
  if (!pool || !schema) return null;

  const msgT = quoteSchemaTable(schema, "chat_messages");
  const convT = quoteSchemaTable(schema, "chat_conversations");
  const rawJson = JSON.stringify(input.rawPayload ?? {});

  let messageId: string | null = null;
  let isDuplicate = false;

  try {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO ${msgT} (
         empresa_id, conversation_id, wa_message_id, from_me,
         sender_type, message_type, content, raw_payload
       ) VALUES (
         $1::uuid, $2::uuid, $3, false, 'contact', $4, $5, $6::jsonb
       )
       ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
       RETURNING id::text AS id`,
      [
        input.empresaId,
        input.conversationId,
        input.externalMessageId,
        input.messageType,
        input.content,
        rawJson,
      ]
    );
    if (ins.rowCount && ins.rowCount > 0 && ins.rows?.[0]?.id) {
      messageId = ins.rows[0].id;
    } else {
      isDuplicate = true;
      const exQ = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM ${msgT} WHERE wa_message_id=$1 LIMIT 1`,
        [input.externalMessageId]
      );
      messageId = exQ.rows?.[0]?.id ?? null;
    }
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: err?.message ?? String(e) };
  }

  if (!isDuplicate) {
    try {
      await pool.query(
        `UPDATE ${convT} SET
           last_message_at = $1::timestamptz,
           last_message_preview = $2,
           unread_count = $3,
           status = CASE WHEN status='closed' THEN 'pending' ELSE status END,
           updated_at = now()
         WHERE id=$4::uuid AND empresa_id=$5::uuid`,
        [
          input.timestampIso,
          input.preview,
          input.unreadCount + 1,
          input.conversationId,
          input.empresaId,
        ]
      );
    } catch (e) {
      // El INSERT del mensaje ya está hecho — log warn y seguir.
      console.warn("[webhook][early-inbound-persist][bump-failed]", {
        conversationId: input.conversationId,
        err: (e as { message?: string }).message,
      });
    }

    // Etiquetas FASE 3A: si la conversación estaba oculta por una etiqueta,
    // el inbound del cliente la reactiva (limpia hidden_by_tag + history).
    // Idempotente y no-op si no aplica. Nunca falla el persist por esto.
    try {
      const { reactivateHiddenConversationIfNeeded } = await import(
        "@/lib/chat/tags/reactivate-hidden-conversation"
      );
      const rRes = await reactivateHiddenConversationIfNeeded({
        pool,
        schema,
        empresaId: input.empresaId,
        conversationId: input.conversationId,
        inboundMessageId: messageId,
        source: "client_replied",
      });
      if (rRes.reactivated) {
        console.info("[webhook][early-inbound-persist][tag-reactivated]", {
          conversationId: input.conversationId,
          previous_tag_id: rRes.previous_tag_id,
        });
      }
    } catch (e) {
      console.warn("[webhook][early-inbound-persist][tag-reactivate-failed]", {
        conversationId: input.conversationId,
        err: (e as { message?: string }).message,
      });
    }
  }

  return isDuplicate
    ? { ok: true, message_id: messageId, duplicate: true }
    : { ok: true, message_id: messageId as string, duplicate: false };
}

/**
 * Inserta fila en `chat_messages` y actualiza preview / unread / estado de flujo en `chat_conversations`.
 * Usado por el webhook WhatsApp tras toda la lógica de flujo (reinicios, handoff, etc.).
 *
 * En single_client el INSERT vía PostgREST falla silenciosamente por RLS
 * (`chat_messages_insert WITH CHECK puede_acceder_empresa(empresa_id)` retorna false
 * sin JWT de usuario). Forzamos rama PG directa contra `NEURA_CLIENT_SCHEMA` usando
 * el mismo pool que ya usan los outbounds del flow-engine — bypass total de
 * PostgREST/RLS, mismo path probado y operativo.
 *
 * En multi_tenant legacy se mantiene el path Supabase REST original.
 */
export async function persistInboundChatMessageAndBump(
  input: PersistInboundChatMessageInput
): Promise<PersistInboundChatMessageResult> {
  // Rama single_client → PG directo, evita RLS PostgREST.
  if (isSingleClientMode()) {
    const pgResult = await persistInboundViaPg(input);
    if (pgResult) return pgResult;
    // Si pool o schema no resuelven, caemos al path Supabase REST como último recurso.
  }

  const {
    supabase,
    empresaId,
    conversationId,
    externalMessageId,
    messageType,
    content,
    rawPayload,
    timestampIso,
    preview,
    fromMe = false,
    senderType = "contact",
    conversationState,
  } = input;

  const { data: insertedMsg, error: insErr } = await supabase
    .from("chat_messages")
    .insert({
      empresa_id: empresaId,
      conversation_id: conversationId,
      wa_message_id: externalMessageId,
      from_me: fromMe,
      sender_type: senderType,
      message_type: messageType,
      content,
      raw_payload: rawPayload,
    })
    .select("id")
    .single();

  if (insErr) {
    if (insErr.code === "23505") {
      return { ok: false, error: insErr.message, duplicate: true };
    }
    return { ok: false, error: insErr.message };
  }

  const messageId = (insertedMsg as { id?: string } | null)?.id;
  if (!messageId) return { ok: false, error: "Insert mensaje sin id" };

  const prevStatus = conversationState.status ?? "open";
  const nextStatus = prevStatus === "closed" ? "pending" : prevStatus;

  const bumpUnread =
    !fromMe && String(senderType || "contact").toLowerCase() === "contact";

  const { data: prevConv } = await supabase
    .from("chat_conversations")
    .select("flow_code, flow_current_node")
    .eq("id", conversationId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  let nextFlowCode = conversationState.flow_code ?? null;
  let nextFlowNode = conversationState.flow_current_node ?? null;
  const prevRow = prevConv as { flow_code?: string | null; flow_current_node?: string | null } | null;
  if (
    nextFlowCode === null &&
    typeof prevRow?.flow_code === "string" &&
    prevRow.flow_code.trim() !== "" &&
    !(conversationState.human_taken_over ?? false) &&
    String(conversationState.flow_status ?? "bot").trim() !== "human"
  ) {
    nextFlowCode = prevRow.flow_code;
    console.warn("[bot-routing]", "persist_guard_kept_flow_code_from_db", { conversationId });
  }
  if (
    nextFlowNode === null &&
    typeof prevRow?.flow_current_node === "string" &&
    prevRow.flow_current_node.trim() !== "" &&
    !(conversationState.human_taken_over ?? false) &&
    String(conversationState.flow_status ?? "bot").trim() !== "human"
  ) {
    nextFlowNode = prevRow.flow_current_node;
    console.warn("[bot-routing]", "persist_guard_kept_flow_node_from_db", { conversationId });
  }

  await supabase
    .from("chat_conversations")
    .update({
      flow_code: nextFlowCode,
      flow_current_node: nextFlowNode,
      flow_status: conversationState.flow_status ?? "bot",
      human_taken_over: conversationState.human_taken_over ?? false,
      last_message_at: timestampIso,
      last_message_preview: preview,
      unread_count: conversationState.unread_count + (bumpUnread ? 1 : 0),
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("empresa_id", empresaId);

  await markFirstHumanOperatorReply(supabase, empresaId, conversationId, {
    from_me: fromMe,
    sender_type: senderType,
  });

  return { ok: true, message_id: messageId };
}

/**
 * Persistencia inbound vía PG directo (single_client) — bypass total de PostgREST/RLS.
 * Retorna `null` si pool/schema no resuelven (caller cae al path Supabase REST legacy).
 *
 * Replica el mismo INSERT + persist_guard + UPDATE chat_conversations + markFirstHumanOperatorReply
 * pero con SQL parametrizado vía pg.Pool. Maneja unique violation (23505) idénticamente al path REST.
 */
async function persistInboundViaPg(
  input: PersistInboundChatMessageInput
): Promise<PersistInboundChatMessageResult | null> {
  const pool = getChatPostgresPool();
  const schema = getSingleClientSchemaOrNull();
  if (!pool || !schema) return null;

  const {
    supabase,
    empresaId,
    conversationId,
    externalMessageId,
    messageType,
    content,
    rawPayload,
    timestampIso,
    preview,
    fromMe = false,
    senderType = "contact",
    conversationState,
  } = input;

  const msgT = quoteSchemaTable(schema, "chat_messages");
  const convT = quoteSchemaTable(schema, "chat_conversations");
  const rawJson = JSON.stringify(rawPayload ?? {});

  // INSERT inbound
  let messageId: string;
  try {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO ${msgT} (
         empresa_id, conversation_id, wa_message_id, from_me,
         sender_type, message_type, content, raw_payload
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb
       )
       RETURNING id::text AS id`,
      [empresaId, conversationId, externalMessageId, fromMe, senderType, messageType, content, rawJson]
    );
    const row = ins.rows?.[0];
    if (!row?.id) {
      return { ok: false, error: "Insert mensaje sin id (pg)" };
    }
    messageId = row.id;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err?.code === "23505") {
      return { ok: false, error: err.message ?? "duplicate", duplicate: true };
    }
    console.error("[persistInboundViaPg] insert chat_messages failed", {
      code: err?.code,
      message: err?.message,
      conversationId,
      wa_mid: externalMessageId,
    });
    return { ok: false, error: err?.message ?? String(e) };
  }

  // SELECT prev conv (guard de flow_code / flow_current_node)
  const prevRowQ = await pool.query<{
    flow_code: string | null;
    flow_current_node: string | null;
  }>(
    `SELECT flow_code, flow_current_node
       FROM ${convT}
      WHERE id=$1::uuid AND empresa_id=$2::uuid
      LIMIT 1`,
    [conversationId, empresaId]
  );
  const prevRow = prevRowQ.rows?.[0] ?? null;

  let nextFlowCode: string | null = conversationState.flow_code ?? null;
  let nextFlowNode: string | null = conversationState.flow_current_node ?? null;
  const flowStatus = conversationState.flow_status ?? "bot";
  const humanTaken = conversationState.human_taken_over ?? false;
  if (
    nextFlowCode === null &&
    typeof prevRow?.flow_code === "string" &&
    prevRow.flow_code.trim() !== "" &&
    !humanTaken &&
    String(flowStatus).trim() !== "human"
  ) {
    nextFlowCode = prevRow.flow_code;
    console.warn("[bot-routing]", "persist_guard_kept_flow_code_from_db", { conversationId });
  }
  if (
    nextFlowNode === null &&
    typeof prevRow?.flow_current_node === "string" &&
    prevRow.flow_current_node.trim() !== "" &&
    !humanTaken &&
    String(flowStatus).trim() !== "human"
  ) {
    nextFlowNode = prevRow.flow_current_node;
    console.warn("[bot-routing]", "persist_guard_kept_flow_node_from_db", { conversationId });
  }

  const prevStatus = conversationState.status ?? "open";
  const nextStatus = prevStatus === "closed" ? "pending" : prevStatus;
  const bumpUnread =
    !fromMe && String(senderType || "contact").toLowerCase() === "contact";

  // UPDATE conversation bump (preview, last_message_at, unread, flow_*)
  try {
    await pool.query(
      `UPDATE ${convT} SET
         flow_code = $1,
         flow_current_node = $2,
         flow_status = $3,
         human_taken_over = $4,
         last_message_at = $5::timestamptz,
         last_message_preview = $6,
         unread_count = $7,
         status = $8,
         updated_at = now()
       WHERE id=$9::uuid AND empresa_id=$10::uuid`,
      [
        nextFlowCode,
        nextFlowNode,
        flowStatus,
        humanTaken,
        timestampIso,
        preview,
        conversationState.unread_count + (bumpUnread ? 1 : 0),
        nextStatus,
        conversationId,
        empresaId,
      ]
    );
  } catch (e) {
    console.error("[persistInboundViaPg] update chat_conversations failed", {
      message: (e as { message?: string }).message,
      conversationId,
    });
    // El INSERT del mensaje ya está hecho — devolvemos ok para no romper el handler.
  }

  // SLA marker — mantiene comportamiento con cliente REST (no es write crítico)
  await markFirstHumanOperatorReply(supabase, empresaId, conversationId, {
    from_me: fromMe,
    sender_type: senderType,
  });

  return { ok: true, message_id: messageId };
}

/**
 * Punto central omnicanal: contacto + conversación + mensaje entrante.
 * Canales futuros (Meta IG/FB, email) pueden invocar solo esto desde su webhook.
 */
export async function saveIncomingMessage(params: SaveIncomingMessageParams): Promise<SaveIncomingMessageResult> {
  const {
    supabase,
    channel,
    external_id: externalId,
    contact_data,
    message_data,
    adjustConversationBeforePersist,
  } = params;

  const ext = externalId.trim();
  if (!ext) return { ok: false, error: "external_id es obligatorio" };

  const address = normalizeContactAddress(channel.type, contact_data.address);
  if (!address) return { ok: false, error: "contact_data.address inválido" };

  const displayName = contact_data.display_name?.trim() || null;
  const empresaId = channel.empresa_id;
  const channelId = channel.id;

  const upsertPayload: Record<string, unknown> = {
    empresa_id: empresaId,
    phone_number: address,
    phone_normalized: address,
  };
  if (displayName) upsertPayload.name = displayName;

  const { data: contact, error: cErr } = await supabase
    .from("chat_contacts")
    .upsert(upsertPayload, { onConflict: "empresa_id,phone_number" })
    .select("id, name, crm_prospecto_id")
    .single();

  if (cErr || !contact) {
    return { ok: false, error: `Contacto: ${cErr?.message ?? "error"}` };
  }

  const contactId = contact.id as string;
  const existingLooksLikePhone =
    !contact.name ||
    !/\p{L}/u.test(String(contact.name)) ||
    String(contact.name).replace(/\D+/g, "") === address.replace(/\D+/g, "");
  if (displayName && displayName !== contact.name && existingLooksLikePhone) {
    await supabase
      .from("chat_contacts")
      .update({ name: displayName, updated_at: new Date().toISOString() })
      .eq("id", contactId);
  }

  const { data: existingConvRaw } = await supabase
    .from("chat_conversations")
    .select(
      "id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
    )
    .eq("contact_id", contactId)
    .eq("channel_id", channelId)
    .maybeSingle();

  let existingConv: ConversationRowLite | null = existingConvRaw as ConversationRowLite | null;

  if (!existingConv) {
    if (channel.type === "whatsapp") {
      const { conv, error: bootErr } = await createWhatsappConversationWithActiveFlow(
        supabase,
        empresaId,
        channelId,
        contactId
      );
      if (bootErr) return { ok: false, error: bootErr };
      existingConv = conv;
    } else {
      const { data: conv, error: convErr } = await supabase
        .from("chat_conversations")
        .insert({
          empresa_id: empresaId,
          channel_id: channelId,
          contact_id: contactId,
          status: "open",
          flow_code: null,
          flow_current_node: null,
          flow_status: "human",
          human_taken_over: true,
          last_message_at: null,
          last_message_preview: null,
          unread_count: 0,
        })
        .select(
          "id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
        )
        .single();

      if (convErr?.code === "23505") {
        const { data: again } = await supabase
          .from("chat_conversations")
          .select(
            "id, status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over, active_flow_session_id"
          )
          .eq("contact_id", contactId)
          .eq("channel_id", channelId)
          .maybeSingle();
        existingConv = again as ConversationRowLite | null;
      } else if (convErr) {
        return { ok: false, error: `Conversación: ${convErr.message}` };
      } else {
        existingConv = conv as ConversationRowLite;
        if (existingConv?.id) {
          const ar = await assignConversation(supabase, existingConv.id);
          if (!ar.ok) {
            console.warn("[saveIncomingMessage] assignConversation", ar.error);
          }
        }
      }
    }
  }

  if (!existingConv?.id) {
    return { ok: false, error: "No se pudo resolver conversación" };
  }

  const conversationId = existingConv.id as string;

  const tenantDsForMirror = await fetchDataSchemaForEmpresaId(empresaId);
  await ensureCentralChatConversationMirror({
    pool: getChatPostgresPool(),
    tenantDataSchema: tenantDsForMirror,
    empresaId,
    conversationId,
  });

  const isContactInbound =
    message_data.from_me !== true && (message_data.sender_type ?? "contact") === "contact";
  if (isContactInbound) {
    const rd = await maybeRedistributeInitialAssignment(supabase, conversationId);
    if (rd.changed) {
      /* conversación posiblemente reasignada; el assign siguiente es idempotente si ya hay agente */
    }
    const ar = await assignConversation(supabase, conversationId);
    if (!ar.ok) {
      console.warn("[saveIncomingMessage] assignConversation (inbound)", ar.error);
    }
  }

  await adjustConversationBeforePersist?.({
    supabase,
    empresaId,
    channelId,
    conversationId,
    contactId,
  });

  const { data: convRow } = await supabase
    .from("chat_conversations")
    .select(
      "status, unread_count, flow_code, flow_current_node, flow_status, human_taken_over"
    )
    .eq("id", conversationId)
    .eq("empresa_id", empresaId)
    .maybeSingle();

  const row = convRow ?? existingConv;
  const ts =
    message_data.created_at?.trim() || new Date().toISOString();
  const preview = (message_data.content ?? "").slice(0, 280);
  const fromMe = message_data.from_me === true;
  const senderType = message_data.sender_type ?? (fromMe ? "human" : "contact");

  const persist = await persistInboundChatMessageAndBump({
    supabase,
    empresaId,
    conversationId,
    externalMessageId: ext,
    messageType: message_data.message_type,
    content: message_data.content,
    rawPayload: message_data.raw_payload,
    timestampIso: ts,
    preview,
    fromMe,
    senderType,
    conversationState: {
      flow_code: row.flow_code as string | null | undefined,
      flow_current_node: row.flow_current_node as string | null | undefined,
      flow_status: (row.flow_status as string) ?? "bot",
      human_taken_over: Boolean(row.human_taken_over),
      unread_count: (row.unread_count as number) ?? 0,
      status: row.status as string | undefined,
    },
  });

  let persistedMessageId: string | null = null;
  if (persist.ok) {
    persistedMessageId = persist.message_id;
  } else if (persist.duplicate) {
    const { data: exRow } = await supabase
      .from("chat_messages")
      .select("id")
      .eq("wa_message_id", ext)
      .maybeSingle();
    persistedMessageId = (exRow as { id?: string } | null)?.id ?? null;
    if (!persistedMessageId) {
      return { ok: true, skipped_duplicate: true };
    }
  } else {
    return { ok: false, error: persist.error };
  }

  let campaignReplyMatch: Awaited<ReturnType<typeof markCampaignReplyFromInbound>> = {
    matched: false,
  };
  if (isContactInbound && channel.type === "whatsapp") {
    try {
      campaignReplyMatch = await markCampaignReplyFromInbound({
        supabase,
        empresaId,
        channelId: channel.id,
        contactId,
        inboundAtIso: ts,
        preview,
        waMessageId: ext,
      });
    } catch (e) {
      console.warn("[saveIncomingMessage] markCampaignReplyFromInbound", e);
    }

    const raw = message_data.raw_payload;
    const rawOk = raw && typeof raw === "object" && !Array.isArray(raw);
    const rawRec = rawOk ? (raw as Record<string, unknown>) : null;
    const hasInteractiveBtn =
      (raw as { interactive?: { button_reply?: unknown } })?.interactive?.button_reply != null;
    const hasMetaButton =
      String(rawRec?.type ?? "").toLowerCase() === "button" &&
      (raw as { button?: unknown }).button != null;
    const hasButtonReply = rawOk && (hasInteractiveBtn || hasMetaButton);
    if (
      campaignReplyMatch.matched &&
      (hasButtonReply || message_data.message_type === "text")
    ) {
      const reply = campaignReplyMatch;
      try {
        await executeCampaignButtonActionForMatchedRecipient({
          supabase,
          empresaId,
          channelId: channel.id,
          conversationId,
          contactId,
          campaignId: reply.campaignId,
          recipientId: reply.recipientId,
          inboundAtIso: ts,
          waMessageId: ext,
          rawPayload: (rawOk ? raw : {}) as Record<string, unknown>,
        });
      } catch (e) {
        console.warn("[saveIncomingMessage] executeCampaignButtonActionForMatchedRecipient", e);
      }
    }
  }

  return {
    ok: true,
    skipped_duplicate: false,
    conversation_id: conversationId,
    contact_id: contactId,
    message_id: persistedMessageId,
  };
}
