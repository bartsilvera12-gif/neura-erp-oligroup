import { NextRequest, NextResponse } from "next/server";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { getSingleClientSchemaOrNull, isSingleClientMode } from "@/lib/instance/single-client";
import {
  runBucketApply,
  type BucketCode,
} from "@/lib/chat/tags/apply-bucket-runner";

/**
 * /api/cron/chat-tags-daily — endpoint protegido por CRON_SECRET para correr
 * el aplicador de etiquetas en modo controlado.
 *
 * Auth:
 *   - Authorization: Bearer <CRON_SECRET>
 *   - Sin Bearer válido → 401. No revela info.
 *
 * Parámetros (query):
 *   - bucket: compro_boleta | compro_varias | comprobante_pendiente | datos_incompletos | no_compro
 *             (si se omite, recorre los 5 buckets en orden, respetando hard cap diario)
 *   - apply: 'true' | 'false' (default 'false' → 100% READ-ONLY, dry-run)
 *   - max_batch: integer 1..500 (default 100; topes por bucket más abajo)
 *   - min_days_idle: integer 1..90 (default 7) — días mínimos sin actividad para
 *     considerar candidata. Cuando el cron es diario, conviene bajarlo a 4 para
 *     drenar conversaciones de hace varios días sin demorar más de la cuenta.
 *
 * Hard cap diario: 500 conversaciones aplicadas en total por invocación. Si se
 * supera, se corta y se devuelve `hard_cap_hit=true`.
 *
 * NO toca WhatsApp runtime, flow-engine, sorteos, tickets, campañas.
 * NO está registrado en Coolify Scheduled Task todavía — esto es manual.
 *
 * Para registrarlo en Coolify cuando se autorice:
 *   - Frequency: 0 4 * * * (diario 04:00 local)
 *   - Container: triple7-erp
 *   - Command: curl -fsS -H "Authorization: Bearer ${CRON_SECRET}" \
 *              "http://localhost:3000/api/cron/chat-tags-daily?apply=true&max_batch=200"
 */

const DEFAULT_BUCKETS: BucketCode[] = [
  "compro_boleta",
  "compro_varias",
  "datos_incompletos",
  "comprobante_pendiente",
  "no_compro",
];

const PER_BUCKET_CAPS: Record<BucketCode, number> = {
  compro_boleta: 300,
  compro_varias: 300,
  datos_incompletos: 300,
  comprobante_pendiente: 50,
  no_compro: 50,
};

const DAILY_HARD_CAP = 500;

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function isValidBucket(v: string): v is BucketCode {
  return (DEFAULT_BUCKETS as readonly string[]).includes(v);
}

export async function GET(request: NextRequest) {
  try {
    // --- AUTH: Bearer CRON_SECRET ---
    const secret = (process.env.CRON_SECRET ?? "").trim();
    const auth = (request.headers.get("authorization") ?? "").trim();
    if (!secret) {
      // Sin secret configurado no se permite ejecución (failsafe).
      return NextResponse.json(
        { ok: false, error: "cron_secret_not_configured" },
        { status: 503 }
      );
    }
    if (!auth.startsWith("Bearer ") || auth.slice("Bearer ".length).trim() !== secret) {
      return unauthorized();
    }

    // --- Single-client tenant resolution ---
    if (!isSingleClientMode()) {
      return NextResponse.json(
        { ok: false, error: "cron_disabled_in_multi_tenant" },
        { status: 400 }
      );
    }
    const dataSchemaRaw = getSingleClientSchemaOrNull();
    if (!dataSchemaRaw) {
      return NextResponse.json(
        { ok: false, error: "single_client_schema_missing" },
        { status: 500 }
      );
    }
    const schema = assertAllowedChatDataSchema(dataSchemaRaw);

    // Empresa única en single_client.
    const pool = getChatPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "pool_unavailable" }, { status: 503 });
    }
    const empQ = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM "${schema}".empresas LIMIT 1`
    );
    if ((empQ.rowCount ?? 0) === 0) {
      return NextResponse.json({ ok: false, error: "empresa_not_found" }, { status: 404 });
    }
    const empresaId = empQ.rows[0].id;

    // --- Params ---
    const url = new URL(request.url);
    const applyParam = (url.searchParams.get("apply") ?? "false").trim().toLowerCase();
    const apply = applyParam === "true" || applyParam === "1";
    const bucketParam = (url.searchParams.get("bucket") ?? "").trim().toLowerCase();
    const maxBatchRaw = parseInt(url.searchParams.get("max_batch") ?? "100", 10);
    const maxBatchRequested = Math.min(500, Math.max(1, Number.isFinite(maxBatchRaw) ? maxBatchRaw : 100));

    // min_days_idle: clamp 1..90, default 7. Si el cron pasa explícito (p. ej.
    // ?min_days_idle=4) se respeta. Se reenvía al runner como `minDaysIdle`.
    const minDaysIdleRaw = parseInt(url.searchParams.get("min_days_idle") ?? "", 10);
    const minDaysIdle = Number.isFinite(minDaysIdleRaw)
      ? Math.min(90, Math.max(1, Math.trunc(minDaysIdleRaw)))
      : 7;

    const bucketsToRun: BucketCode[] =
      bucketParam.length > 0
        ? isValidBucket(bucketParam)
          ? [bucketParam]
          : []
        : DEFAULT_BUCKETS;

    if (bucketParam && bucketsToRun.length === 0) {
      return NextResponse.json({ ok: false, error: "invalid_bucket" }, { status: 400 });
    }

    // --- Run buckets ---
    let totalApplied = 0;
    let hardCapHit = false;
    const results: Array<unknown> = [];
    for (const bucket of bucketsToRun) {
      if (apply && totalApplied >= DAILY_HARD_CAP) {
        hardCapHit = true;
        break;
      }
      const cap = PER_BUCKET_CAPS[bucket];
      const remaining = apply ? DAILY_HARD_CAP - totalApplied : DAILY_HARD_CAP;
      const maxBatch = Math.max(1, Math.min(maxBatchRequested, cap, remaining));
      const r = await runBucketApply({
        pool,
        schema,
        empresaId,
        bucket,
        maxBatch,
        apply,
        minDaysIdle,
      });
      results.push(r);
      if (apply) totalApplied += r.applied_count;
      if (apply && totalApplied >= DAILY_HARD_CAP) {
        hardCapHit = true;
        break;
      }
    }

    return NextResponse.json({
      ok: true,
      schema,
      empresa_id: empresaId,
      apply,
      min_days_idle: minDaysIdle,
      hard_cap_daily: DAILY_HARD_CAP,
      total_applied: totalApplied,
      hard_cap_hit: hardCapHit,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
