/**
 * Espejo de `chat_channels` del schema tenant → `zentra_erp.chat_channels` con el mismo `id`.
 *
 * Los FKs de tablas tenant (p. ej. `chat_conversations.channel_id`) pueden seguir apuntando a
 * `zentra_erp.chat_channels`; sin esta fila el INSERT de conversación falla con 23503.
 */
import type { Pool } from "pg";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import { isSingleClientMode } from "@/lib/instance/single-client";

const LOG = "[chat-channel][central_mirror]" as const;

type TenantChannelRow = {
  id: string;
  empresa_id: string;
  nombre: string | null;
  type: string;
  meta_phone_number_id: string | null;
  provider: string;
  provider_channel_id: string | null;
  activo: boolean;
  connection_mode: string | null;
  config_status: string;
  config: unknown;
  whatsapp_access_token: string | null;
  updated_at: string | null;
};

async function loadTenantChannelRow(opts: {
  pool: Pool | null | undefined;
  tenantSchema: string;
  empresaId: string;
  channelId: string;
}): Promise<TenantChannelRow | null> {
  const qt = quoteSchemaTable(opts.tenantSchema, "chat_channels");
  const sql = `
    SELECT
      id::text,
      empresa_id::text,
      nombre,
      type::text,
      meta_phone_number_id,
      provider::text,
      provider_channel_id,
      activo,
      connection_mode::text,
      config_status::text,
      config,
      whatsapp_access_token,
      updated_at::text
    FROM ${qt}
    WHERE id = $1::uuid AND empresa_id = $2::uuid
    LIMIT 1
  `;

  if (opts.pool) {
    const r = await opts.pool.query(sql, [opts.channelId, opts.empresaId]);
    const row = r.rows?.[0];
    return row ? (row as TenantChannelRow) : null;
  }

  const sb = createServiceRoleClientWithDbSchema(opts.tenantSchema) as SupabaseAdmin;
  const { data, error } = await sb
    .from("chat_channels")
    .select(
      "id, empresa_id, nombre, type, meta_phone_number_id, provider, provider_channel_id, activo, connection_mode, config_status, config, whatsapp_access_token, updated_at"
    )
    .eq("id", opts.channelId)
    .eq("empresa_id", opts.empresaId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }
  if (!data) return null;
  const d = data as Record<string, unknown>;
  return {
    id: String(d.id ?? ""),
    empresa_id: String(d.empresa_id ?? ""),
    nombre: (d.nombre as string | null) ?? null,
    type: String(d.type ?? "whatsapp"),
    meta_phone_number_id: (d.meta_phone_number_id as string | null) ?? null,
    provider: String(d.provider ?? "meta"),
    provider_channel_id: (d.provider_channel_id as string | null) ?? null,
    activo: Boolean(d.activo),
    connection_mode: (d.connection_mode as string | null) ?? null,
    config_status: String(d.config_status ?? "incomplete"),
    config: d.config ?? {},
    whatsapp_access_token: (d.whatsapp_access_token as string | null) ?? null,
    updated_at: d.updated_at != null ? String(d.updated_at) : null,
  };
}

async function upsertZentraMirror(pool: Pool, row: TenantChannelRow): Promise<void> {
  const cfg = JSON.stringify(row.config ?? {});
  const updatedAt = row.updated_at ?? new Date().toISOString();
  const connMode = row.connection_mode?.trim() || "standard";

  const sql = `
    INSERT INTO zentra_erp.chat_channels (
      id,
      empresa_id,
      nombre,
      type,
      meta_phone_number_id,
      provider,
      provider_channel_id,
      activo,
      connection_mode,
      config_status,
      config,
      whatsapp_access_token,
      updated_at
    )
    VALUES (
      $1::uuid,
      $2::uuid,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11::jsonb,
      $12,
      $13::timestamptz
    )
    ON CONFLICT (id) DO UPDATE SET
      empresa_id = EXCLUDED.empresa_id,
      nombre = EXCLUDED.nombre,
      type = EXCLUDED.type,
      meta_phone_number_id = EXCLUDED.meta_phone_number_id,
      provider = EXCLUDED.provider,
      provider_channel_id = EXCLUDED.provider_channel_id,
      activo = EXCLUDED.activo,
      connection_mode = EXCLUDED.connection_mode,
      config_status = EXCLUDED.config_status,
      config = EXCLUDED.config,
      whatsapp_access_token = EXCLUDED.whatsapp_access_token,
      updated_at = EXCLUDED.updated_at
  `;

  await pool.query(sql, [
    row.id,
    row.empresa_id,
    row.nombre,
    row.type,
    row.meta_phone_number_id,
    row.provider,
    row.provider_channel_id,
    row.activo,
    connMode,
    row.config_status,
    cfg,
    row.whatsapp_access_token,
    updatedAt,
  ]);
}

async function upsertZentraMirrorSupabase(row: TenantChannelRow): Promise<void> {
  const catalog = createServiceRoleClient();
  const updatedAt = row.updated_at ?? new Date().toISOString();
  const connMode = row.connection_mode?.trim() || "standard";

  const { error } = await catalog.from("chat_channels").upsert(
    {
      id: row.id,
      empresa_id: row.empresa_id,
      nombre: row.nombre,
      type: row.type,
      meta_phone_number_id: row.meta_phone_number_id,
      provider: row.provider,
      provider_channel_id: row.provider_channel_id,
      activo: row.activo,
      connection_mode: connMode,
      config_status: row.config_status,
      config: row.config ?? {},
      whatsapp_access_token: row.whatsapp_access_token,
      updated_at: updatedAt,
    },
    { onConflict: "id" }
  );

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Garantiza una fila en `zentra_erp.chat_channels` copiando desde el schema tenant indicado.
 * No registra tokens ni payloads sensibles.
 */
export async function ensureCentralChatChannelMirror(opts: {
  pool?: Pool | null;
  tenantDataSchema: string;
  empresaId: string;
  channelId: string;
}): Promise<void> {
  // single_client: catálogo y datos viven en el mismo NEURA_CLIENT_SCHEMA; el mirror central
  // sería redundante e intentaría INSERT INTO zentra_erp.* que no existe en self-hosted.
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
    const row = await loadTenantChannelRow({
      pool: opts.pool ?? null,
      tenantSchema,
      empresaId: opts.empresaId,
      channelId: opts.channelId,
    });

    if (!row?.id) {
      console.warn(LOG, "tenant_channel_not_found", { channel_id: opts.channelId });
      return;
    }

    const pool = opts.pool ?? null;
    if (pool) {
      await upsertZentraMirror(pool, row);
    } else {
      await upsertZentraMirrorSupabase(row);
    }

    console.info(LOG, "ok", {
      empresa_id: row.empresa_id,
      channel_id: row.id,
      provider: row.provider,
      type: row.type,
      activo: row.activo,
      has_token: Boolean(row.whatsapp_access_token && row.whatsapp_access_token.length > 0),
    });
  } catch (e) {
    console.warn(LOG, "failed", { message: e instanceof Error ? e.message : String(e) });
  }
}
