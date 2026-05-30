"use server";

import { getUserAndEmpresa } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";
import { asuncionDayBoundsUtc, asuncionMonthBoundsUtc } from "@/lib/sorteos/kpis-time-bounds";
import type { Pool } from "pg";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * KPIs de ventas de sorteos (página principal, solo lectura).
 *
 * Columnas (ver `20250326000003_modulo_sorteos.sql` y migraciones posteriores):
 * - `sorteo_entradas`: empresa_id, sorteo_id, cantidad_boletos, monto_total, estado_pago, created_at
 * - `sorteo_cupones`: entrada_id, empresa_id, sorteo_id (1 fila por número de cupón)
 *
 * Boletos: COUNT de `sorteo_cupones` unido a `sorteo_entradas` creadas en la ventana (misma lógica que
 * "un boleto = un cupón"). Montos: SUM(monto_total) en `sorteo_entradas` en la ventana.
 * Excluye `estado_pago = 'rechazado'`. Sin columna de anulación en entradas: no se filtra otra.
 * Calendario: America/Asuncion (ver `kpis-time-bounds.ts`).
 */
export type SorteosVentasKpis = {
  boletosHoy: number;
  boletosMes: number;
  montoHoy: number;
  montoMes: number;
};

const LOG_ERR = "[sorteos][dashboard-summary][error]";
const LOG_DBG = "[sorteos][dashboard-summary][debug]";

function logDashboardError(empresaId: string, schema: string, err: unknown) {
  const message =
    err instanceof Error
      ? err.message.slice(0, 200)
      : String(err).slice(0, 200);
  console.error(LOG_ERR, { empresa_id: empresaId, schema, message });
}

function sumRows(
  rows: Array<{ cantidad_boletos?: number | null; monto_total?: number | string | null; estado_pago?: string | null }>
): { boletos: number; monto: number } {
  let boletos = 0;
  let monto = 0;
  for (const r of rows) {
    if ((r.estado_pago ?? "").trim() === "rechazado") continue;
    boletos += Number(r.cantidad_boletos) || 0;
    monto += Number(r.monto_total) || 0;
  }
  return { boletos, monto };
}

async function logDashboardDebug(
  pool: Pool | null,
  schema: string,
  empresaId: string,
  day: { start: string; end: string },
  month: { start: string; end: string },
  source: "pg" | "postgrest",
  kpis: SorteosVentasKpis
): Promise<void> {
  if (process.env.SORTEOS_KPIS_DEBUG?.trim() !== "1") return;
  let entradasHoy = 0;
  let entradasMes = 0;
  let cuponesHoy = 0;
  let cuponesMes = 0;
  if (pool) {
    try {
      const sch = assertAllowedChatDataSchema(schema);
      const tent = quoteSchemaTable(sch, "sorteo_entradas");
      const tcup = quoteSchemaTable(sch, "sorteo_cupones");
      const tsor = quoteSchemaTable(sch, "sorteos");
      const [eh, em, ch, cm] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::bigint AS n FROM ${tent} e
           INNER JOIN ${tsor} s ON s.id = e.sorteo_id
           WHERE e.empresa_id = $1::uuid AND s.estado IN ('activo','pausado')
           AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
           AND e.estado_pago <> 'rechazado'`,
          [empresaId, day.start, day.end]
        ),
        pool.query(
          `SELECT COUNT(*)::bigint AS n FROM ${tent} e
           INNER JOIN ${tsor} s ON s.id = e.sorteo_id
           WHERE e.empresa_id = $1::uuid AND s.estado IN ('activo','pausado')
           AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
           AND e.estado_pago <> 'rechazado'`,
          [empresaId, month.start, month.end]
        ),
        pool.query(
          `SELECT COUNT(c.id)::bigint AS n FROM ${tcup} c
           INNER JOIN ${tent} e ON e.id = c.entrada_id
           INNER JOIN ${tsor} s ON s.id = e.sorteo_id
           WHERE e.empresa_id = $1::uuid AND s.estado IN ('activo','pausado')
           AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
           AND e.estado_pago <> 'rechazado'`,
          [empresaId, day.start, day.end]
        ),
        pool.query(
          `SELECT COUNT(c.id)::bigint AS n FROM ${tcup} c
           INNER JOIN ${tent} e ON e.id = c.entrada_id
           INNER JOIN ${tsor} s ON s.id = e.sorteo_id
           WHERE e.empresa_id = $1::uuid AND s.estado IN ('activo','pausado')
           AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
           AND e.estado_pago <> 'rechazado'`,
          [empresaId, month.start, month.end]
        ),
      ]);
      entradasHoy = Number((eh.rows?.[0] as { n?: string } | undefined)?.n) || 0;
      entradasMes = Number((em.rows?.[0] as { n?: string } | undefined)?.n) || 0;
      cuponesHoy = Number((ch.rows?.[0] as { n?: string } | undefined)?.n) || 0;
      cuponesMes = Number((cm.rows?.[0] as { n?: string } | undefined)?.n) || 0;
    } catch {
      /* no ensuciar: el error ya va por LOG_ERR si la query principal falló */
    }
  }
  console.info(LOG_DBG, {
    empresa_id: empresaId,
    schema,
    source,
    day_from: day.start,
    day_to: day.end,
    month_from: month.start,
    month_to: month.end,
    entradas_hoy_count: entradasHoy,
    entradas_mes_count: entradasMes,
    cupones_hoy_count: cuponesHoy,
    cupones_mes_count: cuponesMes,
    monto_hoy: kpis.montoHoy,
    monto_mes: kpis.montoMes,
    boletos_hoy: kpis.boletosHoy,
    boletos_mes: kpis.boletosMes,
  });
}

type PgKpiRow = { boletos: string | number | null; monto: string | number | null };

async function fetchKpiWindowFromPg(
  pool: Pool,
  schema: string,
  empresaId: string,
  start: string,
  end: string
): Promise<{ boletos: number; monto: number }> {
  const sch = assertAllowedChatDataSchema(schema);
  const tent = quoteSchemaTable(sch, "sorteo_entradas");
  const tcup = quoteSchemaTable(sch, "sorteo_cupones");
  const tsor = quoteSchemaTable(sch, "sorteos");

  // KPIs operativos: solo sorteos vigentes (activo/pausado). Excluye
  // finalizado/cerrado para que las cards reflejen el sorteo en curso y no
  // sumen históricos.
  const [bRes, mRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(c.id) AS boletos
       FROM ${tcup} c
       INNER JOIN ${tent} e ON e.id = c.entrada_id
       INNER JOIN ${tsor} s ON s.id = e.sorteo_id
       WHERE e.empresa_id = $1::uuid
         AND s.estado IN ('activo','pausado')
         AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
         AND e.estado_pago <> 'rechazado'`,
      [empresaId, start, end]
    ),
    pool.query(
      `SELECT COALESCE(SUM(e.monto_total), 0) AS monto
       FROM ${tent} e
       INNER JOIN ${tsor} s ON s.id = e.sorteo_id
       WHERE e.empresa_id = $1::uuid
         AND s.estado IN ('activo','pausado')
         AND e.created_at >= $2::timestamptz AND e.created_at <= $3::timestamptz
         AND e.estado_pago <> 'rechazado'`,
      [empresaId, start, end]
    ),
  ]);

  const bRow = bRes.rows?.[0] as PgKpiRow | undefined;
  const mRow = mRes.rows?.[0] as PgKpiRow | undefined;
  const boletos = Number(bRow?.boletos) || 0;
  const monto = Number(mRow?.monto) || 0;
  return { boletos, monto };
}

export async function getSorteosVentasKpis(): Promise<SorteosVentasKpis> {
  const empty: SorteosVentasKpis = { boletosHoy: 0, boletosMes: 0, montoHoy: 0, montoMes: 0 };

  /** Misma resolución que `/api/sorteos`: `auth_user_id`, variantes de email, `ilike` (no solo `eq` email). */
  const auth = await getUserAndEmpresa(null);
  if (!auth?.empresa_id) {
    return empty;
  }

  const empresaId = auth.empresa_id;
  const schema = await fetchDataSchemaForEmpresaId(empresaId);

  const day = asuncionDayBoundsUtc();
  const month = asuncionMonthBoundsUtc();

  const pool = getChatPostgresPool();
  if (pool) {
    try {
      const [d, m] = await Promise.all([
        fetchKpiWindowFromPg(pool, schema, empresaId, day.start, day.end),
        fetchKpiWindowFromPg(pool, schema, empresaId, month.start, month.end),
      ]);
      const out: SorteosVentasKpis = {
        boletosHoy: d.boletos,
        montoHoy: d.monto,
        boletosMes: m.boletos,
        montoMes: m.monto,
      };
      void logDashboardDebug(pool, schema, empresaId, day, month, "pg", out);
      return out;
    } catch (e) {
      logDashboardError(empresaId, schema, e);
    }
  }

  try {
    const supabase = await getChatServiceClientForEmpresa(empresaId);

    // KPIs operativos: filtrar entradas a las que pertenecen a sorteos vigentes
    // (activo/pausado). Se resuelve primero la lista de IDs y luego se aplica
    // como `in('sorteo_id', ...)` para no depender de FK embebida en PostgREST.
    const activeSorteosRes = await supabase
      .from("sorteos")
      .select("id")
      .eq("empresa_id", empresaId)
      .in("estado", ["activo", "pausado"]);

    if (activeSorteosRes.error) {
      logDashboardError(empresaId, schema, activeSorteosRes.error);
      return empty;
    }

    const activeIds = (activeSorteosRes.data ?? []).map((r) => r.id as string);
    if (activeIds.length === 0) {
      void logDashboardDebug(pool, schema, empresaId, day, month, "postgrest", empty);
      return empty;
    }

    const [dayRes, monthRes] = await Promise.all([
      supabase
        .from("sorteo_entradas")
        .select("cantidad_boletos, monto_total, estado_pago")
        .eq("empresa_id", empresaId)
        .in("sorteo_id", activeIds)
        .gte("created_at", day.start)
        .lte("created_at", day.end),
      supabase
        .from("sorteo_entradas")
        .select("cantidad_boletos, monto_total, estado_pago")
        .eq("empresa_id", empresaId)
        .in("sorteo_id", activeIds)
        .gte("created_at", month.start)
        .lte("created_at", month.end),
    ]);

    if (dayRes.error || monthRes.error) {
      logDashboardError(empresaId, schema, dayRes.error ?? monthRes.error);
      return empty;
    }

    const sD = sumRows(dayRes.data ?? []);
    const sM = sumRows(monthRes.data ?? []);
    const out: SorteosVentasKpis = {
      boletosHoy: sD.boletos,
      montoHoy: sD.monto,
      boletosMes: sM.boletos,
      montoMes: sM.monto,
    };
    void logDashboardDebug(pool, schema, empresaId, day, month, "postgrest", out);
    return out;
  } catch (e) {
    logDashboardError(empresaId, schema, e);
    return empty;
  }
}
