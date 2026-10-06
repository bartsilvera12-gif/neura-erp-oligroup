import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { fetchSorteoPrintBrandingForEmpresa } from "@/lib/sorteos/physical-coupons-print";

export const dynamic = "force-dynamic";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

/**
 * GET /api/sorteos/print-branding?sorteo_id=... — logo (data URL) + qr_url del sorteo.
 * Lo usa el ticket del cupón manual para imprimir con el mismo formato OLI que "Imprimir cupones".
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const sorteoId = (request.nextUrl.searchParams.get("sorteo_id") ?? "").trim();
    if (!sorteoId || !isUuid(sorteoId)) {
      return NextResponse.json(errorResponse("sorteo_id inválido."), { status: 400 });
    }
    const branding = await fetchSorteoPrintBrandingForEmpresa(ctx.auth.empresa_id, sorteoId);
    return NextResponse.json(successResponse(branding));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
