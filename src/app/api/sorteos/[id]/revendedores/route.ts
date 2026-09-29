import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  CODIGO_VERIFICADOR_DUPLICADO,
  CODIGO_VERIFICADOR_ERROR,
  CODIGO_VERIFICADOR_KEY,
  isCodigoVerificadorValido,
  readCodigoVerificador,
} from "@/lib/sorteos/revendedor-codigo-verificador";

/**
 * GET /api/sorteos/:id/revendedores — lista revendedores del sorteo (PG shim si tenant no expuesto).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const { id: sorteoId } = await params;

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data, error } = await sb
      .from("sorteo_revendedores")
      .select("*")
      .eq("sorteo_id", sorteoId)
      .eq("empresa_id", empresaId)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(errorResponse(error.message), { status: 400 });
    }
    return NextResponse.json(successResponse(data ?? []));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

/**
 * POST /api/sorteos/:id/revendedores — crear revendedor.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const { id: sorteoId } = await params;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const nombre = typeof body.nombre === "string" ? body.nombre.trim() : "";
    const codigo = typeof body.codigo_referido === "string" ? body.codigo_referido.trim() : "";
    const telefono =
      typeof body.telefono === "string" && body.telefono.trim() ? body.telefono.trim() : null;
    const activo = body.activo !== false;
    const codigoVerificador =
      typeof body.codigo_verificador === "string" ? body.codigo_verificador.trim() : "";

    if (!nombre) {
      return NextResponse.json(errorResponse("El nombre es obligatorio."), { status: 400 });
    }
    if (!codigo) {
      return NextResponse.json(errorResponse("El código de referido es obligatorio."), { status: 400 });
    }
    if (codigo.length > 48) {
      return NextResponse.json(errorResponse("El código no puede superar 48 caracteres."), { status: 400 });
    }
    if (!isCodigoVerificadorValido(codigoVerificador)) {
      return NextResponse.json(errorResponse(CODIGO_VERIFICADOR_ERROR), { status: 400 });
    }

    const sb = await getChatServiceClientForEmpresa(empresaId);

    const { data: sorteo, error: se } = await sb
      .from("sorteos")
      .select("id")
      .eq("id", sorteoId)
      .eq("empresa_id", empresaId)
      .maybeSingle();

    if (se) {
      return NextResponse.json(errorResponse(se.message), { status: 400 });
    }
    if (!sorteo) {
      return NextResponse.json(errorResponse("Sorteo no encontrado."), { status: 404 });
    }

    const { data: existentes, error: ee } = await sb
      .from("sorteo_revendedores")
      .select("metadata")
      .eq("sorteo_id", sorteoId)
      .eq("empresa_id", empresaId);
    if (ee) {
      return NextResponse.json(errorResponse(ee.message), { status: 400 });
    }
    if ((existentes ?? []).some((r) => readCodigoVerificador(r.metadata) === codigoVerificador)) {
      return NextResponse.json(errorResponse(CODIGO_VERIFICADOR_DUPLICADO), { status: 409 });
    }

    const { data, error } = await sb
      .from("sorteo_revendedores")
      .insert({
        empresa_id: empresaId,
        sorteo_id: sorteoId,
        nombre,
        telefono,
        codigo_referido: codigo,
        activo,
        metadata: { [CODIGO_VERIFICADOR_KEY]: codigoVerificador },
      })
      .select("*")
      .single();

    if (error) {
      const status = (error as { code?: string }).code === "23505" ? 409 : 400;
      return NextResponse.json(errorResponse(error.message), { status });
    }
    return NextResponse.json(successResponse(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
