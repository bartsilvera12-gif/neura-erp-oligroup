import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuthWithRol } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { getSorteosVentasDashboard } from "@/lib/sorteos/ventas-dashboard";

export const dynamic = "force-dynamic";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD de hoy en calendario de Asunción. */
function hoyAsuncion(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Asuncion",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function restarDias(ymd: string, dias: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/**
 * GET /api/sorteos/ventas-dashboard?desde=&hasta=&sorteo_id=
 *
 * Ventas del período separadas por canal (carga manual del ERP vs bot de WhatsApp),
 * con el desglose por operador de las manuales. Alimenta la pestaña Sorteos del dashboard.
 *
 * Solo admin de empresa o super_admin: son totales de la empresa (recaudación, volumen del
 * bot), no algo que deba ver un operador acotado al cupón manual.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuthWithRol(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const rol = (ctx.auth.rol ?? "").trim();
    if (rol !== "super_admin" && !esRolAdminEmpresa(rol)) {
      return NextResponse.json(errorResponse("No autorizado"), { status: 403 });
    }

    const url = new URL(request.url);
    const hoy = hoyAsuncion();
    const hastaRaw = (url.searchParams.get("hasta") ?? "").trim();
    const desdeRaw = (url.searchParams.get("desde") ?? "").trim();
    const hasta = YMD.test(hastaRaw) ? hastaRaw : hoy;
    const desde = YMD.test(desdeRaw) ? desdeRaw : restarDias(hasta, 29);
    if (desde > hasta) {
      return NextResponse.json(errorResponse("El rango de fechas está invertido."), { status: 400 });
    }
    const sorteoId = (url.searchParams.get("sorteo_id") ?? "").trim() || null;

    const empresaId = ctx.auth.empresa_id;
    const schema = await fetchDataSchemaForEmpresaId(empresaId);

    const data = await getSorteosVentasDashboard({
      schema,
      empresaId,
      desde,
      hasta,
      sorteoId,
    });

    return NextResponse.json(successResponse(data));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
