import { NextRequest, NextResponse } from "next/server";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { getSingleClientSchemaOrNull, isSingleClientMode } from "@/lib/instance/single-client";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { verifyRevendedorReportToken } from "@/lib/sorteos/revendedor-report-token";

/**
 * GET /api/r/reporte/[token] — reporte PÚBLICO de un revendedor (sin sesión).
 *
 * Verifica la firma del token → revendedorId, y devuelve SOLO las métricas de
 * ese vendedor + el listado de SUS ventas ANONIMIZADAS (sin teléfono ni nombre
 * del comprador). READ-ONLY. No permite enumerar otros revendedores.
 */
const VALID_STATES = ["confirmado", "pendiente_revision"];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const revendedorId = verifyRevendedorReportToken(token);
    if (!revendedorId) {
      return NextResponse.json({ ok: false, error: "token_invalido" }, { status: 404 });
    }

    if (!isSingleClientMode()) {
      return NextResponse.json({ ok: false, error: "not_supported" }, { status: 400 });
    }
    const schemaRaw = getSingleClientSchemaOrNull();
    if (!schemaRaw) return NextResponse.json({ ok: false, error: "schema_missing" }, { status: 500 });
    const schema = assertAllowedChatDataSchema(schemaRaw);
    const pool = getChatPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "pool_unavailable" }, { status: 503 });

    const tRev = quoteSchemaTable(schema, "sorteo_revendedores");
    const tSor = quoteSchemaTable(schema, "sorteos");
    const tEnt = quoteSchemaTable(schema, "sorteo_entradas");
    const tClk = quoteSchemaTable(schema, "sorteo_revendedor_clicks");
    const tSes = quoteSchemaTable(schema, "chat_flow_sessions");

    // Revendedor + sorteo
    const rev = await pool.query<{
      id: string; nombre: string; codigo_referido: string | null; activo: boolean;
      empresa_id: string; sorteo_id: string; sorteo_nombre: string; sorteo_estado: string;
    }>(
      `SELECT rv.id::text, rv.nombre, rv.codigo_referido, rv.activo, rv.empresa_id::text,
              rv.sorteo_id::text, s.nombre AS sorteo_nombre, s.estado AS sorteo_estado
         FROM ${tRev} rv JOIN ${tSor} s ON s.id = rv.sorteo_id
        WHERE rv.id = $1::uuid LIMIT 1`,
      [revendedorId]
    );
    if (rev.rowCount === 0) {
      return NextResponse.json({ ok: false, error: "no_encontrado" }, { status: 404 });
    }
    const r = rev.rows[0];

    // Métricas + ventas anonimizadas (SIN datos del comprador)
    const [clk, ses, ent] = await Promise.all([
      pool.query<{ total: string; redeemed: string }>(
        `SELECT count(*)::text total, count(*) FILTER (WHERE redeemed_at IS NOT NULL)::text redeemed
           FROM ${tClk} WHERE empresa_id=$1::uuid AND revendedor_id=$2::uuid`,
        [r.empresa_id, r.id]
      ),
      pool.query<{ c: string }>(
        `SELECT count(*)::text c FROM ${tSes} WHERE empresa_id=$1::uuid AND revendedor_id=$2::uuid`,
        [r.empresa_id, r.id]
      ),
      pool.query<{ estado_pago: string; monto_total: string; cantidad_boletos: number; created_at: Date; numero_orden: number }>(
        `SELECT estado_pago, monto_total::text, cantidad_boletos, created_at, numero_orden
           FROM ${tEnt} WHERE empresa_id=$1::uuid AND revendedor_id=$2::uuid
          ORDER BY created_at DESC`,
        [r.empresa_id, r.id]
      ),
    ]);

    let ventas = 0, ventasPend = 0, boletos = 0, monto = 0;
    const ventasList: Array<{ orden: number | null; fecha: string; cantidad: number; monto: number; estado: string }> = [];
    for (const e of ent.rows) {
      const st = String(e.estado_pago ?? "");
      const isValid = VALID_STATES.includes(st);
      if (isValid) {
        ventas += 1;
        if (st === "pendiente_revision") ventasPend += 1;
        const m = Number(e.monto_total);
        if (Number.isFinite(m)) monto += m;
        const c = Number(e.cantidad_boletos);
        if (Number.isFinite(c) && c > 0) boletos += Math.trunc(c);
      }
      // Solo filas válidas en el listado público, anonimizadas.
      if (isValid) {
        ventasList.push({
          orden: e.numero_orden ?? null,
          fecha: e.created_at ? new Date(e.created_at).toISOString() : "",
          cantidad: Number(e.cantidad_boletos) || 0,
          monto: Number(e.monto_total) || 0,
          estado: st,
        });
      }
    }
    const clicks = Number(clk.rows[0]?.total ?? 0);

    return NextResponse.json({
      ok: true,
      revendedor: { nombre: r.nombre, codigo: r.codigo_referido, activo: r.activo },
      sorteo: { nombre: r.sorteo_nombre, estado: r.sorteo_estado },
      metricas: {
        clicks,
        clicks_redeemed: Number(clk.rows[0]?.redeemed ?? 0),
        sesiones: Number(ses.rows[0]?.c ?? 0),
        ventas,
        ventas_pendientes: ventasPend,
        boletos,
        monto,
        conversion: clicks > 0 ? ventas / clicks : 0,
      },
      ventas: ventasList,
      generado_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
