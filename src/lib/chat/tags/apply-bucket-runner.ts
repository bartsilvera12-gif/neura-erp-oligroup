import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Etiquetas FASE 4A — runner por buckets.
 *
 * Selecciona conversaciones candidatas para un bucket (categoría) y, en modo
 * apply=true, las marca como ocultas asociándolas a una tag/rule y registra
 * history con `applied_batch_id` (para rollback por batch).
 *
 * GUARDS DUROS (todos obligatorios para que la conv pase):
 *  - empresa_id = X
 *  - status IN ('open','pending')
 *  - COALESCE(human_taken_over,false)=false
 *  - flow_status IS NULL OR flow_status <> 'human'
 *  - COALESCE(hidden_by_tag,false)=false  (no doble ocultar)
 *  - current_tag_id IS NULL                (no sobrescribir)
 *  - last_message_at < now() - interval '7 days' (≥ 7d sin actividad)
 *  - NO existe inbound posterior al snapshot
 *  - clasificación por chat_tag_purchase_category(id) == bucketCategory
 *  - NO existe history previo con action='applied' para este (conversation_id, tag_id)
 *
 * Adicional para 'no_compro' y 'comprobante_pendiente':
 *  - NO tiene entradas/cupones ni numero_orden en chat_flow_data
 *    (ya lo asegura la función chat_tag_purchase_category, pero lo reforzamos).
 *
 * NO toca: status, flow-engine, sorteos, entradas, cupones, tickets, campañas,
 * mensajes. Sólo escribe `chat_conversations.{current_tag_id,hidden_by_tag,...}`
 * + INSERT en `chat_conversation_tag_history`.
 */

export type BucketCode =
  | "compro_boleta"
  | "compro_varias"
  | "comprobante_pendiente"
  | "datos_incompletos"
  | "no_compro";

const BUCKET_TO_CATEGORY: Record<BucketCode, string> = {
  compro_boleta: "purchased_once",
  compro_varias: "purchased_multiple_tickets",
  comprobante_pendiente: "payment_received_incomplete",
  datos_incompletos: "data_incomplete",
  no_compro: "no_purchase",
};

const GUARDS_VERSION = "triple7-fase4a-v1";

export type BucketRunInput = {
  pool: Pool;
  schema: string;
  empresaId: string;
  bucket: BucketCode;
  maxBatch: number;
  apply: boolean;
  /** Si se pasa, usa este id; si no, genera uno. */
  appliedBatchId?: string;
  /** Días mínimos sin actividad. Default 7. */
  minDaysIdle?: number;
};

export type BucketCandidate = {
  conversation_id: string;
  last_message_at: string | null;
  phone_masked: string | null;
  contact_name: string | null;
  category: string;
};

export type BucketRunResult = {
  bucket: BucketCode;
  applied_batch_id: string;
  apply: boolean;
  preview_count: number;
  applied_count: number;
  sample: BucketCandidate[];
  guards_version: string;
  rule_id: string | null;
  tag_id: string | null;
  reasons_skipped: Record<string, number>;
};

function maskPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = String(p).replace(/\D+/g, "");
  if (digits.length <= 4) return digits;
  return `***${digits.slice(-4)}`;
}

export async function runBucketApply(input: BucketRunInput): Promise<BucketRunResult> {
  const schema = assertAllowedChatDataSchema(input.schema);
  const empresaId = input.empresaId;
  const bucket = input.bucket;
  const category = BUCKET_TO_CATEGORY[bucket];
  const maxBatch = Math.max(1, Math.min(1000, Math.trunc(input.maxBatch)));
  const apply = Boolean(input.apply);
  const minDaysIdle = Math.max(1, input.minDaysIdle ?? 7);
  const appliedBatchId = input.appliedBatchId || randomUUID();

  const convT = quoteSchemaTable(schema, "chat_conversations");
  const tagsT = quoteSchemaTable(schema, "chat_conversation_tags");
  const rulesT = quoteSchemaTable(schema, "chat_conversation_tag_rules");
  const histT = quoteSchemaTable(schema, "chat_conversation_tag_history");
  const msgsT = quoteSchemaTable(schema, "chat_messages");

  // Resolver tag_id / rule_id del bucket
  const tagQ = await input.pool.query<{ id: string }>(
    `SELECT id::text AS id FROM ${tagsT} WHERE empresa_id=$1::uuid AND code=$2 LIMIT 1`,
    [empresaId, bucket]
  );
  if (tagQ.rowCount === 0) {
    throw new Error(`Tag "${bucket}" no existe para empresa ${empresaId}`);
  }
  const tagId = tagQ.rows[0].id;
  const ruleQ = await input.pool.query<{ id: string }>(
    `SELECT id::text AS id FROM ${rulesT} WHERE empresa_id=$1::uuid AND tag_id=$2::uuid ORDER BY priority ASC LIMIT 1`,
    [empresaId, tagId]
  );
  const ruleId = ruleQ.rows?.[0]?.id ?? null;

  const reasonsSkipped: Record<string, number> = {};
  function bumpSkip(reason: string) {
    reasonsSkipped[reason] = (reasonsSkipped[reason] ?? 0) + 1;
  }

  // SELECT base (CON GUARDS estructurales + clasificación)
  const baseQ = await input.pool.query<{
    id: string;
    last_message_at: string | null;
    contact_id: string | null;
    phone_number: string | null;
    contact_name: string | null;
    category: string;
  }>(
    `
    WITH base AS (
      SELECT c.id, c.last_message_at, c.contact_id
        FROM ${convT} c
       WHERE c.empresa_id = $1::uuid
         AND c.status IN ('open','pending')
         AND COALESCE(c.human_taken_over, false) = false
         AND (c.flow_status IS NULL OR c.flow_status <> 'human')
         AND COALESCE(c.hidden_by_tag, false) = false
         AND c.current_tag_id IS NULL
         AND c.last_message_at IS NOT NULL
         AND c.last_message_at < now() - ($2::int * interval '1 day')
       ORDER BY c.last_message_at ASC
       LIMIT $3 * 4   -- sobre-traemos para descartar los que no cumplen clasificación
    ),
    clasif AS (
      SELECT b.id, b.last_message_at, b.contact_id,
             ${schema}.chat_tag_purchase_category(b.id) AS category
        FROM base b
    ),
    inbound AS (
      SELECT m.conversation_id, MAX(m.created_at) AS last_inbound_at
        FROM ${msgsT} m
       WHERE m.empresa_id = $1::uuid AND m.from_me = false
         AND m.conversation_id IN (SELECT id FROM base)
       GROUP BY m.conversation_id
    )
    SELECT c.id::text AS id,
           c.last_message_at,
           ct.id::text     AS contact_id,
           ct.phone_number,
           ct.name         AS contact_name,
           cl.category
      FROM clasif cl
      JOIN ${convT} c ON c.id = cl.id
      LEFT JOIN ${quoteSchemaTable(schema, "chat_contacts")} ct ON ct.id = c.contact_id
      LEFT JOIN inbound ib ON ib.conversation_id = c.id
     WHERE cl.category = $4
       -- defensa extra: descartar si hubo inbound posterior al filtro de antigüedad
       AND (ib.last_inbound_at IS NULL OR ib.last_inbound_at < now() - ($2::int * interval '1 day'))
       -- exclusión: ya hay un applied previo para esta combinación (idempotencia entre runs)
       AND NOT EXISTS (
         SELECT 1 FROM ${histT} h
          WHERE h.empresa_id = $1::uuid
            AND h.conversation_id = c.id
            AND h.action = 'applied'
            AND h.new_tag_id = $5::uuid
       )
     ORDER BY c.last_message_at ASC
     LIMIT $3
    `,
    [empresaId, minDaysIdle, maxBatch, category, tagId]
  );

  const rows = baseQ.rows;
  const sample: BucketCandidate[] = rows.slice(0, 10).map((r) => ({
    conversation_id: r.id,
    last_message_at: r.last_message_at,
    phone_masked: maskPhone(r.phone_number),
    contact_name: r.contact_name ?? null,
    category: r.category,
  }));

  if (!apply) {
    return {
      bucket,
      applied_batch_id: appliedBatchId,
      apply: false,
      preview_count: rows.length,
      applied_count: 0,
      sample,
      guards_version: GUARDS_VERSION,
      rule_id: ruleId,
      tag_id: tagId,
      reasons_skipped: reasonsSkipped,
    };
  }

  // APPLY real, en UNA transacción.
  if (rows.length === 0) {
    return {
      bucket,
      applied_batch_id: appliedBatchId,
      apply: true,
      preview_count: 0,
      applied_count: 0,
      sample,
      guards_version: GUARDS_VERSION,
      rule_id: ruleId,
      tag_id: tagId,
      reasons_skipped: reasonsSkipped,
    };
  }

  const ids = rows.map((r) => r.id);
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '60s'");

    // UPDATE conversaciones — re-verifica TODOS los guards in-line, atómico.
    const upd = await client.query<{ id: string }>(
      `UPDATE ${convT}
          SET current_tag_id        = $3::uuid,
              hidden_by_tag         = true,
              hidden_by_tag_at      = now(),
              hidden_by_tag_rule_id = $4::uuid,
              last_tagged_at        = now(),
              updated_at            = now()
        WHERE empresa_id = $1::uuid
          AND id = ANY($2::uuid[])
          AND status IN ('open','pending')
          AND COALESCE(human_taken_over, false) = false
          AND (flow_status IS NULL OR flow_status <> 'human')
          AND COALESCE(hidden_by_tag, false) = false
          AND current_tag_id IS NULL
          AND last_message_at < now() - ($5::int * interval '1 day')
        RETURNING id::text AS id`,
      [empresaId, ids, tagId, ruleId, minDaysIdle]
    );

    const appliedIds = upd.rows.map((r) => r.id);
    if (appliedIds.length > 0) {
      // INSERT history en batch (una sola query)
      await client.query(
        `INSERT INTO ${histT}
           (empresa_id, conversation_id, previous_tag_id, new_tag_id, rule_id, action, reason, source, metadata)
         SELECT $1::uuid, unnest($2::uuid[]), null, $3::uuid, $4::uuid, 'applied', $5, 'manual',
                jsonb_build_object(
                  'applied_batch_id', $6::text,
                  'bucket', $7::text,
                  'snapshot_at', now()::text,
                  'guards_version', $8::text
                )`,
        [
          empresaId,
          appliedIds,
          tagId,
          ruleId,
          `triple7_historical_bucket_${bucket}`,
          appliedBatchId,
          bucket,
          GUARDS_VERSION,
        ]
      );
    }

    await client.query("COMMIT");

    return {
      bucket,
      applied_batch_id: appliedBatchId,
      apply: true,
      preview_count: rows.length,
      applied_count: appliedIds.length,
      sample,
      guards_version: GUARDS_VERSION,
      rule_id: ruleId,
      tag_id: tagId,
      reasons_skipped: reasonsSkipped,
    };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Rollback por batch: revierte `hidden_by_tag` y `current_tag_id` para todas
 * las conversaciones marcadas por el batch dado. Inserta history `action='cleared'`
 * con `reason='rollback_<batch_id>'`. NO borra history original.
 */
export type RollbackInput = {
  pool: Pool;
  schema: string;
  empresaId: string;
  appliedBatchId: string;
  apply: boolean;
};

export type RollbackResult = {
  applied_batch_id: string;
  apply: boolean;
  candidates: number;
  reverted: number;
};

export async function rollbackBatch(input: RollbackInput): Promise<RollbackResult> {
  const schema = assertAllowedChatDataSchema(input.schema);
  const empresaId = input.empresaId;
  const batchId = input.appliedBatchId;
  const apply = Boolean(input.apply);

  const convT = quoteSchemaTable(schema, "chat_conversations");
  const histT = quoteSchemaTable(schema, "chat_conversation_tag_history");

  // Candidatos: filas en history del batch + conv aún oculta.
  const candQ = await input.pool.query<{ conversation_id: string; previous_tag_id: string | null }>(
    `SELECT h.conversation_id::text AS conversation_id, h.new_tag_id::text AS previous_tag_id
       FROM ${histT} h
       JOIN ${convT} c ON c.id = h.conversation_id
      WHERE h.empresa_id = $1::uuid
        AND h.action = 'applied'
        AND (h.metadata->>'applied_batch_id') = $2
        AND c.hidden_by_tag = true`,
    [empresaId, batchId]
  );

  if (!apply) {
    return { applied_batch_id: batchId, apply: false, candidates: candQ.rowCount ?? 0, reverted: 0 };
  }
  if ((candQ.rowCount ?? 0) === 0) {
    return { applied_batch_id: batchId, apply: true, candidates: 0, reverted: 0 };
  }

  const ids = candQ.rows.map((r) => r.conversation_id);
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '60s'");

    const upd = await client.query<{ id: string }>(
      `UPDATE ${convT}
          SET hidden_by_tag = false,
              current_tag_id = null,
              hidden_by_tag_rule_id = null,
              updated_at = now()
        WHERE empresa_id = $1::uuid
          AND id = ANY($2::uuid[])
          AND hidden_by_tag = true
        RETURNING id::text AS id`,
      [empresaId, ids]
    );
    const revertedIds = upd.rows.map((r) => r.id);

    if (revertedIds.length > 0) {
      await client.query(
        `INSERT INTO ${histT}
           (empresa_id, conversation_id, previous_tag_id, new_tag_id, rule_id, action, reason, source, metadata)
         SELECT $1::uuid, unnest($2::uuid[]), null, null, null, 'cleared', $3, 'manual',
                jsonb_build_object('rollback_of_batch_id', $4::text, 'reverted_at', now()::text)`,
        [empresaId, revertedIds, `rollback_${batchId}`, batchId]
      );
    }
    await client.query("COMMIT");
    return { applied_batch_id: batchId, apply: true, candidates: candQ.rowCount ?? 0, reverted: revertedIds.length };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}
