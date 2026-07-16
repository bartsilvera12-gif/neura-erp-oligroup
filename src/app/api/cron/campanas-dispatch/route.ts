import { NextRequest, NextResponse } from "next/server";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { runCampaignProcessOnce } from "@/lib/campaigns/campaign-job-service";
import { getSingleClientSchemaOrNull, isSingleClientMode } from "@/lib/instance/single-client";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { SupabaseAdmin } from "@/lib/chat/types";

/**
 * /api/cron/campanas-dispatch — drena campañas en `status='sending'` desde el
 * servidor, SIN depender del navegador. Protegido por `CRON_SECRET` vía
 * `Authorization: Bearer`.
 *
 * Por qué existe: tras `launch` (primer lote), el resto lo drenaba el poller
 * del navegador. Si se cerraba la pestaña, la campaña quedaba pausada. Este
 * cron corre cada minuto y avanza los lotes con presupuesto de tiempo.
 *
 * El reclamo atómico en `runCampaignProcessOnce` (compare-and-swap sobre
 * `status='queued'`) garantiza que aunque el cron y una pestaña abierta corran
 * a la vez, no se dupliquen envíos.
 *
 * Params (query):
 *   - dryRun=1        → no procesa, solo reporta campañas 'sending' encontradas.
 *   - batch_size=N    → tamaño de lote (1..100, default 25).
 *   - campaign_id=... → limitar a una campaña puntual.
 *   - max_ms=N        → presupuesto de tiempo total (default 50000).
 *   - max_batches=N   → tope de lotes por invocación (default 200).
 *
 * Resolución de empresa: single_client → `getSingleClientSchemaOrNull()` +
 * `SELECT id FROM "<schema>".empresas`. NO usar el default `"neura"` de otros
 * crons (apuntaría al tenant equivocado).
 */

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

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
  const batchRaw = parseInt(url.searchParams.get("batch_size") ?? "25", 10);
  const batchSize = Math.min(100, Math.max(1, Number.isFinite(batchRaw) ? batchRaw : 25));
  const onlyCampaign = (url.searchParams.get("campaign_id") ?? "").trim();
  const maxMsRaw = parseInt(url.searchParams.get("max_ms") ?? "50000", 10);
  const maxMs = Math.min(120000, Math.max(1000, Number.isFinite(maxMsRaw) ? maxMsRaw : 50000));
  const maxBatchesRaw = parseInt(url.searchParams.get("max_batches") ?? "200", 10);
  const maxBatches = Math.min(2000, Math.max(1, Number.isFinite(maxBatchesRaw) ? maxBatchesRaw : 200));

  const sb = (await getChatServiceClientForEmpresa(empresaId)) as unknown as SupabaseAdmin;

  // --- Campañas 'sending' ---
  let campQ = sb
    .from("chat_campaigns")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("status", "sending");
  if (onlyCampaign) campQ = campQ.eq("id", onlyCampaign);
  const { data: campRows, error: campErr } = await campQ;
  if (campErr) {
    return NextResponse.json({ ok: false, error: campErr.message }, { status: 500 });
  }
  const campaignIds = (campRows ?? []).map((r) => String((r as { id: string }).id));

  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, empresaId, sending_campaigns: campaignIds });
  }

  // --- Drenar con presupuesto de tiempo ---
  const startedAt = Date.now();
  const perCampaign: Record<string, { batches: number; processed: number; remainingQueued: number; completed: boolean }> = {};
  let totalProcessed = 0;
  let totalBatches = 0;

  for (const cid of campaignIds) {
    perCampaign[cid] = { batches: 0, processed: 0, remainingQueued: 0, completed: false };
    // Drenar esta campaña mientras haya cola y quede presupuesto.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startedAt >= maxMs) break;
      if (totalBatches >= maxBatches) break;
      const res = await runCampaignProcessOnce({ supabase: sb, empresaId, campaignId: cid, batchSize });
      perCampaign[cid].batches += 1;
      perCampaign[cid].processed += res.processed;
      perCampaign[cid].remainingQueued = res.remainingQueued;
      perCampaign[cid].completed = res.campaignCompleted;
      totalProcessed += res.processed;
      totalBatches += 1;
      if (res.campaignCompleted || res.remainingQueued === 0 || res.processed === 0) break;
    }
    if (Date.now() - startedAt >= maxMs || totalBatches >= maxBatches) break;
  }

  return NextResponse.json({
    ok: true,
    empresaId,
    elapsed_ms: Date.now() - startedAt,
    total_processed: totalProcessed,
    total_batches: totalBatches,
    campaigns: perCampaign,
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
