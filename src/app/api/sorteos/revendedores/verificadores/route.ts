import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  CODIGO_VERIFICADOR_KEY,
  generarCodigoVerificador,
  readCodigoVerificador,
} from "@/lib/sorteos/revendedor-codigo-verificador";

/**
 * POST /api/sorteos/revendedores/verificadores — asigna un código verificador aleatorio
 * (4 dígitos, único por sorteo) a los revendedores del sorteo que no tienen. No pisa los existentes.
 * Body: { sorteo_id }
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sorteoId = typeof body.sorteo_id === "string" ? body.sorteo_id.trim() : "";
    if (!sorteoId) {
      return NextResponse.json(errorResponse("sorteo_id es obligatorio"), { status: 400 });
    }

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data, error } = await sb
      .from("sorteo_revendedores")
      .select("id, metadata")
      .eq("sorteo_id", sorteoId)
      .eq("empresa_id", empresaId);
    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }

    const rows = (data ?? []) as Array<{ id: string; metadata: unknown }>;
    const usados = new Set<string>();
    for (const r of rows) {
      const c = readCodigoVerificador(r.metadata);
      if (c) usados.add(c);
    }

    const asignados: { id: string; codigo_verificador: string }[] = [];
    for (const r of rows) {
      if (readCodigoVerificador(r.metadata)) continue;
      const codigo = generarCodigoVerificador(usados);
      if (!codigo) break;
      const meta =
        typeof r.metadata === "object" && r.metadata !== null && !Array.isArray(r.metadata)
          ? (r.metadata as Record<string, unknown>)
          : {};
      const { error: ue } = await sb
        .from("sorteo_revendedores")
        .update({
          metadata: { ...meta, [CODIGO_VERIFICADOR_KEY]: codigo },
          updated_at: new Date().toISOString(),
        })
        .eq("id", r.id)
        .eq("empresa_id", empresaId);
      if (ue) {
        return NextResponse.json(errorResponse(ue.message), { status: 400 });
      }
      usados.add(codigo);
      asignados.push({ id: r.id, codigo_verificador: codigo });
    }

    return NextResponse.json(successResponse({ asignados: asignados.length, detalle: asignados }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
