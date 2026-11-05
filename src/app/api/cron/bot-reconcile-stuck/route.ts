import { NextRequest, NextResponse } from "next/server";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getSingleClientSchemaOrNull, isSingleClientMode } from "@/lib/instance/single-client";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { processTextReply } from "@/lib/chat/flow-engine-service";
import type { SupabaseAdmin } from "@/lib/chat/types";

/**
 * /api/cron/bot-reconcile-stuck — "repasador" de turnos perdidos del bot.
 *
 * Por qué existe: el webhook de WhatsApp responde 200 OK temprano y corre el
 * flow-engine en segundo plano (`void flowEngine()` en
 * meta-whatsapp-webhook-handlers.ts). Si el proceso se reinicia o el flow-engine
 * tira un error JUSTO después de persistir el inbound pero antes de procesarlo,
 * el mensaje queda guardado y nunca se reintenta (el retry de Meta cae en
 * `duplicate=true`). Resultado: el cliente queda colgado a mitad de la compra
 * (caso real: Rodrigo Ledesma, trabado en "pedido_de_ciudad" tras responder la
 * ciudad). Es raro (<0.1%) pero cuesta ventas.
 *
 * Qué hace: cada pocos minutos busca conversaciones en modo bot, paradas en un
 * nodo de CAPTURA DE TEXTO, cuyo último mensaje es un texto del cliente que el
 * bot nunca procesó (no hay evento de flujo posterior a ese inbound), y
 * reinyecta ese texto por el MISMO camino (`processTextReply`). El propio
 * flow-engine ya ignora modo humano / nodos equivocados, así que es seguro.
 *
 * Es liviano: consulta acotada a los últimos 30 min, con tope de candidatos y
 * presupuesto de tiempo. El 99% de las corridas no encuentra nada.
 *
 * Alcance deliberado (v1): SOLO nodos de texto con `save_as_field` (cédula,
 * nombre, apellido, ciudad, celular...). NO reinyecta botones/listas (ahí el
 * cliente debe tocar un botón, no es un turno perdido) ni imágenes/comprobantes
 * (requieren re-descarga de media; se evalúa aparte).
 *
 * Protegido por `CRON_SECRET` vía `Authorization: Bearer`.
 *
 * Params (query):
 *   - dryRun=1     → no reinyecta; solo lista los candidatos encontrados.
 *   - max=N        → tope de candidatos por corrida (1..100, default 20).
 *   - min_age_min=N→ edad mínima del inbound sin procesar (default 2 min).
 *   - lookback_min=N→ ventana hacia atrás (default 30 min).
 *   - max_ms=N     → presupuesto de tiempo total (default 45000).
 */

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

type Candidate = {
  conversation_id: string;
  content: string;
  raw_payload: unknown;
  flow_current_node: string;
  flow_code: string;
  inbound_at: string;
};

async function handle(request: NextRequest) {
  // --- AUTH: Bearer CRON_SECRET ---
  const secret = (process.env.CRON_SECRET ?? "").trim();
  const auth = (request.headers.get("authorization") ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, error: "cron_secret_not_configured" }, { status: 503 });
  }
  if (!auth.startsWith("Bearer ") || auth.slice("Bearer ".length).trim() !== secret) {
    return unauthorized();
  }

  // --- Single-client tenant resolution ---
  if (!isSingleClientMode()) {
    return NextResponse.json({ ok: false, error: "cron_disabled_in_multi_tenant" }, { status: 400 });
  }
  const dataSchemaRaw = getSingleClientSchemaOrNull();
  if (!dataSchemaRaw) {
    return NextResponse.json({ ok: false, error: "single_client_schema_missing" }, { status: 500 });
  }
  const schema = assertAllowedChatDataSchema(dataSchemaRaw);

  const pool = getChatPostgresPool();
  if (!pool) {
    return NextResponse.json({ ok: false, error: "pool_unavailable" }, { status: 503 });
  }
  const empQ = await pool.query<{ id: string }>(`SELECT id::text AS id FROM "${schema}".empresas LIMIT 1`);
  if ((empQ.rowCount ?? 0) === 0) {
    return NextResponse.json({ ok: false, error: "empresa_not_found" }, { status: 404 });
  }
  const empresaId = empQ.rows[0].id;

  // --- Params ---
  const url = new URL(request.url);
  const dryRun = ["1", "true"].includes((url.searchParams.get("dryRun") ?? "").trim().toLowerCase());
  const maxRaw = parseInt(url.searchParams.get("max") ?? "20", 10);
  const maxCandidates = Math.min(100, Math.max(1, Number.isFinite(maxRaw) ? maxRaw : 20));
  const minAgeRaw = parseInt(url.searchParams.get("min_age_min") ?? "2", 10);
  const minAgeMin = Math.min(30, Math.max(1, Number.isFinite(minAgeRaw) ? minAgeRaw : 2));
  const lookbackRaw = parseInt(url.searchParams.get("lookback_min") ?? "30", 10);
  const lookbackMin = Math.min(180, Math.max(5, Number.isFinite(lookbackRaw) ? lookbackRaw : 30));
  const maxMsRaw = parseInt(url.searchParams.get("max_ms") ?? "45000", 10);
  const maxMs = Math.min(120000, Math.max(1000, Number.isFinite(maxMsRaw) ? maxMsRaw : 45000));

  // --- Candidatos: último mensaje = texto del cliente SIN procesar, nodo de captura de texto ---
  const sql = `
    WITH last_msg AS (
      SELECT DISTINCT ON (m.conversation_id)
             m.conversation_id, m.from_me, m.message_type, m.content, m.raw_payload, m.created_at
        FROM "${schema}".chat_messages m
       WHERE m.empresa_id = $1
         AND m.created_at >= now() - ($2 || ' minutes')::interval
       ORDER BY m.conversation_id, m.created_at DESC
    ),
    last_ev AS (
      SELECT e.conversation_id, max(e.created_at) AS last_event_at
        FROM "${schema}".chat_flow_events e
       WHERE e.empresa_id = $1
         AND e.created_at >= now() - (($2::int + 30) || ' minutes')::interval
       GROUP BY e.conversation_id
    )
    SELECT lm.conversation_id::text AS conversation_id,
           lm.content,
           lm.raw_payload,
           cv.flow_current_node,
           cv.flow_code,
           lm.created_at AS inbound_at
      FROM last_msg lm
      JOIN "${schema}".chat_conversations cv ON cv.id = lm.conversation_id
      JOIN "${schema}".chat_flow_nodes n
           ON n.empresa_id = cv.empresa_id
          AND n.flow_code = cv.flow_code
          AND n.node_code = cv.flow_current_node
          AND n.is_active = true
      LEFT JOIN last_ev le ON le.conversation_id = lm.conversation_id
     WHERE lm.from_me = false
       AND lm.message_type = 'text'
       AND coalesce(btrim(lm.content), '') <> ''
       AND cv.flow_status = 'bot'
       AND coalesce(cv.human_taken_over, false) = false
       AND cv.flow_current_node IS NOT NULL
       AND n.node_type = 'text'
       AND coalesce(btrim(n.save_as_field), '') <> ''
       AND lm.created_at < now() - ($3 || ' minutes')::interval
       AND (le.last_event_at IS NULL OR le.last_event_at < lm.created_at)
     ORDER BY lm.created_at ASC
     LIMIT $4`;

  const res = await pool.query(sql, [empresaId, String(lookbackMin), String(minAgeMin), maxCandidates]);
  const candidates: Candidate[] = res.rows.map((r: Record<string, unknown>) => ({
    conversation_id: String(r.conversation_id),
    content: String(r.content ?? ""),
    raw_payload: r.raw_payload ?? null,
    flow_current_node: String(r.flow_current_node ?? ""),
    flow_code: String(r.flow_code ?? ""),
    inbound_at: r.inbound_at != null ? new Date(r.inbound_at as string).toISOString() : "",
  }));

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      empresaId,
      found: candidates.length,
      candidates: candidates.map((c) => ({
        conversation_id: c.conversation_id,
        node: c.flow_current_node,
        inbound_at: c.inbound_at,
        preview: c.content.slice(0, 40),
      })),
    });
  }

  // --- Reinyectar cada turno perdido por el mismo camino del webhook ---
  const sb = (await getChatServiceClientForEmpresa(empresaId)) as unknown as SupabaseAdmin;
  const startedAt = Date.now();
  const results: Array<{ conversation_id: string; node: string; status: string; ok: boolean; error?: string }> = [];
  let recovered = 0;

  for (const c of candidates) {
    if (Date.now() - startedAt >= maxMs) break;
    const rawPayload =
      c.raw_payload && typeof c.raw_payload === "object" && !Array.isArray(c.raw_payload)
        ? (c.raw_payload as Record<string, unknown>)
        : { type: "text", text: { body: c.content } };
    try {
      const r = await processTextReply(sb, {
        conversationId: c.conversation_id,
        empresaId,
        textValue: c.content,
        rawPayload,
      });
      if (r.ok && (r.status === "advanced" || r.status === "captured_no_next_node")) recovered += 1;
      results.push({
        conversation_id: c.conversation_id,
        node: c.flow_current_node,
        status: r.status,
        ok: r.ok,
        error: r.error,
      });
      console.info("[cron/bot-reconcile-stuck]", "reinject", {
        conversation_id: c.conversation_id,
        node: c.flow_current_node,
        status: r.status,
        ok: r.ok,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ conversation_id: c.conversation_id, node: c.flow_current_node, status: "exception", ok: false, error: msg });
      console.error("[cron/bot-reconcile-stuck]", "reinject_exception", {
        conversation_id: c.conversation_id,
        message: msg,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    empresaId,
    elapsed_ms: Date.now() - startedAt,
    found: candidates.length,
    processed: results.length,
    recovered,
    results,
  });
}

export async function GET(request: NextRequest) {
  try {
    return await handle(request);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    return await handle(request);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
