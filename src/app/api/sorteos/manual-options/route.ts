import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/sorteos/manual-options — sorteos elegibles para cargar un cupón manual.
 *
 * Existe para que la pantalla de Cupones manuales no dependa de `GET /api/sorteos`, que devuelve
 * la fila entera (`select("*")`) con boletos vendidos, máximos y último número de cupón. Un
 * operador acotado al cupón manual no necesita el volumen de ventas, y ocultarlo en la UI no
 * alcanza: viajaba igual por la red.
 *
 * Devuelve solo `id` y `nombre`, y solo de sorteos activos, que son los únicos que la transacción
 * de venta manual acepta (`createSorteoManualCashSaleViaDirectPostgres` hace ROLLBACK con "El
 * sorteo no está activo").
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data, error } = await sb
      .from("sorteos")
      .select("id, nombre, estado, precio_por_boleto")
      .eq("empresa_id", empresaId)
      .eq("estado", "activo")
      .order("created_at", { ascending: false });

    if (error) {
      /** Log con contexto: sin esto, en producción solo se ve "no se pudieron cargar". */
      console.error("[sorteos][manual-options][error]", {
        empresa_id: empresaId,
        message: error.message,
        code: (error as { code?: string }).code ?? null,
      });
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    const rows = (
      (data ?? []) as Array<{
        id?: unknown;
        nombre?: unknown;
        estado?: unknown;
        precio_por_boleto?: unknown;
      }>
    ).map((r) => ({
      id: String(r.id ?? ""),
      nombre: String(r.nombre ?? ""),
      estado: String(r.estado ?? "activo"),
      precio_por_boleto: r.precio_por_boleto != null ? Number(r.precio_por_boleto) : null,
    }));

    return NextResponse.json(successResponse(rows.filter((r) => r.id.length > 0)));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
