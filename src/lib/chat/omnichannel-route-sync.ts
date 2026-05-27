import { ensureCentralChatChannelMirror } from "@/lib/chat/central-chat-channel-mirror";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { createServiceRoleClientWithDbSchema } from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import { isSingleClientMode } from "@/lib/instance/single-client";

/** PostgREST con `db.schema=public`: los RPC omnicanal viven en `public`, no en `zentra_erp`. */
function createPublicRpcClient(): SupabaseAdmin {
  return createServiceRoleClientWithDbSchema("public") as SupabaseAdmin;
}

export type OmnichannelRouteRow = {
  empresa_id: string;
  channel_id: string;
  data_schema: string;
};

/**
 * Lee `zentra_erp.omnichannel_routes` vía RPC `public.neura_get_omnichannel_route` (no depende de
 * que PostgREST tenga la tabla en schema cache). Si el RPC no existe aún, intenta `.from()`.
 */
export async function fetchOmnichannelRouteByMetaPhone(
  catalog: SupabaseAdmin,
  phoneNumberId: string
): Promise<OmnichannelRouteRow | null> {
  // single_client: routing implícito — el webhook resuelve el canal directamente desde
  // NEURA_CLIENT_SCHEMA.chat_channels. Los RPC `public.neura_*` y la tabla
  // `zentra_erp.omnichannel_routes` no existen en self-hosted.
  if (isSingleClientMode()) return null;

  const pid = phoneNumberId.trim();
  if (!pid) return null;

  const rpcCli = createPublicRpcClient();
  const { data, error } = await rpcCli.rpc("neura_get_omnichannel_route", {
    p_meta_phone_number_id: pid,
  });

  if (!error && data && typeof data === "object" && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    if (o.empresa_id && o.channel_id) {
      return {
        empresa_id: String(o.empresa_id),
        channel_id: String(o.channel_id),
        data_schema: o.data_schema != null ? String(o.data_schema) : "",
      };
    }
    return null;
  }

  if (error) {
    console.warn("[omnichannel-route-sync] neura_get_omnichannel_route:", error.message);
  }

  const { data: row, error: qErr } = await catalog
    .from("omnichannel_routes")
    .select("empresa_id, channel_id, data_schema")
    .eq("meta_phone_number_id", pid)
    .maybeSingle();

  if (qErr) {
    console.warn("[omnichannel-route-sync] fallback omnichannel_routes:", qErr.message);
    return null;
  }
  if (!row) return null;
  const r = row as { empresa_id: string; channel_id: string; data_schema?: string | null };
  return {
    empresa_id: r.empresa_id,
    channel_id: r.channel_id,
    data_schema: r.data_schema != null ? String(r.data_schema) : "",
  };
}

/**
 * Mantiene `zentra_erp.omnichannel_routes` alineado con canales WhatsApp en esquema tenant.
 * En zentra_erp (sin tenant) elimina la ruta si existía, para que el webhook use `chat_channels` en catálogo.
 */
export async function syncOmnichannelRouteForWhatsappChannel(opts: {
  metaPhoneNumberId: string;
  empresaId: string;
  channelId: string;
  activo: boolean;
  dataSchema: string;
}): Promise<void> {
  // single_client: no hay routing central a mantener.
  if (isSingleClientMode()) return;

  const pid = opts.metaPhoneNumberId.trim();
  if (!pid) return;

  const catalog = createServiceRoleClient();
  const rpcCli = createPublicRpcClient();

  const rpcDelete = async () => {
    const { error } = await rpcCli.rpc("neura_delete_omnichannel_route", {
      p_meta_phone_number_id: pid,
    });
    return error;
  };

  const rpcSync = async () => {
    const { error } = await rpcCli.rpc("neura_sync_omnichannel_route", {
      p_meta_phone_number_id: pid,
      p_empresa_id: opts.empresaId,
      p_channel_id: opts.channelId,
      p_data_schema: opts.dataSchema,
      p_activo: opts.activo,
    });
    return error;
  };

  const mirrorIfTenant = async () => {
    if (opts.dataSchema.trim() === SUPABASE_APP_SCHEMA) return;
    await ensureCentralChatChannelMirror({
      pool: getChatPostgresPool(),
      tenantDataSchema: opts.dataSchema,
      empresaId: opts.empresaId,
      channelId: opts.channelId,
    });
  };

  if (opts.dataSchema === SUPABASE_APP_SCHEMA || !opts.activo) {
    const rpcErr = await rpcDelete();
    if (!rpcErr) {
      await mirrorIfTenant();
      return;
    }
    const { error } = await catalog.from("omnichannel_routes").delete().eq("meta_phone_number_id", pid);
    if (error) {
      console.error("[omnichannel-route-sync] delete:", error.message);
      throw new Error(error.message);
    }
    await mirrorIfTenant();
    return;
  }

  const syncErr = await rpcSync();
  if (!syncErr) {
    await mirrorIfTenant();
    return;
  }

  console.warn("[omnichannel-route-sync] neura_sync_omnichannel_route:", syncErr.message);

  const { error } = await catalog.from("omnichannel_routes").upsert(
    {
      meta_phone_number_id: pid,
      empresa_id: opts.empresaId,
      channel_id: opts.channelId,
      data_schema: opts.dataSchema,
    },
    { onConflict: "meta_phone_number_id" }
  );

  if (error) {
    console.error("[omnichannel-route-sync] upsert:", error.message);
    throw new Error(error.message);
  }

  await mirrorIfTenant();
}

export async function deleteOmnichannelRouteByMetaPhone(metaPhoneNumberId: string): Promise<void> {
  // single_client: no hay routing central a borrar.
  if (isSingleClientMode()) return;

  const pid = metaPhoneNumberId.trim();
  if (!pid) return;
  const catalog = createServiceRoleClient();
  const rpcCli = createPublicRpcClient();
  const { error: rpcErr } = await rpcCli.rpc("neura_delete_omnichannel_route", {
    p_meta_phone_number_id: pid,
  });
  if (!rpcErr) return;
  console.warn("[omnichannel-route-sync] neura_delete_omnichannel_route:", rpcErr.message);
  const { error } = await catalog.from("omnichannel_routes").delete().eq("meta_phone_number_id", pid);
  if (error) {
    console.error("[omnichannel-route-sync] delete fallback:", error.message);
    throw new Error(error.message);
  }
}
