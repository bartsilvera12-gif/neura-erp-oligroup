import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { cancelSorteoEntradaViaDirectPostgres } from "@/lib/sorteos/sorteo-entrada-cancelar-pg";
import { invalidateSorteosListCachesForEmpresa } from "@/lib/sorteos/server-queries";

export const dynamic = "force-dynamic";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

/**
 * POST /api/sorteos/cupones/[entradaId]/cancelar
 *
 * Cancela (borra) una orden de sorteo generada por error y ajusta `total_boletos_vendidos`.
 * SOLO rol administrador (o super_admin). Revendedores/vendedores → 403.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ entradaId: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const rol = (ctx.auth.rol ?? "").trim();
    if (rol !== "super_admin" && !esRolAdminEmpresa(rol)) {
      return NextResponse.json(
        errorResponse("Solo un administrador puede cancelar boletas."),
        { status: 403 }
      );
    }

    const { entradaId: rawId } = await params;
    const entradaId = typeof rawId === "string" ? rawId.trim() : "";
    if (!entradaId || !isUuid(entradaId)) {
      return NextResponse.json(errorResponse("entradaId inválido."), { status: 400 });
    }

    const empresaId = ctx.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);

    if (!getChatPostgresPool()) {
      return NextResponse.json(
        errorResponse(
          "El servidor no tiene conexión directa a Postgres (SUPABASE_DB_URL / DIRECT_URL). No se puede cancelar la boleta."
        ),
        { status: 503 }
      );
    }

    const r = await cancelSorteoEntradaViaDirectPostgres({ schema, empresaId, entradaId });
    if (!r.ok) {
      return NextResponse.json(errorResponse(r.message), { status: 400 });
    }

    invalidateSorteosListCachesForEmpresa(empresaId, schema);

    return NextResponse.json(
      successResponse({
        numero_orden: r.numeroOrden,
        cupones_cancelados: r.cuponesCancelados,
        cantidad: r.cantidad,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
