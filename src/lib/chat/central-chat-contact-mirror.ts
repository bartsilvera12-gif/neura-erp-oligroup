/**
 * Espejo de `chat_contacts` tenant → `zentra_erp.chat_contacts` (mismo `id`).
 * Necesario cuando las FK de `chat_conversations.contact_id` apuntan al catálogo central.
 */
import type { Pool } from "pg";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import { isSingleClientMode } from "@/lib/instance/single-client";

const LOG = "[chat-contact][central_mirror]" as const;

type TenantContactRow = {
  id: string;
  empresa_id: string;
  phone_number: string;
  name: string | null;
  cliente_id: string | null;
  crm_prospecto_id: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  phone_normalized: string | null;
  last_routed_chat_agent_id: string | null;
  last_routed_at: Date | string | null;
  last_routed_channel_id: string | null;
};

function uuidOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

async function loadTenantContactRow(opts: {
  pool: Pool | null | undefined;
  tenantSchema: string;
  empresaId: string;
  contactId: string;
}): Promise<TenantContactRow | null> {
  const qt = quoteSchemaTable(opts.tenantSchema, "chat_contacts");
  const sql = `SELECT * FROM ${qt} WHERE id = $1::uuid AND empresa_id = $2::uuid LIMIT 1`;

  if (opts.pool) {
    const r = await opts.pool.query(sql, [opts.contactId, opts.empresaId]);
    const raw = r.rows?.[0] as Record<string, unknown> | undefined;
    if (!raw) return null;
    return {
      id: String(raw.id ?? ""),
      empresa_id: String(raw.empresa_id ?? ""),
      phone_number: String(raw.phone_number ?? ""),
      name: (raw.name as string | null) ?? null,
      cliente_id: uuidOrNull(raw.cliente_id),
      crm_prospecto_id: uuidOrNull(raw.crm_prospecto_id),
      created_at: (raw.created_at as Date | string | null) ?? null,
      updated_at: (raw.updated_at as Date | string | null) ?? null,
      phone_normalized: (raw.phone_normalized as string | null) ?? null,
      last_routed_chat_agent_id: uuidOrNull(raw.last_routed_chat_agent_id),
      last_routed_at: (raw.last_routed_at as Date | string | null) ?? null,
      last_routed_channel_id: uuidOrNull(raw.last_routed_channel_id),
    };
  }

  const sb = createServiceRoleClientWithDbSchema(opts.tenantSchema) as SupabaseAdmin;
  const { data, error } = await sb
    .from("chat_contacts")
    .select(
      "id, empresa_id, phone_number, name, cliente_id, crm_prospecto_id, created_at, updated_at, phone_normalized, last_routed_chat_agent_id, last_routed_at, last_routed_channel_id"
    )
    .eq("id", opts.contactId)
    .eq("empresa_id", opts.empresaId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  const d = data as Record<string, unknown>;
  const str = (k: string) => (d[k] != null ? String(d[k]) : null);
  return {
    id: String(d.id ?? ""),
    empresa_id: String(d.empresa_id ?? ""),
    phone_number: String(d.phone_number ?? ""),
    name: (d.name as string | null) ?? null,
    cliente_id: str("cliente_id"),
    crm_prospecto_id: str("crm_prospecto_id"),
    created_at: str("created_at"),
    updated_at: str("updated_at"),
    phone_normalized: (d.phone_normalized as string | null) ?? null,
    last_routed_chat_agent_id: str("last_routed_chat_agent_id"),
    last_routed_at: str("last_routed_at"),
    last_routed_channel_id: str("last_routed_channel_id"),
  };
}

async function upsertZentraContactMirror(pool: Pool, row: TenantContactRow): Promise<void> {
  const sql = `
    INSERT INTO zentra_erp.chat_contacts (
      id,
      empresa_id,
      phone_number,
      name,
      cliente_id,
      crm_prospecto_id,
      created_at,
      updated_at,
      phone_normalized,
      last_routed_chat_agent_id,
      last_routed_at,
      last_routed_channel_id
    )
    VALUES (
      $1::uuid,
      $2::uuid,
      $3,
      $4,
      $5::uuid,
      $6::uuid,
      $7::timestamptz,
      $8::timestamptz,
      $9,
      $10::uuid,
      $11::timestamptz,
      $12::uuid
    )
    ON CONFLICT (id) DO UPDATE SET
      empresa_id = EXCLUDED.empresa_id,
      phone_number = EXCLUDED.phone_number,
      name = EXCLUDED.name,
      cliente_id = EXCLUDED.cliente_id,
      crm_prospecto_id = EXCLUDED.crm_prospecto_id,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      phone_normalized = EXCLUDED.phone_normalized,
      last_routed_chat_agent_id = EXCLUDED.last_routed_chat_agent_id,
      last_routed_at = EXCLUDED.last_routed_at,
      last_routed_channel_id = EXCLUDED.last_routed_channel_id
  `;

  await pool.query(sql, [
    row.id,
    row.empresa_id,
    row.phone_number,
    row.name,
    row.cliente_id,
    row.crm_prospecto_id,
    row.created_at,
    row.updated_at,
    row.phone_normalized,
    row.last_routed_chat_agent_id,
    row.last_routed_at,
    row.last_routed_channel_id,
  ]);
}

function tsIso(v: Date | string | null): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

async function upsertZentraContactMirrorSupabase(row: TenantContactRow): Promise<void> {
  const catalog = createServiceRoleClient();
  const { error } = await catalog.from("chat_contacts").upsert(
    {
      id: row.id,
      empresa_id: row.empresa_id,
      phone_number: row.phone_number,
      name: row.name,
      cliente_id: row.cliente_id,
      crm_prospecto_id: row.crm_prospecto_id,
      created_at: tsIso(row.created_at),
      updated_at: tsIso(row.updated_at),
      phone_normalized: row.phone_normalized,
      last_routed_chat_agent_id: row.last_routed_chat_agent_id,
      last_routed_at: tsIso(row.last_routed_at),
      last_routed_channel_id: row.last_routed_channel_id,
    },
    { onConflict: "id" }
  );
  if (error) throw new Error(error.message);
}

export async function ensureCentralChatContactMirror(opts: {
  pool?: Pool | null;
  tenantDataSchema: string;
  empresaId: string;
  contactId: string;
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
    const row = await loadTenantContactRow({
      pool: opts.pool ?? null,
      tenantSchema,
      empresaId: opts.empresaId,
      contactId: opts.contactId,
    });

    if (!row?.id) {
      console.warn(LOG, "tenant_contact_not_found", { contact_id: opts.contactId });
      return;
    }

    const pool = opts.pool ?? null;
    if (pool) {
      await upsertZentraContactMirror(pool, row);
    } else {
      await upsertZentraContactMirrorSupabase(row);
    }

    console.info(LOG, "ok", {
      empresa_id: row.empresa_id,
      contact_id: row.id,
      phone_digits: row.phone_number?.replace(/\D/g, "").slice(-6) ?? null,
    });
  } catch (e) {
    console.warn(LOG, "failed", { message: e instanceof Error ? e.message : String(e) });
  }
}
