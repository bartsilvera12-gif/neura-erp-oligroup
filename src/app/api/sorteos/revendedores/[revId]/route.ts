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
 * PATCH /api/sorteos/revendedores/:revId — actualizar revendedor (campos parciales o solo activo).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ revId: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const { revId } = await params;
    const id = revId.trim();
    if (!id) {
      return NextResponse.json(errorResponse("Revendedor inválido."), { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if ("nombre" in body) {
      if (typeof body.nombre !== "string" || !body.nombre.trim()) {
        return NextResponse.json(errorResponse("El nombre es obligatorio."), { status: 400 });
      }
      patch.nombre = body.nombre.trim();
    }
    if ("telefono" in body) {
      patch.telefono =
        typeof body.telefono === "string" && body.telefono.trim() ? body.telefono.trim() : null;
    }
    if ("codigo_referido" in body) {
      if (typeof body.codigo_referido !== "string" || !body.codigo_referido.trim()) {
        return NextResponse.json(errorResponse("El código de referido es obligatorio."), { status: 400 });
      }
      const c = body.codigo_referido.trim();
      if (c.length > 48) {
        return NextResponse.json(errorResponse("El código no puede superar 48 caracteres."), { status: 400 });
      }
      patch.codigo_referido = c;
    }
    if ("activo" in body && typeof body.activo === "boolean") {
      patch.activo = body.activo;
    }

    const codigoVerificador =
      "codigo_verificador" in body
        ? typeof body.codigo_verificador === "string"
          ? body.codigo_verificador.trim()
          : ""
        : null;
    if (codigoVerificador !== null && !isCodigoVerificadorValido(codigoVerificador)) {
      return NextResponse.json(errorResponse(CODIGO_VERIFICADOR_ERROR), { status: 400 });
    }

    if (Object.keys(patch).length === 0 && codigoVerificador === null) {
      return NextResponse.json(errorResponse("Sin cambios."), { status: 400 });
    }
    patch.updated_at = new Date().toISOString();

    const sb = await getChatServiceClientForEmpresa(empresaId);

    if (codigoVerificador !== null) {
      const { data: actual, error: ae } = await sb
        .from("sorteo_revendedores")
        .select("sorteo_id, metadata")
        .eq("id", id)
        .eq("empresa_id", empresaId)
        .maybeSingle();
      if (ae) {
        return NextResponse.json(errorResponse(ae.message), { status: 400 });
      }
      if (!actual) {
        return NextResponse.json(errorResponse("Revendedor no encontrado."), { status: 404 });
      }
      const { data: otros, error: oe } = await sb
        .from("sorteo_revendedores")
        .select("id, metadata")
        .eq("sorteo_id", actual.sorteo_id)
        .eq("empresa_id", empresaId)
        .neq("id", id);
      if (oe) {
        return NextResponse.json(errorResponse(oe.message), { status: 400 });
      }
      if ((otros ?? []).some((r) => readCodigoVerificador(r.metadata) === codigoVerificador)) {
        return NextResponse.json(errorResponse(CODIGO_VERIFICADOR_DUPLICADO), { status: 409 });
      }
      const meta =
        typeof actual.metadata === "object" && actual.metadata !== null && !Array.isArray(actual.metadata)
          ? (actual.metadata as Record<string, unknown>)
          : {};
      patch.metadata = { ...meta, [CODIGO_VERIFICADOR_KEY]: codigoVerificador };
    }
    const { data, error } = await sb
      .from("sorteo_revendedores")
      .update(patch)
      .eq("id", id)
      .eq("empresa_id", empresaId)
      .select("*")
      .maybeSingle();

    if (error) {
      const status = (error as { code?: string }).code === "23505" ? 409 : 400;
      return NextResponse.json(errorResponse(error.message), { status });
    }
    if (!data) {
      return NextResponse.json(errorResponse("Revendedor no encontrado."), { status: 404 });
    }
    return NextResponse.json(successResponse(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
