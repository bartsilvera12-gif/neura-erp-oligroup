import { createClient } from "@supabase/supabase-js";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { supabaseServiceRoleClientOptions } from "@/lib/supabase/schema";
import { ensureOmnicanalDashboardEmpresaModulos } from "@/lib/empresas/ensure-omnicanal-dashboard-empresa-modulos";
import { isSingleClientMode, getSingleClientName } from "@/lib/instance/single-client";
import { NextResponse } from "next/server";

function mensajeErrorCrearUsuarioAuth(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("already been registered") || m.includes("already registered") || m.includes("user already registered")) {
    return "Ese correo ya está registrado. Usá otro email o recuperá la contraseña desde el login.";
  }
  if (m.includes("duplicate") || m.includes("unique")) {
    return "Ese correo ya está en uso.";
  }
  return msg;
}

export async function POST(req: Request) {
  if (isSingleClientMode()) {
    return NextResponse.json(
      {
        error: "Creación de empresa deshabilitada: esta instancia opera en modo monocliente.",
        code: "SINGLE_CLIENT_MODE",
        client: getSingleClientName(),
      },
      { status: 403 },
    );
  }

  let authUserId: string | null = null;
  let empresaId: string | null = null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const cleanupFailure = async (sb: AppSupabaseClient) => {
    if (empresaId) {
      const { error: delErr } = await sb.from("empresas").delete().eq("id", empresaId);
      if (delErr) {
        await sb.rpc("neura_teardown_provision_failed" as never, { p_empresa_id: empresaId } as never);
        await sb.from("empresas").delete().eq("id", empresaId);
      }
    }
    if (authUserId) {
      try {
        await sb.auth.admin.deleteUser(authUserId);
      } catch {
        /* ya borrado o inexistente */
      }
    }
    empresaId = null;
    authUserId = null;
  };

  try {
    const body = await req.json();
    const {
      nombre_empresa,
      plan,
      ruc,
      estado,
      email,
      password,
      nombre,
      modulo_ids,
      dashboard_view_ids,
      schema_slug,
    } = body;

    if (!nombre_empresa?.trim() || !email?.trim() || !password?.trim() || !nombre?.trim()) {
      return NextResponse.json(
        { error: "nombre_empresa, email, password y nombre son requeridos" },
        { status: 400 }
      );
    }

    if (!url || !key) {
      return NextResponse.json(
        { error: "Variables de entorno no configuradas" },
        { status: 500 }
      );
    }

    const supabase = createClient(url, key, {
      ...supabaseServiceRoleClientOptions,
    }) as AppSupabaseClient;
    const emailNorm = email.trim().toLowerCase();

    const { data: dupUsuario, error: errDup } = await supabase
      .from("usuarios")
      .select("id")
      .eq("email", emailNorm)
      .maybeSingle();

    if (errDup) {
      return NextResponse.json({ error: errDup.message }, { status: 400 });
    }
    if (dupUsuario && typeof (dupUsuario as { id?: unknown }).id === "string") {
      return NextResponse.json(
        { error: "El correo ya está registrado en el ERP (tabla usuarios). No se creó empresa ni esquema." },
        { status: 409 }
      );
    }

    // 1 — Auth primero: si el correo ya existe en GoTrue, fallamos sin tocar empresa ni schema.
    const { data: authData, error: errAuth } = await supabase.auth.admin.createUser({
      email: emailNorm,
      password,
      email_confirm: true,
    });

    if (errAuth) {
      return NextResponse.json(
        { error: mensajeErrorCrearUsuarioAuth(errAuth.message) },
        { status: 400 }
      );
    }

    authUserId = authData.user?.id ?? null;
    if (!authUserId) {
      return NextResponse.json(
        { error: "No se pudo crear el usuario en autenticación (sin id)." },
        { status: 500 }
      );
    }

    // 2 — Empresa
    const { data: empresa, error: errEmpresa } = await supabase
      .from("empresas")
      .insert([
        {
          nombre_empresa: nombre_empresa.trim(),
          plan: plan?.trim() || null,
          ruc: ruc?.trim() || null,
          estado: estado || "activo",
        },
      ])
      .select("id")
      .single();

    if (errEmpresa || !empresa?.id) {
      await cleanupFailure(supabase);
      return NextResponse.json(
        { error: errEmpresa?.message ?? "No se pudo crear la empresa." },
        { status: 400 }
      );
    }

    empresaId = empresa.id;

    const slugFuente =
      typeof schema_slug === "string" && schema_slug.trim()
        ? schema_slug.trim()
        : nombre_empresa.trim();

    // 3 — Esquema tenant
    const { data: provisionJson, error: provErr } = await supabase.rpc(
      "neura_provision_empresa_data_schema",
      { p_empresa_id: empresaId, p_schema_slug: slugFuente }
    );

    if (provErr) {
      await cleanupFailure(supabase);
      return NextResponse.json(
        { error: `Provisión de esquema: ${provErr.message}` },
        { status: 500 }
      );
    }

    const prov = provisionJson as { ok?: boolean; status?: string } | null;
    if (prov && prov.ok === false) {
      await cleanupFailure(supabase);
      return NextResponse.json(
        { error: "No se pudo provisionar el esquema de datos de la empresa." },
        { status: 500 }
      );
    }

    // 4 — Fila usuarios (ERP)
    const { error: errUsuario } = await supabase.from("usuarios").insert([
      {
        empresa_id: empresaId,
        nombre: nombre.trim(),
        email: emailNorm,
        rol: "admin",
        auth_user_id: authUserId,
      },
    ]);

    if (errUsuario) {
      await cleanupFailure(supabase);
      return NextResponse.json({ error: errUsuario.message }, { status: 400 });
    }

    const moduloIds = [...new Set(Array.isArray(modulo_ids) ? modulo_ids : [])];

    const { data: emExistentes } = await supabase
      .from("empresa_modulos")
      .select("modulo_id")
      .eq("empresa_id", empresaId);
    const yaInsertados = new Set((emExistentes ?? []).map((r) => r.modulo_id as string));
    const faltan = moduloIds.filter((id) => !yaInsertados.has(id));

    if (faltan.length > 0) {
      const rows = faltan.map((modulo_id: string) => ({
        empresa_id: empresaId,
        modulo_id,
        activo: true,
      }));
      const { error: errModulos } = await supabase.from("empresa_modulos").insert(rows);
      if (errModulos) {
        await cleanupFailure(supabase);
        return NextResponse.json(
          { error: `Error al asignar módulos: ${errModulos.message}` },
          { status: 400 }
        );
      }
    }

    const ensured = await ensureOmnicanalDashboardEmpresaModulos(supabase, empresaId as string);
    if (!ensured.ok) {
      await cleanupFailure(supabase);
      return NextResponse.json({ error: ensured.error }, { status: 400 });
    }

    const dvRequested = [...new Set(Array.isArray(dashboard_view_ids) ? dashboard_view_ids : [])];
    const { data: catDv } = await supabase.from("dashboard_views").select("id").eq("activo", true);
    const catDvSet = new Set(
      (catDv ?? []).map((r) => (r as { id: string }).id).filter((x): x is string => typeof x === "string")
    );
    let dvToEnable = dvRequested.filter((x) => catDvSet.has(x));
    if (dvToEnable.length === 0 && catDvSet.size > 0) {
      dvToEnable = [...catDvSet];
    }
    if (dvToEnable.length > 0) {
      const dvRows = dvToEnable.map((dashboard_view_id: string) => ({
        empresa_id: empresaId,
        dashboard_view_id,
        activo: true,
      }));
      const { error: errDvEmp } = await supabase.from("empresa_dashboard_views").insert(dvRows);
      if (errDvEmp) {
        await cleanupFailure(supabase);
        return NextResponse.json(
          { error: `Error al asignar vistas de dashboard: ${errDvEmp.message}` },
          { status: 400 }
        );
      }
    }

    return NextResponse.json({
      empresa_id: empresaId,
      usuario_id: authUserId,
    });
  } catch (err: unknown) {
    if (url && key) {
      const sb = createClient(url, key, {
        ...supabaseServiceRoleClientOptions,
      }) as AppSupabaseClient;
      await cleanupFailure(sb);
    }
    const message = err instanceof Error ? err.message : "Error interno";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
