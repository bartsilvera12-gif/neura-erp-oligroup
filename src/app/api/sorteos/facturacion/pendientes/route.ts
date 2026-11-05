import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

/**
 * GET /api/sorteos/facturacion/pendientes
 * Lista las ventas de sorteo FACTURABLES: confirmadas y sin factura emitida
 * (`estado_pago = 'confirmado'` y `factura_id IS NULL`). Para la pantalla de Facturación.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getFacturasSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;

    const { data, error } = await supabase
      .from("sorteo_entradas")
      .select("id, numero_orden, nombre_participante, documento, ciudad, monto_total, cantidad_boletos, cliente_id, created_at")
      .eq("empresa_id", auth.empresa_id)
      .eq("estado_pago", "confirmado")
      .is("factura_id", null)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }
    return NextResponse.json(successResponse(data ?? []));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
