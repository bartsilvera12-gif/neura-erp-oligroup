import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

export const dynamic = "force-dynamic";

const MAX = 100;

/**
 * GET /api/sorteos/comprobantes-sin-boleta
 *
 * Alerta operativa: lista los comprobantes que quedaron APROBADOS
 * (valido / aprobado_manual) pero SIN boleta generada (sorteo_entrada_id NULL).
 *
 * Es el caso que vivió Sirmia: el cliente pagó en varias charlas separadas y en
 * alguna faltaban datos, así que el comprobante quedó aprobado pero el bot no
 * armó la boleta. Esta pantalla los deja a la vista para resolverlos con "Venta
 * manual" (o para avisarle al cliente), antes de que reclame.
 *
 * Además, por cada caso cuenta cuántas boletas tiene YA ese mismo número de
 * teléfono (y en qué órdenes), para distinguir los "realmente sin boleta" de los
 * que ya se resolvieron por otra venta (como las 2 viejas de Sirmia, que figuran
 * porque la boleta se creó en una venta manual aparte).
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }

    const empresaId = ctx.auth.empresa_id;
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

    const tVal = quoteSchemaTable(dataSchema, "chat_comprobante_validaciones");
    const tConv = quoteSchemaTable(dataSchema, "chat_conversations");
    const tCont = quoteSchemaTable(dataSchema, "chat_contacts");
    const tFlows = quoteSchemaTable(dataSchema, "chat_flows");
    const tSor = quoteSchemaTable(dataSchema, "sorteos");
    const tEnt = quoteSchemaTable(dataSchema, "sorteo_entradas");

    const sql = `
      SELECT
        v.id,
        v.estado_validacion,
        v.motivo_validacion,
        COALESCE(v.manual_approval_at, v.created_at) AS fecha,
        so.nombre AS sorteo_nombre,
        ct.name AS cliente_nombre,
        ct.phone_number AS telefono,
        v.conversation_id,
        COALESCE(cnt.boletas_ya, 0) AS boletas_ya,
        cnt.ordenes_ya
      FROM ${tVal} v
      LEFT JOIN ${tConv} cv ON cv.id = v.conversation_id
      LEFT JOIN ${tCont} ct ON ct.id = cv.contact_id
      LEFT JOIN LATERAL (
        SELECT cf.sorteo_id
        FROM ${tFlows} cf
        WHERE cf.empresa_id = v.empresa_id
          AND cf.flow_code = v.flow_code
          AND cf.sorteo_id IS NOT NULL
        ORDER BY cf.updated_at DESC
        LIMIT 1
      ) f ON true
      LEFT JOIN ${tSor} so ON so.id = f.sorteo_id AND so.empresa_id = v.empresa_id
      LEFT JOIN LATERAL (
        SELECT
          count(*)::int AS boletas_ya,
          string_agg(DISTINCT e2.numero_orden::text, ', ' ORDER BY e2.numero_orden::text) AS ordenes_ya
        FROM ${tEnt} e2
        WHERE e2.empresa_id = v.empresa_id
          AND ct.phone_number IS NOT NULL
          AND length(regexp_replace(ct.phone_number, '\\D', '', 'g')) >= 8
          AND right(regexp_replace(e2.whatsapp_numero, '\\D', '', 'g'), 8)
              = right(regexp_replace(ct.phone_number, '\\D', '', 'g'), 8)
      ) cnt ON true
      WHERE v.empresa_id = $1::uuid
        AND v.sorteo_entrada_id IS NULL
        AND v.estado_validacion IN ('aprobado_manual', 'valido')
      ORDER BY fecha DESC NULLS LAST
      LIMIT ${MAX}
    `;

    const res = await pool.query(sql, [empresaId]);
    const rows = (res.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      estado_validacion: String(r.estado_validacion ?? ""),
      motivo_validacion: r.motivo_validacion != null ? String(r.motivo_validacion) : null,
      fecha: r.fecha != null ? new Date(r.fecha as string).toISOString() : "",
      sorteo_nombre: r.sorteo_nombre != null ? String(r.sorteo_nombre) : null,
      cliente_nombre: r.cliente_nombre != null ? String(r.cliente_nombre) : null,
      telefono: r.telefono != null ? String(r.telefono) : null,
      conversation_id: r.conversation_id != null ? String(r.conversation_id) : null,
      boletas_ya: Number(r.boletas_ya ?? 0) || 0,
      ordenes_ya: r.ordenes_ya != null ? String(r.ordenes_ya) : null,
    }));

    return NextResponse.json(successResponse(rows));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
