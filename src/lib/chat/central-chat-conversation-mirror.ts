/**
 * Espejo de `chat_conversations` tenant → `zentra_erp.chat_conversations` (mismo `id`).
 * Necesario cuando las FK de `chat_messages.conversation_id` y `chat_flow_sessions.conversation_id`
 * siguen apuntando al catálogo central.
 */
import type { Pool } from "pg";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import { isSingleClientMode } from "@/lib/instance/single-client";

const LOG = "[chat-conversation][central_mirror]" as const;

/** Columnas alineadas entre `zentra_erp` y schemas `erp_*`. */
const CHAT_CONVERSATION_MIRROR_COLUMNS = [
  "id",
  "empresa_id",
  "channel_id",
  "contact_id",
  "status",
  "last_message_at",
  "last_message_preview",
  "unread_count",
  "created_at",
  "updated_at",
  "flow_code",
  "flow_current_node",
  "flow_status",
  "human_taken_over",
  "active_flow_session_id",
  "first_revendedor_id",
  "first_referral_captured_at",
  "assigned_agent_id",
  "queue_id",
  "priority",
  "initial_assignment_at",
  "first_human_response_at",
  "initial_reassign_count",
  "closed_at",
  "closed_by_usuario_id",
  "assignment_wait_code",
] as const;

type MirrorColumns = (typeof CHAT_CONVERSATION_MIRROR_COLUMNS)[number];

function tsIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function uuidOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function intOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function boolOrFalse(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  return false;
}

function textOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** `chat_conversations.priority`: texto CHECK ('low'|'medium'|'high'), NOT NULL en catálogo. */
function priorityOrMedium(v: unknown): string {
  const s = textOrNull(v)?.toLowerCase();
  if (s === "low" || s === "medium" || s === "high") return s;
  return "medium";
}

function buildMirrorPayload(
  raw: Record<string, unknown>,
  relaxedNulls: boolean
): Record<MirrorColumns, unknown> {
  const out = {} as Record<MirrorColumns, unknown>;
  for (const col of CHAT_CONVERSATION_MIRROR_COLUMNS) {
    out[col] = raw[col];
  }
  out.active_flow_session_id = null;
  if (relaxedNulls) {
    out.first_revendedor_id = null;
    out.assigned_agent_id = null;
    out.queue_id = null;
  }
  return out;
}

async function loadTenantConversationRow(opts: {
  pool: Pool | null | undefined;
  tenantSchema: string;
  empresaId: string;
  conversationId: string;
}): Promise<Record<string, unknown> | null> {
  const qt = quoteSchemaTable(opts.tenantSchema, "chat_conversations");
  const sql = `SELECT * FROM ${qt} WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`;

  if (opts.pool) {
    const r = await opts.pool.query(sql, [opts.conversationId, opts.empresaId]);
    const raw = r.rows?.[0] as Record<string, unknown> | undefined;
    return raw ?? null;
  }

  const sb = createServiceRoleClientWithDbSchema(opts.tenantSchema) as SupabaseAdmin;
  const cols = CHAT_CONVERSATION_MIRROR_COLUMNS.join(", ");
  const { data, error } = await sb
    .from("chat_conversations")
    .select(cols)
    .eq("id", opts.conversationId)
    .eq("empresa_id", opts.empresaId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? (data as unknown as Record<string, unknown>) : null;
}

function rowValuesForZentra(payload: Record<MirrorColumns, unknown>): unknown[] {
  const r = payload;
  return [
    uuidOrNull(r.id),
    uuidOrNull(r.empresa_id),
    uuidOrNull(r.channel_id),
    uuidOrNull(r.contact_id),
    String(r.status ?? "open"),
    r.last_message_at,
    textOrNull(r.last_message_preview),
    intOrNull(r.unread_count) ?? 0,
    r.created_at,
    r.updated_at,
    textOrNull(r.flow_code),
    textOrNull(r.flow_current_node),
    String(r.flow_status ?? "bot"),
    boolOrFalse(r.human_taken_over),
    null,
    uuidOrNull(r.first_revendedor_id),
    r.first_referral_captured_at,
    uuidOrNull(r.assigned_agent_id),
    uuidOrNull(r.queue_id),
    priorityOrMedium(r.priority),
    r.initial_assignment_at,
    r.first_human_response_at,
    intOrNull(r.initial_reassign_count) ?? 0,
    r.closed_at,
    uuidOrNull(r.closed_by_usuario_id),
    textOrNull(r.assignment_wait_code),
  ];
}

async function upsertZentraConversationMirror(pool: Pool, payload: Record<MirrorColumns, unknown>): Promise<void> {
  const sql = `
    INSERT INTO zentra_erp.chat_conversations (
      id,
      empresa_id,
      channel_id,
      contact_id,
      status,
      last_message_at,
      last_message_preview,
      unread_count,
      created_at,
      updated_at,
      flow_code,
      flow_current_node,
      flow_status,
      human_taken_over,
      active_flow_session_id,
      first_revendedor_id,
      first_referral_captured_at,
      assigned_agent_id,
      queue_id,
      priority,
      initial_assignment_at,
      first_human_response_at,
      initial_reassign_count,
      closed_at,
      closed_by_usuario_id,
      assignment_wait_code
    )
    VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid,
      $5, $6::timestamptz, $7, $8::int,
      $9::timestamptz, $10::timestamptz,
      $11, $12, $13, $14::boolean,
      $15::uuid, $16::uuid, $17::timestamptz,
      $18::uuid, $19::uuid, $20,
      $21::timestamptz, $22::timestamptz, $23::int,
      $24::timestamptz, $25::uuid,
      $26
    )
    ON CONFLICT (id) DO UPDATE SET
      empresa_id = EXCLUDED.empresa_id,
      channel_id = EXCLUDED.channel_id,
      contact_id = EXCLUDED.contact_id,
      status = EXCLUDED.status,
      last_message_at = EXCLUDED.last_message_at,
      last_message_preview = EXCLUDED.last_message_preview,
      unread_count = EXCLUDED.unread_count,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      flow_code = EXCLUDED.flow_code,
      flow_current_node = EXCLUDED.flow_current_node,
      flow_status = EXCLUDED.flow_status,
      human_taken_over = EXCLUDED.human_taken_over,
      active_flow_session_id = EXCLUDED.active_flow_session_id,
      first_revendedor_id = EXCLUDED.first_revendedor_id,
      first_referral_captured_at = EXCLUDED.first_referral_captured_at,
      assigned_agent_id = EXCLUDED.assigned_agent_id,
      queue_id = EXCLUDED.queue_id,
      priority = EXCLUDED.priority,
      initial_assignment_at = EXCLUDED.initial_assignment_at,
      first_human_response_at = EXCLUDED.first_human_response_at,
      initial_reassign_count = EXCLUDED.initial_reassign_count,
      closed_at = EXCLUDED.closed_at,
      closed_by_usuario_id = EXCLUDED.closed_by_usuario_id,
      assignment_wait_code = EXCLUDED.assignment_wait_code
  `;

  await pool.query(sql, rowValuesForZentra(payload));
}

async function upsertZentraConversationMirrorSupabase(payload: Record<MirrorColumns, unknown>): Promise<void> {
  const r = payload;
  const catalog = createServiceRoleClient();
  const row = {
    id: uuidOrNull(r.id),
    empresa_id: uuidOrNull(r.empresa_id),
    channel_id: uuidOrNull(r.channel_id),
    contact_id: uuidOrNull(r.contact_id),
    status: String(r.status ?? "open"),
    last_message_at: tsIso(r.last_message_at),
    last_message_preview: textOrNull(r.last_message_preview),
    unread_count: intOrNull(r.unread_count) ?? 0,
    created_at: tsIso(r.created_at),
    updated_at: tsIso(r.updated_at),
    flow_code: textOrNull(r.flow_code),
    flow_current_node: textOrNull(r.flow_current_node),
    flow_status: String(r.flow_status ?? "bot"),
    human_taken_over: boolOrFalse(r.human_taken_over),
    active_flow_session_id: null,
    first_revendedor_id: uuidOrNull(r.first_revendedor_id),
    first_referral_captured_at: tsIso(r.first_referral_captured_at),
    assigned_agent_id: uuidOrNull(r.assigned_agent_id),
    queue_id: uuidOrNull(r.queue_id),
    priority: priorityOrMedium(r.priority),
    initial_assignment_at: tsIso(r.initial_assignment_at),
    first_human_response_at: tsIso(r.first_human_response_at),
    initial_reassign_count: intOrNull(r.initial_reassign_count) ?? 0,
    closed_at: tsIso(r.closed_at),
    closed_by_usuario_id: uuidOrNull(r.closed_by_usuario_id),
    assignment_wait_code: textOrNull(r.assignment_wait_code),
  };

  const { error } = await catalog.from("chat_conversations").upsert(row, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

function isFkViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("23503") || msg.toLowerCase().includes("foreign key");
}

/**
 * Garantiza una fila en `zentra_erp.chat_conversations` copiando desde el schema tenant indicado.
 * `active_flow_session_id` no se copia al central (FK hacia `zentra_erp.chat_flow_sessions`).
 */
export async function ensureCentralChatConversationMirror(opts: {
  pool?: Pool | null;
  tenantDataSchema: string;
  empresaId: string;
  conversationId: string;
}): Promise<void> {
  // single_client: mirror central no aplica (sin schema central, INSERT a zentra_erp falla).
  if (isSingleClientMode()) return;

  let tenantSchema: string;
  try {
    tenantSchema = assertAllowedChatDataSchema(opts.tenantDataSchema.trim());
  } catch {
    console.warn(LOG, "skip_invalid_schema");
    return;
  }

  if (!tenantSchema || tenantSchema === SUPABASE_APP_SCHEMA) {
    return;
  }

  try {
    const raw = await loadTenantConversationRow({
      pool: opts.pool ?? null,
      tenantSchema,
      empresaId: opts.empresaId,
      conversationId: opts.conversationId,
    });

    if (!raw?.id) {
      console.warn(LOG, "tenant_conversation_not_found", { conversation_id: opts.conversationId });
      return;
    }

    let relaxed = false;
    let payload = buildMirrorPayload(raw, false);

    const pool = opts.pool ?? null;
    const runUpsert = async () => {
      if (pool) {
        await upsertZentraConversationMirror(pool, payload);
      } else {
        await upsertZentraConversationMirrorSupabase(payload);
      }
    };

    try {
      await runUpsert();
    } catch (e) {
      if (!relaxed && isFkViolation(e)) {
        relaxed = true;
        payload = buildMirrorPayload(raw, true);
        await runUpsert();
      } else {
        throw e;
      }
    }

    const activeTenant = Boolean(uuidOrNull(raw.active_flow_session_id));
    console.info(LOG, "ok", {
      empresa_id: opts.empresaId,
      schema: tenantSchema,
      conversation_id: opts.conversationId,
      channel_id: uuidOrNull(raw.channel_id),
      contact_id: uuidOrNull(raw.contact_id),
      flow_code: textOrNull(raw.flow_code),
      flow_status: String(raw.flow_status ?? ""),
      active_flow_session_id_present_tenant: activeTenant,
    });
  } catch (e) {
    console.warn(LOG, "failed", { message: e instanceof Error ? e.message : String(e) });
  }
}
