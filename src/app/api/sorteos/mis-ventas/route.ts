import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

export const dynamic = "force-dynamic";

const MAX = 40;

/**
 * GET /api/sorteos/mis-ventas?q=
 *
 * Lista las ventas (órdenes) que cargó el usuario actual (revendedor/operador), para poder
 * REIMPRIMIR su boleta sin crear una venta nueva. Solo devuelve las ventas propias
 * (sorteo_entradas.validado_por_user_id = usuario actual). No requiere rol admin.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    const empresaId = ctx.auth.empresa_id;
    const usuarioId = ctx.auth.usuarioCatalogId ?? null;
    if (!usuarioId) {
      // Sin usuario de catálogo no hay "mis ventas" que atribuir.
      return NextResponse.json(successResponse([]));
    }

    const dataSchema = await fetchDataSchemaForEmpresaId(empresaId);
    const pool = getChatPostgresPool();
    if (!pool) {
      return NextResponse.json(
        errorResponse(
          "El servidor no tiene conexión directa a Postgres (SUPABASE_DB_URL / DIRECT_URL)."
        ),
        { status: 503 }
      );
    }

    const tEnt = quoteSchemaTable(dataSchema, "sorteo_entradas");
    const tSor = quoteSchemaTable(dataSchema, "sorteos");
    const tCup = quoteSchemaTable(dataSchema, "sorteo_cupones");
    const tTd = quoteSchemaTable(dataSchema, "sorteo_ticket_deliveries");

    const qRaw = (request.nextUrl.searchParams.get("q") ?? "").trim();
    const params: unknown[] = [empresaId, usuarioId];
    let whereQ = "";
    if (qRaw) {
      const term = `%${qRaw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
      params.push(term);
      whereQ = `AND (
        e.nombre_participante ILIKE $3 ESCAPE '\\'
        OR COALESCE(e.documento::text, '') ILIKE $3 ESCAPE '\\'
        OR COALESCE(e.whatsapp_numero, '') ILIKE $3 ESCAPE '\\'
        OR CAST(e.numero_orden AS text) ILIKE $3 ESCAPE '\\'
      )`;
    }

    const sql = `
      SELECT
        e.id AS entrada_id,
        e.numero_orden,
        e.sorteo_id,
        so.nombre AS sorteo_nombre,
        so.precio_por_boleto,
        e.nombre_participante,
        e.documento,
        e.whatsapp_numero,
        e.ciudad,
        e.monto_total,
        e.estado_pago,
        e.created_at,
        (
          SELECT string_agg(c.numero_cupon, ',' ORDER BY c.numero_cupon)
          FROM ${tCup} c WHERE c.entrada_id = e.id AND c.empresa_id = e.empresa_id
        ) AS cupones,
        (
          SELECT td.id FROM ${tTd} td
          WHERE td.entrada_id = e.id AND td.empresa_id = e.empresa_id AND td.is_current = true
          ORDER BY td.created_at DESC LIMIT 1
        ) AS delivery_id
      FROM ${tEnt} e
      INNER JOIN ${tSor} so ON so.id = e.sorteo_id AND so.empresa_id = e.empresa_id
      WHERE e.empresa_id = $1::uuid
        AND e.validado_por_user_id = $2::uuid
        ${whereQ}
      ORDER BY e.created_at DESC NULLS LAST
      LIMIT ${MAX}
    `;

    const res = await pool.query(sql, params);
    const rows = (res.rows as Record<string, unknown>[]).map((r) => ({
      entrada_id: String(r.entrada_id),
      numero_orden: Number(r.numero_orden) || 0,
      sorteo_id: String(r.sorteo_id),
      sorteo_nombre: String(r.sorteo_nombre ?? ""),
      precio_boleto: r.precio_por_boleto != null ? Number(r.precio_por_boleto) : null,
      nombre_participante: r.nombre_participante != null ? String(r.nombre_participante) : null,
      documento: r.documento != null ? String(r.documento) : null,
      whatsapp: r.whatsapp_numero != null ? String(r.whatsapp_numero) : null,
      ciudad: r.ciudad != null ? String(r.ciudad) : null,
      monto_total: Number(r.monto_total ?? 0) || 0,
      estado_pago: String(r.estado_pago ?? ""),
      created_at: r.created_at != null ? new Date(r.created_at as string).toISOString() : "",
      cupones: r.cupones ? String(r.cupones).split(",").filter(Boolean) : [],
      delivery_id: r.delivery_id != null ? String(r.delivery_id) : null,
    }));

    return NextResponse.json(successResponse(rows));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
