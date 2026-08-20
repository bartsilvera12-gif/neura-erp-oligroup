import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { revendedorReportSlug } from "@/lib/sorteos/revendedor-report-token";

const VALID_STATES = ["confirmado", "pendiente_revision"];

export type RevendedorResumenRow = {
  id: string;
  nombre: string;
  codigo_referido: string | null;
  telefono: string | null;
  activo: boolean;
  clicks: number;
  clicks_redeemed: number;
  sesiones: number;
  ventas: number;
  ventas_pendientes: number;
  boletos: number;
  monto: number;
  conversion: number; // ventas / clicks (0..1)
  report_slug: string;
};

/**
 * GET /api/sorteos/revendedores/resumen?sorteo_id=... — módulo Revendedores.
 * READ-ONLY. Lista los revendedores del sorteo con métricas agregadas.
 * Requiere sesión ERP (operador).
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const sorteoId = (new URL(request.url).searchParams.get("sorteo_id") ?? "").trim();
    if (!sorteoId) {
      return NextResponse.json(errorResponse("sorteo_id es obligatorio"), { status: 400 });
    }

    const sb = await getChatServiceClientForEmpresa(empresaId);

    // Revendedores del sorteo
    const { data: revRows, error: eRev } = await sb
      .from("sorteo_revendedores")
      .select("id, nombre, codigo_referido, telefono, activo")
      .eq("empresa_id", empresaId)
      .eq("sorteo_id", sorteoId)
      .order("nombre", { ascending: true });
    if (eRev) return NextResponse.json(errorResponse(eRev.message), { status: 400 });

    const revs = (revRows ?? []) as Array<{
      id: string;
      nombre: string;
      codigo_referido: string | null;
      telefono: string | null;
      activo: boolean;
    }>;

    const out: RevendedorResumenRow[] = [];
    for (const rv of revs) {
      const [clicksR, clicksRedeemedR, sesionesR, entradasR] = await Promise.all([
        sb.from("sorteo_revendedor_clicks").select("id", { count: "exact", head: true }).eq("empresa_id", empresaId).eq("revendedor_id", rv.id),
        sb.from("sorteo_revendedor_clicks").select("id", { count: "exact", head: true }).eq("empresa_id", empresaId).eq("revendedor_id", rv.id).not("redeemed_at", "is", null),
        sb.from("chat_flow_sessions").select("id", { count: "exact", head: true }).eq("empresa_id", empresaId).eq("revendedor_id", rv.id),
        sb.from("sorteo_entradas").select("estado_pago, monto_total, cantidad_boletos").eq("empresa_id", empresaId).eq("revendedor_id", rv.id),
      ]);

      let ventas = 0;
      let ventasPend = 0;
      let boletos = 0;
      let monto = 0;
      for (const e of (entradasR.data ?? []) as Array<{ estado_pago?: string; monto_total?: unknown; cantidad_boletos?: unknown }>) {
        const st = String(e.estado_pago ?? "");
        if (!VALID_STATES.includes(st)) continue;
        ventas += 1;
        if (st === "pendiente_revision") ventasPend += 1;
        const m = Number(e.monto_total);
        if (Number.isFinite(m)) monto += m;
        const c = Number(e.cantidad_boletos);
        if (Number.isFinite(c) && c > 0) boletos += Math.trunc(c);
      }
      const clicks = clicksR.count ?? 0;

      out.push({
        id: rv.id,
        nombre: rv.nombre,
        codigo_referido: rv.codigo_referido,
        telefono: rv.telefono,
        activo: rv.activo,
        clicks,
        clicks_redeemed: clicksRedeemedR.count ?? 0,
        sesiones: sesionesR.count ?? 0,
        ventas,
        ventas_pendientes: ventasPend,
        boletos,
        monto,
        conversion: clicks > 0 ? ventas / clicks : 0,
        report_slug: revendedorReportSlug(rv.id),
      });
    }

    // Orden por ventas desc para el leaderboard
    out.sort((a, b) => b.ventas - a.ventas || b.monto - a.monto);

    const totales = {
      revendedores: out.length,
      ventas: out.reduce((s, r) => s + r.ventas, 0),
      boletos: out.reduce((s, r) => s + r.boletos, 0),
      monto: out.reduce((s, r) => s + r.monto, 0),
      clicks: out.reduce((s, r) => s + r.clicks, 0),
    };

    return NextResponse.json(successResponse({ sorteo_id: sorteoId, totales, revendedores: out }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
