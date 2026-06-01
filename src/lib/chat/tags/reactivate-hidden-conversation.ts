import type { Pool } from "pg";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { schemaHasHiddenByTagColumn } from "@/lib/chat/tags/schema-has-hidden-column";

/**
 * Etiquetas — FASE 3A: reactivación inbound.
 *
 * Cuando llega un mensaje inbound de un cliente sobre una conversación
 * que estaba oculta por una etiqueta (`hidden_by_tag=true`), esta función:
 *   1. Limpia hidden_by_tag, current_tag_id y hidden_by_tag_rule_id
 *   2. Setea tag_reactivated_at = now()
 *   3. Inserta una fila en chat_conversation_tag_history con
 *        action='cleared', source='client_replied'
 *
 * Todo en UNA transacción. Idempotente: si la conversación no está oculta
 * no hace nada. No envía WhatsApp, no cambia status, no toca flow-engine.
 *
 * Si el schema todavía no tiene la columna hidden_by_tag (otros tenants),
 * la función no falla: devuelve `{ reactivated: false, reason: 'no_column' }`.
 *
 * @returns { reactivated, previous_tag_id?, error? }
 */
export type ReactivateInboundResult =
  | { reactivated: true; previous_tag_id: string | null }
  | { reactivated: false; reason: "not_hidden" | "no_column" | "not_found" | "error"; error?: string };


export async function reactivateHiddenConversationIfNeeded(input: {
  pool: Pool;
  schema: string;
  empresaId: string;
  conversationId: string;
  inboundMessageId?: string | null;
  /** Origen humano-legible para metadata. */
  source?: "client_replied" | "manual" | "auto_rule" | "dry_run";
}): Promise<ReactivateInboundResult> {
  const { pool, empresaId, conversationId } = input;
  const source = input.source ?? "client_replied";
  let schema: string;
  try {
    schema = assertAllowedChatDataSchema(input.schema);
  } catch {
    return { reactivated: false, reason: "error", error: "invalid_schema" };
  }

  if (!(await schemaHasHiddenByTagColumn(pool, schema))) {
    return { reactivated: false, reason: "no_column" };
  }

  const convT = quoteSchemaTable(schema, "chat_conversations");
  const histT = quoteSchemaTable(schema, "chat_conversation_tag_history");

  // Todo en una transacción + SELECT ... FOR UPDATE para serializar contra dobles webhooks.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");

    const sel = await client.query<{
      id: string;
      hidden_by_tag: boolean | null;
      current_tag_id: string | null;
      hidden_by_tag_rule_id: string | null;
    }>(
      `SELECT id::text AS id,
              hidden_by_tag,
              current_tag_id::text AS current_tag_id,
              hidden_by_tag_rule_id::text AS hidden_by_tag_rule_id
         FROM ${convT}
        WHERE id=$1::uuid AND empresa_id=$2::uuid
        FOR UPDATE`,
      [conversationId, empresaId]
    );

    if (sel.rowCount === 0) {
      await client.query("ROLLBACK");
      return { reactivated: false, reason: "not_found" };
    }
    const row = sel.rows[0];
    if (row.hidden_by_tag !== true) {
      // No estaba oculta: NOOP — idempotente.
      await client.query("ROLLBACK");
      return { reactivated: false, reason: "not_hidden" };
    }

    const prevTagId = row.current_tag_id;

    await client.query(
      `UPDATE ${convT}
          SET hidden_by_tag = false,
              current_tag_id = null,
              hidden_by_tag_rule_id = null,
              tag_reactivated_at = now(),
              updated_at = now()
        WHERE id=$1::uuid AND empresa_id=$2::uuid`,
      [conversationId, empresaId]
    );

    await client.query(
      `INSERT INTO ${histT}
         (empresa_id, conversation_id, previous_tag_id, new_tag_id, rule_id, action, reason, source, metadata)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, null, $4::uuid, 'cleared', 'client_replied_reactivation', $5,
          jsonb_build_object(
            'conversation_id', $2::text,
            'inbound_message_id', $6::text,
            'previous_hidden_by_tag', true
          ))`,
      [empresaId, conversationId, prevTagId, row.hidden_by_tag_rule_id, source, input.inboundMessageId ?? null]
    );

    await client.query("COMMIT");
    return { reactivated: true, previous_tag_id: prevTagId };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    return { reactivated: false, reason: "error", error: (e as Error).message };
  } finally {
    client.release();
  }
}
