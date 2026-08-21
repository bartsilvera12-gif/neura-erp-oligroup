import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { xlsxResponseHeaders, nowStamp } from "@/lib/excel/export";
import {
  buildRevendedoresXlsx,
  buildRevendedoresPdf,
  type RevExportPayload,
  type RevExportVenta,
  type RevExportRevendedor,
} from "@/lib/sorteos/revendedores-export";

const VALID_STATES = ["confirmado", "pendiente_revision"];

/**
 * GET /api/sorteos/revendedores/export?sorteo_id=...&format=xlsx|pdf
 *
 * Reporte descargable de revendedores para el OPERADOR (sesión ERP). Incluye el
 * DETALLE de compras con datos del comprador (nombre/teléfono/documento) — a
 * diferencia del reporte público del vendedor, que va anonimizado.
 * READ-ONLY.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const url = new URL(request.url);
    const sorteoId = (url.searchParams.get("sorteo_id") ?? "").trim();
    const format = (url.searchParams.get("format") ?? "xlsx").trim().toLowerCase();
    const revendedorFilter = (url.searchParams.get("revendedor_id") ?? "").trim();
    if (!sorteoId) return NextResponse.json(errorResponse("sorteo_id es obligatorio"), { status: 400 });
    if (format !== "xlsx" && format !== "pdf") {
      return NextResponse.json(errorResponse("format debe ser xlsx o pdf"), { status: 400 });
    }

    const sb = await getChatServiceClientForEmpresa(empresaId);

    const { data: sorteoRow } = await sb
      .from("sorteos")
      .select("nombre, estado")
      .eq("id", sorteoId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const sorteoNombre = String((sorteoRow as { nombre?: string } | null)?.nombre ?? "Sorteo");
    const sorteoEstado = String((sorteoRow as { estado?: string } | null)?.estado ?? "");

    let revQuery = sb
      .from("sorteo_revendedores")
      .select("id, nombre, codigo_referido, telefono")
      .eq("empresa_id", empresaId)
      .eq("sorteo_id", sorteoId);
    if (revendedorFilter) revQuery = revQuery.eq("id", revendedorFilter);
    const { data: revRows, error: eRev } = await revQuery.order("nombre", { ascending: true });
    if (eRev) return NextResponse.json(errorResponse(eRev.message), { status: 400 });

    const revs = (revRows ?? []) as Array<{ id: string; nombre: string; codigo_referido: string | null; telefono: string | null }>;
    if (revendedorFilter && revs.length === 0) {
      return NextResponse.json(errorResponse("Revendedor no encontrado en este sorteo."), { status: 404 });
    }
    const revById = new Map(revs.map((r) => [r.id, r]));
    const revIds = revs.map((r) => r.id);

    // Entradas atribuidas a esos revendedores (con datos del comprador)
    const detalle: RevExportVenta[] = [];
    const metrics = new Map<string, { ventas: number; boletos: number; monto: number }>();
    for (const r of revs) metrics.set(r.id, { ventas: 0, boletos: 0, monto: 0 });

    if (revIds.length > 0) {
      const { data: entRows, error: eEnt } = await sb
        .from("sorteo_entradas")
        .select("revendedor_id, nombre_participante, whatsapp_numero, documento, cantidad_boletos, monto_total, estado_pago, numero_orden, created_at")
        .eq("empresa_id", empresaId)
        .eq("sorteo_id", sorteoId)
        .in("revendedor_id", revIds)
        .order("created_at", { ascending: false });
      if (eEnt) return NextResponse.json(errorResponse(eEnt.message), { status: 400 });

      for (const e of (entRows ?? []) as Array<Record<string, unknown>>) {
        const st = String(e.estado_pago ?? "");
        if (!VALID_STATES.includes(st)) continue;
        const rid = String(e.revendedor_id ?? "");
        const rv = revById.get(rid);
        const cantidad = Number(e.cantidad_boletos) || 0;
        const monto = Number(e.monto_total) || 0;
        const m = metrics.get(rid);
        if (m) {
          m.ventas += 1;
          m.boletos += cantidad;
          m.monto += monto;
        }
        detalle.push({
          vendedor: rv?.nombre ?? "(sin vendedor)",
          codigo: rv?.codigo_referido ?? null,
          orden: e.numero_orden != null ? Number(e.numero_orden) : null,
          fecha: e.created_at ? new Date(e.created_at as string).toISOString() : "",
          comprador: String(e.nombre_participante ?? ""),
          compradorTelefono: String(e.whatsapp_numero ?? ""),
          compradorDocumento: String(e.documento ?? ""),
          cantidad,
          monto,
          estado: st,
        });
      }
    }

    // Clicks por revendedor (para conversión)
    const revendedores: RevExportRevendedor[] = [];
    for (const r of revs) {
      const { count: clicks } = await sb
        .from("sorteo_revendedor_clicks")
        .select("id", { count: "exact", head: true })
        .eq("empresa_id", empresaId)
        .eq("revendedor_id", r.id);
      const m = metrics.get(r.id) ?? { ventas: 0, boletos: 0, monto: 0 };
      const c = clicks ?? 0;
      revendedores.push({
        nombre: r.nombre,
        codigo: r.codigo_referido,
        telefono: r.telefono,
        clicks: c,
        ventas: m.ventas,
        boletos: m.boletos,
        monto: m.monto,
        conversion: c > 0 ? m.ventas / c : 0,
      });
    }
    revendedores.sort((a, b) => b.ventas - a.ventas || b.monto - a.monto);

    const vendedorUnico = revendedorFilter && revs.length === 1 ? revs[0].nombre : null;
    const payload: RevExportPayload = {
      sorteoNombre,
      sorteoEstado,
      generadoISO: new Date().toISOString(),
      revendedores,
      detalle,
      vendedorUnico,
    };

    const namePart = vendedorUnico ? vendedorUnico : sorteoNombre;
    const baseName = `reporte-${namePart.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 30)}-${nowStamp()}`;

    if (format === "xlsx") {
      const buf = buildRevendedoresXlsx(payload);
      return new NextResponse(new Uint8Array(buf), { headers: xlsxResponseHeaders(baseName) });
    }
    const pdf = await buildRevendedoresPdf(payload);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${baseName.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
