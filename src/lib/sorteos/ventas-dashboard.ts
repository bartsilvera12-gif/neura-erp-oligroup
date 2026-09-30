import "server-only";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";

/**
 * Datos del tablero "Sorteos" del dashboard: ventas separadas por canal.
 *
 * Canal = `sorteo_entradas.validado_por`:
 *   - `erp_manual_presencial` → carga manual desde el ERP (el vendedor presencial).
 *   - cualquier otro valor (`chat_flow`) → el bot de WhatsApp.
 *
 * Se consulta por Postgres directo (mismo pool que la venta manual) porque el schema del
 * tenant no siempre está expuesto en PostgREST, y porque son agregaciones: traer las filas
 * para sumarlas en Node no escala con el volumen de un sorteo.
 *
 * READ-ONLY. Excluye `estado_pago = 'rechazado'`, igual que los KPIs de la lista de sorteos.
 */
export type CanalVentas = {
  ventas: number;
  boletas: number;
  monto: number;
};

export type DiaCanal = {
  /** YYYY-MM-DD en calendario de Asunción. */
  dia: string;
  manual: CanalVentas;
  bot: CanalVentas;
};

export type OperadorManual = {
  usuario_id: string | null;
  nombre: string;
  ventas: number;
  boletas: number;
  monto: number;
};

export type SorteosVentasDashboard = {
  desde: string;
  hasta: string;
  sorteo_id: string | null;
  manual: CanalVentas;
  bot: CanalVentas;
  porDia: DiaCanal[];
  operadores: OperadorManual[];
};

const TZ = "America/Asuncion";
const VACIO: CanalVentas = { ventas: 0, boletas: 0, monto: 0 };

function canalDe(validadoPor: string | null | undefined): "manual" | "bot" {
  return String(validadoPor ?? "").trim() === "erp_manual_presencial" ? "manual" : "bot";
}

function acumular(acc: CanalVentas, fila: { ventas: number; boletas: number; monto: number }) {
  acc.ventas += fila.ventas;
  acc.boletas += fila.boletas;
  acc.monto += fila.monto;
}

/**
 * `desde`/`hasta` son fechas YYYY-MM-DD de calendario local; se comparan contra
 * `created_at` convertido a la zona de Asunción para que "hoy" signifique lo mismo
 * que en el resto del módulo.
 */
export async function getSorteosVentasDashboard(params: {
  schema: string;
  empresaId: string;
  desde: string;
  hasta: string;
  sorteoId?: string | null;
}): Promise<SorteosVentasDashboard> {
  const { schema, empresaId, desde, hasta } = params;
  const sorteoId = params.sorteoId?.trim() || null;

  const pool = getChatPostgresPool();
  if (!pool) {
    throw new Error(
      "El servidor no tiene configurada la conexión directa a Postgres (SUPABASE_DB_URL / DIRECT_URL)."
    );
  }

  const tEnt = quoteSchemaTable(schema, "sorteo_entradas");
  const filtros = `
      e.empresa_id = $1
      AND coalesce(e.estado_pago, '') <> 'rechazado'
      AND (e.created_at AT TIME ZONE '${TZ}')::date >= $2::date
      AND (e.created_at AT TIME ZONE '${TZ}')::date <= $3::date
      AND ($4::uuid IS NULL OR e.sorteo_id = $4::uuid)`;
  const args = [empresaId, desde, hasta, sorteoId];

  const [porDiaRes, operadoresRes] = await Promise.all([
    pool.query<{
      dia: string;
      validado_por: string | null;
      ventas: string;
      boletas: string;
      monto: string;
    }>(
      `SELECT to_char((e.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia,
              e.validado_por,
              COUNT(*)::bigint                        AS ventas,
              COALESCE(SUM(e.cantidad_boletos), 0)::bigint AS boletas,
              COALESCE(SUM(e.monto_total), 0)::numeric     AS monto
         FROM ${tEnt} e
        WHERE ${filtros}
        GROUP BY 1, 2
        ORDER BY 1`,
      args
    ),
    pool.query<{
      usuario_id: string | null;
      ventas: string;
      boletas: string;
      monto: string;
    }>(
      `SELECT e.validado_por_user_id::text AS usuario_id,
              COUNT(*)::bigint                        AS ventas,
              COALESCE(SUM(e.cantidad_boletos), 0)::bigint AS boletas,
              COALESCE(SUM(e.monto_total), 0)::numeric     AS monto
         FROM ${tEnt} e
        WHERE ${filtros}
          AND e.validado_por = 'erp_manual_presencial'
        GROUP BY 1
        ORDER BY 4 DESC`,
      args
    ),
  ]);

  const manual: CanalVentas = { ...VACIO };
  const bot: CanalVentas = { ...VACIO };
  const dias = new Map<string, DiaCanal>();

  for (const r of porDiaRes.rows) {
    const fila = {
      ventas: Number(r.ventas) || 0,
      boletas: Number(r.boletas) || 0,
      monto: Number(r.monto) || 0,
    };
    const canal = canalDe(r.validado_por);
    acumular(canal === "manual" ? manual : bot, fila);

    const actual = dias.get(r.dia) ?? { dia: r.dia, manual: { ...VACIO }, bot: { ...VACIO } };
    acumular(canal === "manual" ? actual.manual : actual.bot, fila);
    dias.set(r.dia, actual);
  }

  /**
   * Nombres de los operadores desde el catálogo de usuarios, no por JOIN: en multi-tenant
   * `usuarios` vive en otro schema que `sorteo_entradas`, así que el JOIN no siempre existe.
   */
  const ids = operadoresRes.rows
    .map((r) => (r.usuario_id ?? "").trim())
    .filter((id) => id.length > 0);
  const nombres = new Map<string, string>();
  if (ids.length > 0) {
    try {
      const catalog = createServiceRoleClient();
      const { data } = await catalog.from("usuarios").select("id, nombre, email").in("id", ids);
      for (const u of (data ?? []) as Array<{ id?: unknown; nombre?: unknown; email?: unknown }>) {
        const id = String(u.id ?? "");
        const nombre = String(u.nombre ?? "").trim() || String(u.email ?? "").trim();
        if (id) nombres.set(id, nombre);
      }
    } catch {
      /* sin nombres: se muestran como "Sin identificar" */
    }
  }

  const operadores: OperadorManual[] = operadoresRes.rows.map((r) => {
    const id = (r.usuario_id ?? "").trim() || null;
    return {
      usuario_id: id,
      nombre: (id && nombres.get(id)) || "Sin identificar",
      ventas: Number(r.ventas) || 0,
      boletas: Number(r.boletas) || 0,
      monto: Number(r.monto) || 0,
    };
  });

  return {
    desde,
    hasta,
    sorteo_id: sorteoId,
    manual,
    bot,
    porDia: [...dias.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    operadores,
  };
}
