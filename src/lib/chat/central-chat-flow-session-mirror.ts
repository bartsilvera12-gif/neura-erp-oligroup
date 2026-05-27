/**
 * Espejo de `chat_flow_sessions` tenant → `zentra_erp.chat_flow_sessions` (mismo `id`).
 * El tenant referencia `sorteo_revendedores` en el schema ERP; en central la FK apunta a
 * `zentra_erp.sorteo_revendedores`, por lo que `revendedor_id` no se copia (NULL en el mirror).
 */
import type { Pool } from "pg";
import type { SupabaseAdmin } from "@/lib/chat/types";
import {
  createServiceRoleClientWithDbSchema,
  fetchDataSchemaForEmpresaId,
} from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import { isSingleClientMode } from "@/lib/instance/single-client";

const LOG = "[chat-flow-session][central_mirror]" as const;

const FLOW_SESSION_MIRROR_COLUMNS = [
  "id",
  "empresa_id",
  "conversation_id",
  "flow_code",
  "status",
  "started_at",
  "ended_at",
  "end_reason",
  "created_at",
  "revendedor_id",
  "codigo_referido_snapshot",
  "referral_source",
] as const;

function uuidOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function tsIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function textOrNull(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

async function loadTenantFlowSessionRow(opts: {
  pool: Pool | null | undefined;
  tenantSchema: string;
  empresaId: string;
  sessionId: string;
}): Promise<Record<string, unknown> | null> {
  const qt = quoteSchemaTable(opts.tenantSchema, "chat_flow_sessions");
  const sql = `SELECT * FROM ${qt} WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`;

  if (opts.pool) {
    const r = await opts.pool.query(sql, [opts.sessionId, opts.empresaId]);
    return (r.rows?.[0] as Record<string, unknown>) ?? null;
  }

  const sb = createServiceRoleClientWithDbSchema(opts.tenantSchema) as SupabaseAdmin;
  const cols = FLOW_SESSION_MIRROR_COLUMNS.join(", ");
  const { data, error } = await sb
    .from("chat_flow_sessions")
    .select(cols)
    .eq("id", opts.sessionId)
    .eq("empresa_id", opts.empresaId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? (data as unknown as Record<string, unknown>) : null;
}

async function upsertZentraFlowSessionMirror(pool: Pool, raw: Record<string, unknown>): Promise<void> {
  const sql = `
    INSERT INTO zentra_erp.chat_flow_sessions (
      id,
      empresa_id,
      conversation_id,
      flow_code,
      status,
      started_at,
      ended_at,
      end_reason,
      created_at,
      revendedor_id,
      codigo_referido_snapshot,
      referral_source
    )
    VALUES (
      $1::uuid, $2::uuid, $3::uuid,
      $4, $5,
      $6::timestamptz, $7::timestamptz,
      $8, $9::timestamptz,
      $10::uuid,
      $11, $12
    )
    ON CONFLICT (id) DO UPDATE SET
      empresa_id = EXCLUDED.empresa_id,
      conversation_id = EXCLUDED.conversation_id,
      flow_code = EXCLUDED.flow_code,
      status = EXCLUDED.status,
      started_at = EXCLUDED.started_at,
      ended_at = EXCLUDED.ended_at,
      end_reason = EXCLUDED.end_reason,
      created_at = EXCLUDED.created_at,
      revendedor_id = EXCLUDED.revendedor_id,
      codigo_referido_snapshot = EXCLUDED.codigo_referido_snapshot,
      referral_source = EXCLUDED.referral_source
  `;

  await pool.query(sql, [
    uuidOrNull(raw.id),
    uuidOrNull(raw.empresa_id),
    uuidOrNull(raw.conversation_id),
    textOrNull(raw.flow_code),
    textOrNull(raw.status),
    raw.started_at,
    raw.ended_at,
    textOrNull(raw.end_reason),
    raw.created_at,
    null,
    textOrNull(raw.codigo_referido_snapshot),
    textOrNull(raw.referral_source),
  ]);
}

async function upsertZentraFlowSessionMirrorSupabase(raw: Record<string, unknown>): Promise<void> {
  const catalog = createServiceRoleClient();
  const row = {
    id: uuidOrNull(raw.id),
    empresa_id: uuidOrNull(raw.empresa_id),
    conversation_id: uuidOrNull(raw.conversation_id),
    flow_code: textOrNull(raw.flow_code),
    status: textOrNull(raw.status),
    started_at: tsIso(raw.started_at),
    ended_at: tsIso(raw.ended_at),
    end_reason: textOrNull(raw.end_reason),
    created_at: tsIso(raw.created_at),
    revendedor_id: null,
    codigo_referido_snapshot: textOrNull(raw.codigo_referido_snapshot),
    referral_source: textOrNull(raw.referral_source),
  };
  const { error } = await catalog.from("chat_flow_sessions").upsert(row, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

/**
 * Tras insertar la sesión en el tenant, replica la fila en `zentra_erp` para satisfacer FKs
 * (`chat_conversations.active_flow_session_id`, `chat_flow_events`, etc.).
 */
export async function ensureCentralChatFlowSessionMirror(opts: {
  pool?: Pool | null;
  empresaId: string;
  sessionId: string;
}): Promise<void> {
  // single_client: mirror central no aplica (sin schema central, INSERT a zentra_erp falla).
  if (isSingleClientMode()) return;

  const ds = await fetchDataSchemaForEmpresaId(opts.empresaId);
  let tenantSchema: string;
  try {
    tenantSchema = assertAllowedChatDataSchema(ds.trim());
  } catch {
    console.warn(LOG, "skip_invalid_schema");
    return;
  }

  if (!tenantSchema || tenantSchema === SUPABASE_APP_SCHEMA) {
    return;
  }

  try {
    const raw = await loadTenantFlowSessionRow({
      pool: opts.pool ?? null,
      tenantSchema,
      empresaId: opts.empresaId,
      sessionId: opts.sessionId,
    });

    if (!raw?.id) {
      console.warn(LOG, "tenant_session_not_found", { session_id: opts.sessionId });
      return;
    }

    const pool = opts.pool ?? null;
    if (pool) {
      await upsertZentraFlowSessionMirror(pool, raw);
    } else {
      await upsertZentraFlowSessionMirrorSupabase(raw);
    }

    console.info(LOG, "ok", {
      empresa_id: opts.empresaId,
      schema: tenantSchema,
      session_id: opts.sessionId,
      conversation_id: uuidOrNull(raw.conversation_id),
      flow_code: textOrNull(raw.flow_code),
      status: textOrNull(raw.status),
    });
  } catch (e) {
    console.warn(LOG, "failed", { message: e instanceof Error ? e.message : String(e) });
  }
}
