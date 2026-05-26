"use server";

import { requireEmpresaTenantServiceRole, type EmpresaTenantSrContext } from "@/lib/chat/empresa-tenant-service-role";
import {
  appendOmnicanalConversationScopeToQuery,
  filterConversationIdsByOmnicanalScope,
  getOmnicanalScope,
  isOmnicanalAdminScope,
  type OmnicanalConversationScopeCache,
  type OmnicanalScope,
  resolveChatAgentIdsForUsuarios,
  resolveQueueIdsForUsuarios,
  shouldBypassOmnicanalConversationScope,
} from "@/lib/chat/omnicanal-scope";
import { insertChatRoutingEvent, updateContactLastRouted } from "@/lib/chat/routing-audit";
import { isMissingColumnError } from "@/lib/chat/postgres-column-error";
import { isAgentSessionOnline } from "@/lib/chat/agent-presence";
import { batchFetchOmnicanalOperatorRoles, type OmnicanalOperatorRole } from "@/lib/chat/omnicanal-supervision-read";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  pgCountUnassignedOpenWithScope,
  pgGetMyAgentOperationalPresence,
  pgListChatAgentsDirectoryWithContext,
  pgLoadSupervisorAgentConversationStats,
  pgSetMyAgentOperationalPresence,
  pgTouchChatAgentInboxHeartbeat,
} from "@/lib/chat/chat-agents-tenant-pg";
import { logInvalidSchema } from "@/lib/chat/tenant-pg-trace";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";

/** Fila imposible para forzar 0 resultados en consultas `in`/count cuando el alcance no admite filas. */
const OMNICANAL_NO_MATCH_UUID = "00000000-0000-0000-0000-000000000001";

const STATUSES = new Set(["open", "pending", "closed"]);
const PRIORITIES = new Set(["low", "medium", "high"]);

async function loadConversationForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string,
  conversationId: string
) {
  const { data, error } = await supabase
    .from("chat_conversations")
    .select("id, empresa_id, queue_id, assigned_agent_id, status, contact_id, channel_id")
    .eq("id", conversationId.trim())
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    id: string;
    empresa_id: string;
    queue_id: string | null;
    assigned_agent_id: string | null;
    status: string;
    contact_id: string | null;
    channel_id: string | null;
  } | null;
}

async function loadAgentForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string,
  agentId: string
) {
  const { data, error } = await supabase
    .from("chat_agents")
    .select("id, empresa_id, queue_id, usuario_id")
    .eq("id", agentId.trim())
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    id: string;
    empresa_id: string;
    queue_id: string;
    usuario_id: string;
  } | null;
}

async function loadQueueForEmpresa(
  supabase: AppSupabaseClient,
  empresaId: string,
  queueId: string
) {
  const { data, error } = await supabase
    .from("chat_queues")
    .select("id, empresa_id")
    .eq("id", queueId.trim())
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; empresa_id: string } | null;
}

/**
 * Asigna conversación a un agente (`chat_agents.id`). Alinea `queue_id` con la cola del agente.
 */
export async function assignConversationToAgent(
  conversationId: string,
  agentId: string
): Promise<void> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");
  const agent = await loadAgentForEmpresa(supabase, empresa_id, agentId);
  if (!agent) throw new Error("Agente no encontrado");

  const ts = new Date().toISOString();
  const { error } = await supabase
    .from("chat_conversations")
    .update({
      assigned_agent_id: agent.id,
      queue_id: agent.queue_id,
      initial_assignment_at: ts,
      first_human_response_at: null,
      initial_reassign_count: 0,
      assignment_wait_code: null,
      updated_at: ts,
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);

  const cid = (conv.contact_id as string | null)?.trim();
  const chid = (conv.channel_id as string | null)?.trim();
  if (cid && chid) {
    await updateContactLastRouted(supabase, {
      empresa_id: empresa_id,
      contact_id: cid,
      channel_id: chid,
      chat_agent_id: agent.id,
      at_iso: ts,
    });
  }
  await insertChatRoutingEvent(supabase, {
    empresa_id: empresa_id,
    conversation_id: conv.id,
    queue_id: agent.queue_id,
    event_type: "supervisor_assigned",
    payload: { to_agent_id: agent.id, source: "assignConversationToAgent" },
  });
}

/**
 * Cola de la conversación (no limpia asignación; el supervisor puede reasignar después).
 */
export async function changeConversationQueue(conversationId: string, queueId: string): Promise<void> {
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");
  const queue = await loadQueueForEmpresa(supabase, empresa_id, queueId);
  if (!queue) throw new Error("Cola no encontrada");

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      queue_id: queue.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export async function changeConversationPriority(
  conversationId: string,
  priority: string
): Promise<void> {
  const p = priority.trim().toLowerCase();
  if (!PRIORITIES.has(p)) {
    throw new Error("Prioridad inválida");
  }
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      priority: p,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

export async function changeConversationStatus(conversationId: string, status: string): Promise<void> {
  const s = status.trim().toLowerCase();
  if (!STATUSES.has(s)) {
    throw new Error("Estado inválido");
  }
  const { supabase, empresa_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");

  const { error } = await supabase
    .from("chat_conversations")
    .update({
      status: s,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);
}

/**
 * Asigna al usuario actual si existe `chat_agents` para la cola de la conversación (o cualquier cola de la empresa si la conversación no tiene cola).
 */
export async function assignConversationToMe(conversationId: string): Promise<void> {
  const { supabase, empresa_id, usuario_id } = await requireEmpresaTenantServiceRole();
  const conv = await loadConversationForEmpresa(supabase, empresa_id, conversationId);
  if (!conv) throw new Error("Conversación no encontrada");

  let q = supabase
    .from("chat_agents")
    .select("id, queue_id")
    .eq("empresa_id", empresa_id)
    .eq("usuario_id", usuario_id)
    .eq("is_active", true);

  if (conv.queue_id) {
    q = q.eq("queue_id", conv.queue_id);
  }

  const { data: agent, error: aErr } = await q.limit(1).maybeSingle();
  if (aErr) throw new Error(aErr.message);
  if (!agent?.id) {
    throw new Error(
      conv.queue_id
        ? "No tenés perfil de agente en la cola de esta conversación. Pedí acceso al supervisor."
        : "No tenés perfil de agente en ninguna cola de la empresa."
    );
  }

  const ts = new Date().toISOString();
  const { error } = await supabase
    .from("chat_conversations")
    .update({
      assigned_agent_id: agent.id,
      queue_id: agent.queue_id,
      initial_assignment_at: ts,
      first_human_response_at: null,
      initial_reassign_count: 0,
      assignment_wait_code: null,
      updated_at: ts,
    })
    .eq("id", conv.id)
    .eq("empresa_id", empresa_id);

  if (error) throw new Error(error.message);

  const cid = (conv.contact_id as string | null)?.trim();
  const chid = (conv.channel_id as string | null)?.trim();
  if (cid && chid) {
    await updateContactLastRouted(supabase, {
      empresa_id: empresa_id,
      contact_id: cid,
      channel_id: chid,
      chat_agent_id: agent.id as string,
      at_iso: ts,
    });
  }
  await insertChatRoutingEvent(supabase, {
    empresa_id: empresa_id,
    conversation_id: conv.id,
    queue_id: agent.queue_id as string,
    event_type: "supervisor_assigned",
    payload: { to_agent_id: agent.id, source: "assignConversationToMe" },
  });
}

export type ChatQueueListRow = {
  id: string;
  nombre: string;
  is_active: boolean;
  channel_type: string | null;
  descripcion?: string | null;
  distribution_strategy?: string;
  priority?: number;
};

export async function listChatQueues(): Promise<ChatQueueListRow[]> {
  const { supabase, catalogSr, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id, {
    tenantDataSchema: dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    try {
      const qt = quoteSchemaTable(dataSchema, "chat_queues");
      const r = await pool.query(
        `SELECT id::text AS id, nombre, is_active, channel_type::text AS channel_type,
                descripcion, distribution_strategy::text AS distribution_strategy, priority
         FROM ${qt}
         WHERE empresa_id = $1::uuid
         ORDER BY priority DESC NULLS LAST, nombre ASC`,
        [empresa_id]
      );
      let rows = (r.rows ?? []).map((row: Record<string, unknown>) => ({
        id: String(row.id ?? ""),
        nombre: String(row.nombre ?? ""),
        is_active: row.is_active !== false,
        channel_type: (row.channel_type as string | null) ?? null,
        descripcion: (row.descripcion as string | null) ?? null,
        distribution_strategy: (row.distribution_strategy as string | undefined) ?? undefined,
        priority: typeof row.priority === "number" ? row.priority : undefined,
      })) as ChatQueueListRow[];

      if (!bypass) {
        if (scope.role === "supervisor") {
          const qids = await resolveQueueIdsForUsuarios(
            supabase,
            empresa_id,
            scope.agentUsuarioIds,
            dataSchema
          );
          if (qids.length > 0) {
            const allowed = new Set(qids);
            rows = rows.filter((row) => allowed.has(row.id));
          } else {
            return [];
          }
        } else if (scope.agentUsuarioIds.length > 0) {
          const qids = await resolveQueueIdsForUsuarios(
            supabase,
            empresa_id,
            scope.agentUsuarioIds,
            dataSchema
          );
          if (qids.length === 0) return [];
          const allowed = new Set(qids);
          rows = rows.filter((row) => allowed.has(row.id));
        } else {
          return [];
        }
      }
      return rows;
    } catch (e) {
      console.warn("[listChatQueues] tenant_pg falló, se intenta PostgREST:", e instanceof Error ? e.message : e);
    }
  }

  let q = supabase
    .from("chat_queues")
    .select("id, nombre, is_active, channel_type, descripcion, distribution_strategy, priority")
    .eq("empresa_id", empresa_id)
    .order("priority", { ascending: false })
    .order("nombre", { ascending: true });

  if (!bypass) {
    if (scope.role === "supervisor") {
      const qids = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds, dataSchema);
      if (qids.length > 0) {
        q = q.in("id", qids);
      } else {
        return [];
      }
    } else if (scope.agentUsuarioIds.length > 0) {
      const qids = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds, dataSchema);
      if (qids.length === 0) return [];
      q = q.in("id", qids);
    } else {
      return [];
    }
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ChatQueueListRow[];
}

export type MonitoringPendingReplyItem = {
  conversation_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  channel_label: string | null;
  waiting_since: string;
  last_preview: string | null;
};

/** Chats con agente asignado y sin primera respuesta humana saliente, agrupados por agente. */
export type MonitoringPendingReplyAgentGroup = {
  assigned_agent_id: string;
  agent_name: string;
  agent_email: string;
  pending_count: number;
  items: MonitoringPendingReplyItem[];
};

export type MonitoringDashboard = {
  active_queues: number;
  agents_assigned: number;
  unassigned_chats: number;
  pending_chats: number;
  active_channels: number;
  /** Asignados a humano pero sin primera respuesta saliente humana registrada. */
  awaiting_first_response: number;
  /** Detalle de chats pendientes de primera respuesta humana (por agente). */
  pending_human_reply_groups: MonitoringPendingReplyAgentGroup[];
  /** Chats abiertos/pendientes sin agente (orden por última actividad). */
  unassigned_recent: MonitoringUnassignedRow[];
};

export type MonitoringUnassignedRow = {
  id: string;
  status: string;
  last_message_at: string | null;
  created_at: string;
  queue_id: string | null;
  queue_name: string | null;
  assignment_wait_code: string | null;
  channel_id: string | null;
  channel_type: string | null;
  channel_nombre: string | null;
  contact_phone: string | null;
  contact_name: string | null;
  /** ISO8601 del primer mensaje o creación para SLA en Etapa 2. */
  waiting_since: string;
};

async function loadMonitoringDashboardForContext(
  ctx: EmpresaTenantSrContext,
  scope: OmnicanalScope,
  bypass: boolean,
  scopeConvCache: OmnicanalConversationScopeCache
): Promise<MonitoringDashboard> {
  const { supabase, catalogSr, empresa_id, usuario_id } = ctx;

  let queuesCountQ = supabase
    .from("chat_queues")
    .select("id", { count: "exact", head: true })
    .eq("empresa_id", empresa_id)
    .eq("is_active", true);
  if (!bypass) {
    if (scope.role === "supervisor") {
      const qids = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds);
      if (qids.length > 0) {
        queuesCountQ = queuesCountQ.in("id", qids);
      } else {
        queuesCountQ = queuesCountQ.eq("id", OMNICANAL_NO_MATCH_UUID);
      }
    } else if (scope.agentUsuarioIds.length > 0) {
      const qids = await resolveQueueIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds);
      if (qids.length > 0) {
        queuesCountQ = queuesCountQ.in("id", qids);
      } else {
        queuesCountQ = queuesCountQ.eq("id", OMNICANAL_NO_MATCH_UUID);
      }
    } else {
      queuesCountQ = queuesCountQ.eq("id", OMNICANAL_NO_MATCH_UUID);
    }
  }

  let agentsCountQ = supabase
    .from("chat_agents")
    .select("usuario_id")
    .eq("empresa_id", empresa_id)
    .eq("is_active", true);
  if (!bypass) {
    if (scope.agentUsuarioIds.length > 0) {
      agentsCountQ = agentsCountQ.in("usuario_id", scope.agentUsuarioIds);
    } else {
      agentsCountQ = agentsCountQ.eq("id", OMNICANAL_NO_MATCH_UUID);
    }
  }

  // PostgREST builders son thenables: nunca `return builder` desde `async` (se ejecuta la query y se pierde .order()).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scopedConv = async (q: any) => {
    if (bypass) return { builder: q };
    return appendOmnicanalConversationScopeToQuery(supabase, empresa_id, scope, q, scopeConvCache);
  };

  const [queuesRes, agentsRes] = await Promise.all([queuesCountQ, agentsCountQ]);

  const [unassignedRes, pendingRes, channelsRes, recentRes, awaitingFirstRes, pendingHumanRes] = await Promise.all([
    (async () => {
      let q = supabase
        .from("chat_conversations")
        .select("*", { count: "exact", head: true })
        .eq("empresa_id", empresa_id)
        .is("assigned_agent_id", null)
        .in("status", ["open", "pending"]);
      q = (await scopedConv(q)).builder;
      return await q;
    })(),
    (async () => {
      let q = supabase
        .from("chat_conversations")
        .select("*", { count: "exact", head: true })
        .eq("empresa_id", empresa_id)
        .eq("status", "pending");
      q = (await scopedConv(q)).builder;
      return await q;
    })(),
    (async () => {
      if (bypass || isOmnicanalAdminScope(scope)) {
        return await supabase
          .from("chat_channels")
          .select("*", { count: "exact", head: true })
          .eq("empresa_id", empresa_id)
          .eq("activo", true)
          .eq("config_status", "active");
      }
      const agentFkIds = await resolveChatAgentIdsForUsuarios(supabase, empresa_id, scope.agentUsuarioIds);
      if (agentFkIds.length === 0) {
        return { count: 0, error: null };
      }
      const { data: chRows, error: chErr } = await supabase
        .from("chat_conversations")
        .select("channel_id")
        .eq("empresa_id", empresa_id)
        .not("channel_id", "is", null)
        .in("assigned_agent_id", agentFkIds);
      if (chErr) {
        console.warn("[fetchMonitoringDashboard] active_channels:", chErr.message);
        return { count: 0, error: null };
      }
      const uniq = new Set(
        (chRows ?? [])
          .map((r: { channel_id?: string | null }) => String(r.channel_id ?? "").trim())
          .filter(Boolean)
      );
      return { count: uniq.size, error: null };
    })(),
    (async () => {
      const colsFull =
        "id, status, last_message_at, created_at, queue_id, channel_id, contact_id, assigned_agent_id, assignment_wait_code";
      const colsLegacy =
        "id, status, last_message_at, created_at, queue_id, channel_id, contact_id, assigned_agent_id";
      let q = supabase
        .from("chat_conversations")
        .select(colsFull)
        .eq("empresa_id", empresa_id)
        .is("assigned_agent_id", null)
        .in("status", ["open", "pending"])
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(30);
      q = (await scopedConv(q)).builder;
      let r: any = await q;
      if (r.error && isMissingColumnError(r.error.message, "assignment_wait_code")) {
        let q2 = supabase
          .from("chat_conversations")
          .select(colsLegacy)
          .eq("empresa_id", empresa_id)
          .is("assigned_agent_id", null)
          .in("status", ["open", "pending"])
          .order("last_message_at", { ascending: false, nullsFirst: false })
          .limit(30);
        q2 = (await scopedConv(q2)).builder;
        r = await q2;
      }
      return r;
    })(),
    (async () => {
      let q = supabase
        .from("chat_conversations")
        .select("*", { count: "exact", head: true })
        .eq("empresa_id", empresa_id)
        .not("assigned_agent_id", "is", null)
        .is("first_human_response_at", null)
        .in("status", ["open", "pending"]);
      q = (await scopedConv(q)).builder;
      return await q;
    })(),
    (async () => {
      let q = supabase
        .from("chat_conversations")
        .select(
          "id, last_message_at, created_at, last_message_preview, assigned_agent_id, contact_id, channel_id, status, initial_assignment_at"
        )
        .eq("empresa_id", empresa_id)
        .not("assigned_agent_id", "is", null)
        .is("first_human_response_at", null)
        .in("status", ["open", "pending"]);
      q = (await scopedConv(q)).builder;
      const r = await q.order("last_message_at", { ascending: false, nullsFirst: false }).limit(150);
      if (r.error && isMissingColumnError(r.error.message, "first_human_response_at")) {
        return { data: [], error: null };
      }
      return r;
    })(),
  ]);

  if (queuesRes.error) throw new Error(queuesRes.error.message);
  if (agentsRes.error) throw new Error(agentsRes.error.message);
  if (unassignedRes.error) throw new Error(unassignedRes.error.message);
  if (pendingRes.error) throw new Error(pendingRes.error.message);
  if (channelsRes.error) throw new Error(channelsRes.error.message);
  if (recentRes.error) throw new Error(recentRes.error.message);
  if (awaitingFirstRes.error) throw new Error(awaitingFirstRes.error.message);

  const agentRows = agentsRes.data ?? [];
  const distinctUsers = new Set(agentRows.map((r) => r.usuario_id as string).filter(Boolean));

  const convList = (recentRes.data ?? []) as Record<string, unknown>[];
  const queueIds = [
    ...new Set(convList.map((c: Record<string, unknown>) => (c.queue_id as string | null)?.trim()).filter(Boolean)),
  ] as string[];
  const channelIds = [
    ...new Set(convList.map((c: Record<string, unknown>) => (c.channel_id as string | null)?.trim()).filter(Boolean)),
  ] as string[];
  const contactIds = [
    ...new Set(convList.map((c: Record<string, unknown>) => (c.contact_id as string | null)?.trim()).filter(Boolean)),
  ] as string[];

  let queueNombreById: Record<string, string> = {};
  if (queueIds.length > 0) {
    const { data: qrows, error: qErr } = await supabase
      .from("chat_queues")
      .select("id, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", queueIds);
    if (qErr) throw new Error(qErr.message);
    queueNombreById = Object.fromEntries(
      (qrows ?? []).map((r) => [r.id as string, String((r as { nombre?: string }).nombre ?? "").trim() || "Cola"])
    );
  }

  let channelMetaById: Record<string, { type: string; nombre: string | null }> = {};
  if (channelIds.length > 0) {
    const { data: chrows, error: chErr } = await supabase
      .from("chat_channels")
      .select("id, type, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", channelIds);
    if (chErr) throw new Error(chErr.message);
    channelMetaById = Object.fromEntries(
      (chrows ?? []).map((r) => [
        r.id as string,
        {
          type: ((r as { type?: string }).type as string) ?? "whatsapp",
          nombre: (r as { nombre?: string | null }).nombre ?? null,
        },
      ])
    );
  }

  let contactById: Record<string, { phone_number: string | null; name: string | null }> = {};
  if (contactIds.length > 0) {
    const { data: crows, error: cErr } = await supabase
      .from("chat_contacts")
      .select("id, phone_number, name")
      .eq("empresa_id", empresa_id)
      .in("id", contactIds);
    if (cErr) throw new Error(cErr.message);
    contactById = Object.fromEntries(
      (crows ?? []).map((r) => [
        r.id as string,
        {
          phone_number: (r as { phone_number?: string | null }).phone_number ?? null,
          name: (r as { name?: string | null }).name ?? null,
        },
      ])
    );
  }

  if (pendingHumanRes.error) {
    console.warn("[fetchMonitoringDashboard] pendientes primera respuesta:", pendingHumanRes.error.message);
  }
  const pendingRows = (!pendingHumanRes.error && pendingHumanRes.data
    ? (pendingHumanRes.data as Record<string, unknown>[])
    : []) as Record<string, unknown>[];
  const pendingConvIds = pendingRows.map((r) => String(r.id ?? "").trim()).filter(Boolean);
  const pendingVisible = await filterConversationIdsByOmnicanalScope(
    supabase,
    catalogSr,
    empresa_id,
    usuario_id,
    pendingConvIds
  );
  const pendingFiltered = pendingRows.filter((r) => pendingVisible.has(String(r.id ?? "").trim()));

  const pendChannelIds = [
    ...new Set(
      pendingFiltered
        .map((c) => (c.channel_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  const pendContactIds = [
    ...new Set(
      pendingFiltered
        .map((c) => (c.contact_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  let pendChannelMeta: Record<string, { type: string; nombre: string | null }> = {};
  if (pendChannelIds.length > 0) {
    const { data: pch, error: peCh } = await supabase
      .from("chat_channels")
      .select("id, type, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", pendChannelIds);
    if (!peCh && pch) {
      pendChannelMeta = Object.fromEntries(
        (pch ?? []).map((row) => [
          row.id as string,
          {
            type: ((row as { type?: string }).type as string) ?? "whatsapp",
            nombre: (row as { nombre?: string | null }).nombre ?? null,
          },
        ])
      );
    }
  }
  let pendContactById: Record<string, { phone_number: string | null; name: string | null }> = {};
  if (pendContactIds.length > 0) {
    const { data: pco, error: peCo } = await supabase
      .from("chat_contacts")
      .select("id, phone_number, name")
      .eq("empresa_id", empresa_id)
      .in("id", pendContactIds);
    if (!peCo && pco) {
      pendContactById = Object.fromEntries(
        (pco ?? []).map((row) => [
          row.id as string,
          {
            phone_number: (row as { phone_number?: string | null }).phone_number ?? null,
            name: (row as { name?: string | null }).name ?? null,
          },
        ])
      );
    }
  }

  const pendAgentIds = [
    ...new Set(
      pendingFiltered
        .map((r) => (r.assigned_agent_id as string | null | undefined)?.trim())
        .filter((x): x is string => Boolean(x && x.length > 0))
    ),
  ];
  let pendAgentUsuario: Record<string, string> = {};
  if (pendAgentIds.length > 0) {
    const { data: par, error: peAg } = await supabase
      .from("chat_agents")
      .select("id, usuario_id")
      .eq("empresa_id", empresa_id)
      .in("id", pendAgentIds);
    if (!peAg && par) {
      pendAgentUsuario = Object.fromEntries(
        (par ?? []).map((row) => [row.id as string, (row as { usuario_id: string }).usuario_id])
      );
    }
  }
  const pendUserIds = [...new Set(Object.values(pendAgentUsuario))];
  let pendUsuarioNombre: Record<string, { nombre: string | null; email: string | null }> = {};
  if (pendUserIds.length > 0) {
    const { data: pur, error: peU } = await catalogSr
      .from("usuarios")
      .select("id, nombre, email")
      .in("id", pendUserIds);
    if (!peU && pur) {
      pendUsuarioNombre = Object.fromEntries(
        (pur ?? []).map((u) => [
          u.id as string,
          {
            nombre: (u as { nombre?: string | null }).nombre ?? null,
            email: (u as { email?: string | null }).email ?? null,
          },
        ])
      );
    }
  }

  const groupMap = new Map<string, MonitoringPendingReplyItem[]>();
  for (const row of pendingFiltered) {
    const aid = String((row.assigned_agent_id as string | null) ?? "").trim();
    if (!aid) continue;
    const ctid = String((row.contact_id as string | null) ?? "").trim();
    const chid = String((row.channel_id as string | null) ?? "").trim();
    const contact = ctid ? pendContactById[ctid] : undefined;
    const ch = chid ? pendChannelMeta[chid] : undefined;
    const channelLabel = ch?.nombre?.trim() || ch?.type || null;
    const created = (row.created_at as string) ?? new Date().toISOString();
    const last = (row.last_message_at as string | null) ?? null;
    const init = (row as { initial_assignment_at?: string | null }).initial_assignment_at ?? null;
    const waiting_since = last ?? init ?? created;
    const item: MonitoringPendingReplyItem = {
      conversation_id: row.id as string,
      contact_name: contact?.name ?? null,
      contact_phone: contact?.phone_number ?? null,
      channel_label: channelLabel,
      waiting_since,
      last_preview: (row.last_message_preview as string | null) ?? null,
    };
    const arr = groupMap.get(aid) ?? [];
    arr.push(item);
    groupMap.set(aid, arr);
  }

  const pending_human_reply_groups: MonitoringPendingReplyAgentGroup[] = [...groupMap.entries()].map(
    ([assigned_agent_id, items]) => {
      const uid = pendAgentUsuario[assigned_agent_id];
      const u = uid ? pendUsuarioNombre[uid] : undefined;
      const agent_name = (u?.nombre?.trim() || u?.email?.trim() || "Agente") as string;
      const agent_email = (u?.email as string) ?? "";
      return {
        assigned_agent_id,
        agent_name,
        agent_email,
        pending_count: items.length,
        items,
      };
    }
  );
  pending_human_reply_groups.sort((a, b) => b.pending_count - a.pending_count || a.agent_name.localeCompare(b.agent_name));

  const unassigned_recent: MonitoringUnassignedRow[] = convList.map((row: Record<string, unknown>) => {
    const qid = (row.queue_id as string | null)?.trim() || null;
    const cid = (row.channel_id as string | null)?.trim() || null;
    const ctid = (row.contact_id as string | null)?.trim() || null;
    const rawWait = (row as { assignment_wait_code?: string | null }).assignment_wait_code;
    const assignment_wait_code =
      typeof rawWait === "string" && rawWait.trim() ? rawWait.trim() : null;
    const ch = cid ? channelMetaById[cid] : undefined;
    const contact = ctid ? contactById[ctid] : undefined;
    const created = (row.created_at as string) ?? new Date().toISOString();
    const last = (row.last_message_at as string | null) ?? null;
    const waiting_since = last ?? created;
    return {
      id: row.id as string,
      status: (row.status as string) ?? "open",
      last_message_at: last,
      created_at: created,
      queue_id: qid,
      queue_name: qid ? queueNombreById[qid] ?? null : null,
      assignment_wait_code,
      channel_id: cid,
      channel_type: ch?.type ?? null,
      channel_nombre: ch?.nombre ?? null,
      contact_phone: contact?.phone_number ?? null,
      contact_name: contact?.name ?? null,
      waiting_since,
    };
  });

  return {
    active_queues: queuesRes.count ?? 0,
    agents_assigned: distinctUsers.size,
    unassigned_chats: unassignedRes.count ?? 0,
    pending_chats: pendingRes.count ?? 0,
    active_channels: channelsRes.count ?? 0,
    awaiting_first_response: awaitingFirstRes.count ?? 0,
    pending_human_reply_groups,
    unassigned_recent,
  };
}

export async function fetchMonitoringDashboard(): Promise<MonitoringDashboard> {
  const ctx = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(ctx.supabase, ctx.empresa_id, ctx.usuario_id, {
    tenantDataSchema: ctx.dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(ctx.catalogSr, ctx.usuario_id, scope);
  return loadMonitoringDashboardForContext(ctx, scope, bypass, {});
}

export type ChatAgentDirectoryRow = {
  id: string;
  queue_id: string;
  queue_nombre: string;
  usuario_id: string;
  nombre: string;
  email: string;
  /** Sesión en línea: derivado de `last_heartbeat_at` (≤60 s) cuando existe la columna. */
  is_online: boolean;
  /** ready | offline — autoasignación solo en ready. */
  operational_status: string;
  max_conversations: number;
  /** Último cambio de turno (ready/offline); requiere migración operational_status_changed_at. */
  operational_status_changed_at?: string | null;
  /** Último ping desde inbox; requiere migración last_heartbeat_at. */
  last_heartbeat_at?: string | null;
};

/** Agentes con nombre para reasignación y vistas de supervisor. */
export async function listChatAgentsDirectory(): Promise<ChatAgentDirectoryRow[]> {
  const ctx = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(ctx.supabase, ctx.empresa_id, ctx.usuario_id, {
    tenantDataSchema: ctx.dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(ctx.catalogSr, ctx.usuario_id, scope);
  return listChatAgentsDirectoryWithContext(ctx, scope, bypass);
}

async function listChatAgentsDirectoryWithContext(
  ctx: EmpresaTenantSrContext,
  scope: OmnicanalScope,
  bypass: boolean
): Promise<ChatAgentDirectoryRow[]> {
  const poolPg = getChatPostgresPool();
  const { dataSchema } = ctx;
  if (poolPg && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    try {
      const pgRows = await pgListChatAgentsDirectoryWithContext(poolPg, dataSchema, ctx, scope, bypass);
      return pgRows as ChatAgentDirectoryRow[];
    } catch (e) {
      logInvalidSchema("listChatAgentsDirectoryWithContext_pg", dataSchema, e);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  const { supabase, catalogSr, empresa_id } = ctx;

  let aq = supabase
    .from("chat_agents")
    .select(
      "id, queue_id, is_online, operational_status, operational_status_changed_at, last_heartbeat_at, max_conversations, usuario_id"
    )
    .eq("empresa_id", empresa_id)
    .eq("is_active", true)
    .order("queue_id", { ascending: true });

  if (!bypass) {
    if (scope.agentUsuarioIds.length > 0) {
      aq = aq.in("usuario_id", scope.agentUsuarioIds);
    } else {
      aq = aq.eq("id", OMNICANAL_NO_MATCH_UUID);
    }
  }

  let { data, error } = await aq;

  if (
    error &&
    (isMissingColumnError(error.message, "operational_status_changed_at") ||
      isMissingColumnError(error.message, "last_heartbeat_at"))
  ) {
    let aq0 = supabase
      .from("chat_agents")
      .select("id, queue_id, is_online, operational_status, max_conversations, usuario_id")
      .eq("empresa_id", empresa_id)
      .eq("is_active", true)
      .order("queue_id", { ascending: true });
    if (!bypass) {
      if (scope.agentUsuarioIds.length > 0) {
        aq0 = aq0.in("usuario_id", scope.agentUsuarioIds);
      } else {
        aq0 = aq0.eq("id", OMNICANAL_NO_MATCH_UUID);
      }
    }
    const again = await aq0;
    data = again.data as typeof data;
    error = again.error;
  }

  if (error && isMissingColumnError(error.message, "operational_status")) {
    let aq2 = supabase
      .from("chat_agents")
      .select("id, queue_id, is_online, max_conversations, usuario_id")
      .eq("empresa_id", empresa_id)
      .eq("is_active", true)
      .order("queue_id", { ascending: true });
    if (!bypass) {
      if (scope.agentUsuarioIds.length > 0) {
        aq2 = aq2.in("usuario_id", scope.agentUsuarioIds);
      } else {
        aq2 = aq2.eq("id", OMNICANAL_NO_MATCH_UUID);
      }
    }
    const second = await aq2;
    data = second.data as typeof data;
    error = second.error;
  }

  if (error) {
    logInvalidSchema("listChatAgentsDirectoryWithContext", ctx.dataSchema, error);
    throw new Error(error.message);
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  const queueIds = [...new Set(rows.map((row) => row.queue_id as string).filter(Boolean))];
  let queueNombreById: Record<string, string> = {};
  if (queueIds.length > 0) {
    const { data: qrows, error: qErr } = await supabase
      .from("chat_queues")
      .select("id, nombre")
      .eq("empresa_id", empresa_id)
      .in("id", queueIds);
    if (qErr) {
      logInvalidSchema("listChatAgentsDirectoryWithContext.chat_queues", ctx.dataSchema, qErr);
      throw new Error(qErr.message);
    }
    queueNombreById = Object.fromEntries(
      (qrows ?? []).map((r) => [
        r.id as string,
        String((r as { nombre?: string | null }).nombre ?? "").trim() || "Cola",
      ])
    );
  }

  const uids = [...new Set(rows.map((row) => row.usuario_id as string).filter(Boolean))];
  let usuarioById: Record<string, { nombre: string | null; email: string | null }> = {};
  if (uids.length > 0) {
    const { data: urows, error: uErr } = await catalogSr
      .from("usuarios")
      .select("id, nombre, email")
      .in("id", uids);
    if (uErr) throw new Error(uErr.message);
    usuarioById = Object.fromEntries(
      (urows ?? []).map((u) => [
        u.id as string,
        {
          nombre: (u as { nombre?: string | null }).nombre ?? null,
          email: (u as { email?: string | null }).email ?? null,
        },
      ])
    );
  }

  return rows.map((row) => {
    const qid = row.queue_id as string;
    const queueNombre = queueNombreById[qid] ?? "Cola";
    const uid = row.usuario_id as string;
    const u = usuarioById[uid];
    const nombre = (u?.nombre?.trim() || u?.email?.trim() || "—") as string;
    const hasHeartbeatField = Object.prototype.hasOwnProperty.call(row, "last_heartbeat_at");
    const sessionOnline = hasHeartbeatField
      ? isAgentSessionOnline((row.last_heartbeat_at as string | null) ?? null)
      : Boolean(row.is_online);
    return {
      id: row.id as string,
      queue_id: qid,
      queue_nombre: queueNombre,
      usuario_id: uid,
      nombre,
      email: (u?.email as string) ?? "",
      is_online: sessionOnline,
      operational_status:
        (row.operational_status as string | undefined)?.trim() === "offline" ? "offline" : "ready",
      max_conversations: (row.max_conversations as number) ?? 5,
      operational_status_changed_at:
        (row.operational_status_changed_at as string | null | undefined) ?? null,
      last_heartbeat_at: (row.last_heartbeat_at as string | null | undefined) ?? null,
    };
  });
}

export type SupervisorAgentLoadRow = ChatAgentDirectoryRow & {
  active_conversations: number;
  /** Chats asignados sin primera respuesta humana saliente aún. */
  pending_first_reply: number;
  /** Rol operativo en la empresa (tabla `chat_empresa_operator_roles`), si existe. */
  omnicanal_role: OmnicanalOperatorRole | null;
};

async function loadSupervisorAgentLoadsWithContext(
  ctx: EmpresaTenantSrContext,
  scope: OmnicanalScope,
  bypass: boolean,
  scopeConvCache: OmnicanalConversationScopeCache
): Promise<SupervisorAgentLoadRow[]> {
  const poolPg = getChatPostgresPool();
  const { dataSchema, empresa_id, supabase } = ctx;
  if (poolPg && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const agentsPg = await pgListChatAgentsDirectoryWithContext(poolPg, dataSchema, ctx, scope, bypass);
    const agents = agentsPg as ChatAgentDirectoryRow[];
    if (agents.length === 0) return [];

    const roleByUsuario = await batchFetchOmnicanalOperatorRoles(
      supabase,
      empresa_id,
      agents.map((a) => a.usuario_id)
    );

    const agentIds = agents.map((a) => a.id);
    const counts = await pgLoadSupervisorAgentConversationStats(
      poolPg,
      dataSchema,
      empresa_id,
      scope,
      bypass,
      agentIds
    );

    const tally = new Map<string, number>();
    const pendingFirst = new Map<string, number>();
    for (const row of counts) {
      const aid = row.assigned_agent_id as string | null;
      if (!aid) continue;
      tally.set(aid, (tally.get(aid) ?? 0) + 1);
      const st = row.status;
      const fh = row.first_human_response_at;
      if ((st === "open" || st === "pending") && (fh == null || fh === "")) {
        pendingFirst.set(aid, (pendingFirst.get(aid) ?? 0) + 1);
      }
    }

    return agents.map((a) => ({
      ...a,
      active_conversations: tally.get(a.id) ?? 0,
      pending_first_reply: pendingFirst.get(a.id) ?? 0,
      omnicanal_role: roleByUsuario.get(a.usuario_id) ?? null,
    }));
  }

  const agents = await listChatAgentsDirectoryWithContext(ctx, scope, bypass);
  if (agents.length === 0) return [];

  const roleByUsuario = await batchFetchOmnicanalOperatorRoles(
    supabase,
    empresa_id,
    agents.map((a) => a.usuario_id)
  );

  const agentIds = agents.map((a) => a.id);
  let cq = supabase
    .from("chat_conversations")
    .select("assigned_agent_id, first_human_response_at, status")
    .eq("empresa_id", empresa_id)
    .in("assigned_agent_id", agentIds)
    .neq("status", "closed");

  if (!bypass) {
    cq = (await appendOmnicanalConversationScopeToQuery(
      supabase,
      empresa_id,
      scope,
      cq,
      scopeConvCache
    )).builder;
  }

  const { data: counts, error } = await cq;

  if (error) {
    logInvalidSchema("loadSupervisorAgentLoadsWithContext.conversations", ctx.dataSchema, error);
    throw new Error(error.message);
  }

  const tally = new Map<string, number>();
  const pendingFirst = new Map<string, number>();
  for (const row of counts ?? []) {
    const aid = row.assigned_agent_id as string | null;
    if (!aid) continue;
    tally.set(aid, (tally.get(aid) ?? 0) + 1);
    const st = (row as { status?: string }).status;
    const fh = (row as { first_human_response_at?: string | null }).first_human_response_at;
    if ((st === "open" || st === "pending") && (fh == null || fh === "")) {
      pendingFirst.set(aid, (pendingFirst.get(aid) ?? 0) + 1);
    }
  }

  return agents.map((a) => ({
    ...a,
    active_conversations: tally.get(a.id) ?? 0,
    pending_first_reply: pendingFirst.get(a.id) ?? 0,
    omnicanal_role: roleByUsuario.get(a.usuario_id) ?? null,
  }));
}

export async function fetchSupervisorAgentLoads(): Promise<SupervisorAgentLoadRow[]> {
  const ctx = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(ctx.supabase, ctx.empresa_id, ctx.usuario_id, {
    tenantDataSchema: ctx.dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(ctx.catalogSr, ctx.usuario_id, scope);
  return loadSupervisorAgentLoadsWithContext(ctx, scope, bypass, {});
}

/** Una sola ida servidor: métricas + tabla agentes + banner UX (Monitoreo). */
export type MonitoreoPageData = {
  dash: MonitoringDashboard;
  agents: SupervisorAgentLoadRow[];
  ux: {
    omnicanal_role: OmnicanalOperatorRole | null;
    bypass_catalog_rol: boolean;
    team_agent_usuario_count: number;
  };
};

export async function fetchMonitoreoPageData(): Promise<MonitoreoPageData> {
  const t0 = Date.now();
  const ctx = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(ctx.supabase, ctx.empresa_id, ctx.usuario_id, {
    tenantDataSchema: ctx.dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(ctx.catalogSr, ctx.usuario_id, scope);
  const scopeConvCache: OmnicanalConversationScopeCache = {};
  const tParallel = Date.now();
  const [dash, agents] = await Promise.all([
    loadMonitoringDashboardForContext(ctx, scope, bypass, scopeConvCache),
    loadSupervisorAgentLoadsWithContext(ctx, scope, bypass, scopeConvCache),
  ]);
  if (process.env.MONITOREO_TIMING_DEBUG === "1") {
    console.info("[fetchMonitoreoPageData]", {
      auth_scope_ms: tParallel - t0,
      parallel_ms: Date.now() - tParallel,
      total_ms: Date.now() - t0,
    });
  }
  return {
    dash,
    agents,
    ux: {
      omnicanal_role: scope.role,
      bypass_catalog_rol: bypass,
      team_agent_usuario_count: scope.agentUsuarioIds.length,
    },
  };
}

export async function countUnassignedOpenConversations(): Promise<number> {
  const { supabase, catalogSr, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id, {
    tenantDataSchema: dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);

  const poolCt = getChatPostgresPool();
  if (poolCt && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    return pgCountUnassignedOpenWithScope(poolCt, dataSchema, empresa_id, scope, bypass);
  }

  let q = supabase
    .from("chat_conversations")
    .select("*", { count: "exact", head: true })
    .eq("empresa_id", empresa_id)
    .is("assigned_agent_id", null)
    .in("status", ["open", "pending"]);

  if (!bypass) {
    q = (await appendOmnicanalConversationScopeToQuery(supabase, empresa_id, scope, q)).builder;
  }

  const { count, error } = await q;

  if (error) throw new Error(error.message);
  return count ?? 0;
}

export type ChatAgentOperationalStatus = "ready" | "offline";

export type MyAgentOperationalPresenceResult =
  | { in_queues: false }
  | { in_queues: true; status: ChatAgentOperationalStatus; status_changed_at: string | null };

/**
 * Presencia omnicanal del usuario logueado en todas sus filas `chat_agents`.
 * Si no participa en ninguna cola, `in_queues: false`.
 */
export async function getMyAgentOperationalPresence(): Promise<MyAgentOperationalPresenceResult> {
  const { supabase, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const pool = getChatPostgresPool();
  if (pool && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    const r = await pgGetMyAgentOperationalPresence(pool, dataSchema, empresa_id, usuario_id);
    if (r.in_queues) {
      return {
        in_queues: true,
        status: r.status,
        status_changed_at: r.status_changed_at,
      };
    }
    return { in_queues: false };
  }

  let { data, error } = await supabase
    .from("chat_agents")
    .select("operational_status, operational_status_changed_at, updated_at")
    .eq("empresa_id", empresa_id)
    .eq("usuario_id", usuario_id);
  if (error && isMissingColumnError(error.message, "operational_status_changed_at")) {
    const r2 = await supabase
      .from("chat_agents")
      .select("operational_status, updated_at")
      .eq("empresa_id", empresa_id)
      .eq("usuario_id", usuario_id);
    data = r2.data as typeof data;
    error = r2.error;
  }
  if (error && isMissingColumnError(error.message, "operational_status")) {
    const legacy = await supabase
      .from("chat_agents")
      .select("id")
      .eq("empresa_id", empresa_id)
      .eq("usuario_id", usuario_id);
    data = legacy.data as typeof data;
    error = legacy.error;
    if (error) {
      console.warn("[getMyAgentOperationalPresence] legado chat_agents:", error.message);
      return { in_queues: false };
    }
    const rowsLegacy = data ?? [];
    if (rowsLegacy.length === 0) return { in_queues: false };
    return { in_queues: true, status: "ready", status_changed_at: null };
  }
  if (error) {
    logInvalidSchema("getMyAgentOperationalPresence", dataSchema, error);
    console.warn("[getMyAgentOperationalPresence] error no fatal:", error.message);
    return { in_queues: false };
  }
  const rows = (data ?? []) as {
    operational_status?: string | null;
    operational_status_changed_at?: string | null;
    updated_at?: string | null;
  }[];
  if (rows.length === 0) return { in_queues: false };
  const anyOffline = rows.some((r) => r.operational_status === "offline");
  const status: ChatAgentOperationalStatus = anyOffline ? "offline" : "ready";
  const changedAts = rows
    .map((r) => r.operational_status_changed_at)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const updatedAts = rows
    .map((r) => r.updated_at)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const earliest = (xs: string[]) => xs.reduce((a, b) => (a < b ? a : b));
  const status_changed_at =
    changedAts.length > 0 ? earliest(changedAts) : updatedAts.length > 0 ? earliest(updatedAts) : null;
  return { in_queues: true, status, status_changed_at };
}

/** Insignia en cabecera inbox cuando el usuario no tiene filas en `chat_agents`. */
export type InboxCabeceraInsignia = "admin" | "supervisor" | null;

/** Datos de cabecera inbox (presencia + rol omnicanal) en una sola ida al servidor. */
export type ConversacionesInboxBootstrap = {
  presence: MyAgentOperationalPresenceResult;
  omnicanal_role: OmnicanalOperatorRole | null;
  /**
   * Sin colas de agente: qué mostrar arriba a la derecha.
   * Incluye admin **ERP** (`usuarios.rol`) aunque no exista fila en `chat_empresa_operator_roles`
   * (caso típico “Usuario Admin” en el menú).
   */
  cabecera_insignia: InboxCabeceraInsignia;
  /**
   * `true` si la empresa tiene al menos un flujo de chat activo. Resuelto server-side junto al
   * resto del bootstrap para que la pestaña “Bot” pueda renderizarse desde el primer SSR sin
   * depender de una server action client-side que puede fallar silenciosamente y dejar la
   * pestaña oculta.
   */
  has_active_flows: boolean;
};

const USUARIO_ROL_ADMIN_ERP = new Set(["admin", "administrador", "super_admin", "owner"]);

/** Resumen para banners UX (alcance omnicanal sin datos sensibles). */
export async function fetchOmnicanalUxSummary(): Promise<{
  omnicanal_role: OmnicanalOperatorRole | null;
  bypass_catalog_rol: boolean;
  team_agent_usuario_count: number;
}> {
  const { supabase, catalogSr, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const scope = await getOmnicanalScope(supabase, empresa_id, usuario_id, {
    tenantDataSchema: dataSchema,
  });
  const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);
  return {
    omnicanal_role: scope.role,
    bypass_catalog_rol: bypass,
    team_agent_usuario_count: scope.agentUsuarioIds.length,
  };
}

export async function getConversacionesInboxBootstrap(): Promise<ConversacionesInboxBootstrap> {
  const { supabase, catalogSr, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const [presence, scope, activeFlowsCheck] = await Promise.all([
    getMyAgentOperationalPresence(),
    getOmnicanalScope(supabase, empresa_id, usuario_id, {
      tenantDataSchema: dataSchema,
    }),
    /**
     * Conteo head=true: solo necesitamos saber si EXISTE al menos un flow activo.
     * Mismo cliente que `hasEmpresaActiveChatFlows`, pero resuelto en el round-trip
     * server-side de bootstrap para que la prop llegue al RSC sin race condition.
     * Supabase entrega errores en `.error` (no throws), por eso no requiere try/catch.
     */
    supabase
      .from("chat_flows")
      .select("id", { count: "exact", head: true })
      .eq("empresa_id", empresa_id)
      .eq("activo", true),
  ]);
  const has_active_flows = !activeFlowsCheck.error && (activeFlowsCheck.count ?? 0) > 0;

  let cabecera_insignia: InboxCabeceraInsignia = null;
  if (!presence.in_queues) {
    if (scope.role === "supervisor") {
      cabecera_insignia = "supervisor";
    } else if (scope.role === "admin") {
      cabecera_insignia = "admin";
    } else {
      const bypass = await shouldBypassOmnicanalConversationScope(catalogSr, usuario_id, scope);
      if (bypass) {
        const { data: urow, error: uerr } = await catalogSr
          .from("usuarios")
          .select("rol")
          .eq("id", usuario_id)
          .maybeSingle();
        if (!uerr && urow) {
          const rol = String((urow as { rol?: string | null }).rol ?? "")
            .trim()
            .toLowerCase();
          if (USUARIO_ROL_ADMIN_ERP.has(rol)) cabecera_insignia = "admin";
        }
      }
    }
  }

  return { presence, omnicanal_role: scope.role, cabecera_insignia, has_active_flows };
}

export type SetMyAgentOperationalPresenceResult = { applied: boolean; reason?: string };

/** Sincroniza el estado operativo en todas las colas donde el usuario es agente. */
export async function setMyAgentOperationalPresence(
  status: ChatAgentOperationalStatus
): Promise<SetMyAgentOperationalPresenceResult> {
  if (status !== "ready" && status !== "offline") {
    return { applied: false, reason: "Estado operativo inválido" };
  }
  const { supabase, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const ts = new Date().toISOString();

  const poolSm = getChatPostgresPool();
  if (poolSm && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    return pgSetMyAgentOperationalPresence(poolSm, dataSchema, empresa_id, usuario_id, status, ts);
  }

  let { error } = await supabase
    .from("chat_agents")
    .update({
      operational_status: status,
      updated_at: ts,
      operational_status_changed_at: ts,
      last_heartbeat_at: ts,
    })
    .eq("empresa_id", empresa_id)
    .eq("usuario_id", usuario_id);
  if (error && isMissingColumnError(error.message, "last_heartbeat_at")) {
    const r1 = await supabase
      .from("chat_agents")
      .update({
        operational_status: status,
        updated_at: ts,
        operational_status_changed_at: ts,
      })
      .eq("empresa_id", empresa_id)
      .eq("usuario_id", usuario_id);
    error = r1.error;
  }
  if (error && isMissingColumnError(error.message, "operational_status_changed_at")) {
    const r2 = await supabase
      .from("chat_agents")
      .update({ operational_status: status, updated_at: ts })
      .eq("empresa_id", empresa_id)
      .eq("usuario_id", usuario_id);
    error = r2.error;
  }
  if (error && isMissingColumnError(error.message, "operational_status")) {
    console.warn(
      "[setMyAgentOperationalPresence] columna operational_status ausente en schema tenant; update omitido."
    );
    return { applied: false, reason: "missing_operational_status_column" };
  }
  if (error) {
    console.warn("[setMyAgentOperationalPresence] update no aplicado:", error.message);
    return { applied: false, reason: error.message };
  }
  return { applied: true };
}

/** Ping de sesión inbox (monitoreo: última actividad real del agente). */
export async function touchChatAgentInboxHeartbeat(): Promise<{ ok: boolean; reason?: string }> {
  const { supabase, empresa_id, usuario_id, dataSchema } = await requireEmpresaTenantServiceRole();
  const ts = new Date().toISOString();

  const poolHb = getChatPostgresPool();
  if (poolHb && isLikelyUnexposedTenantChatSchema(dataSchema)) {
    return pgTouchChatAgentInboxHeartbeat(poolHb, dataSchema, empresa_id, usuario_id, ts);
  }

  const { error } = await supabase
    .from("chat_agents")
    .update({ last_heartbeat_at: ts, updated_at: ts })
    .eq("empresa_id", empresa_id)
    .eq("usuario_id", usuario_id);
  if (error && isMissingColumnError(error.message, "last_heartbeat_at")) {
    return { ok: false, reason: "missing_last_heartbeat_at_column" };
  }
  if (error) {
    console.warn("[touchChatAgentInboxHeartbeat]", error.message);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}
