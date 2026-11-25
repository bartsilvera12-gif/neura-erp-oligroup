import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { loadVapidConfig } from "@/lib/push/web-push";

export const runtime = "nodejs";

/** Clave pública VAPID y si este usuario puede recibir avisos (solo administrador). */
export async function GET(request: NextRequest) {
  const auth = await getAuthWithRol(request);
  if (!auth?.empresa_id) return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
  const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
  const publicKey = (await loadVapidConfig(supabase))?.pub ?? null;
  return NextResponse.json({
    ok: true,
    configured: !!publicKey,
    publicKey,
    permitido: esRolAdminEmpresa(auth.rol),
  });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    if (!esRolAdminEmpresa(auth.rol)) {
      return NextResponse.json({ ok: false, error: "Solo el administrador recibe estos avisos" }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    const endpoint = body.endpoint?.trim() ?? "";
    const p256dh = body.keys?.p256dh?.trim() ?? "";
    const authKey = body.keys?.auth?.trim() ?? "";
    if (!endpoint.startsWith("https://") || !p256dh || !authKey) {
      return NextResponse.json({ ok: false, error: "Suscripción inválida" }, { status: 400 });
    }
    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    const now = new Date().toISOString();
    const row = {
      empresa_id: auth.empresa_id,
      usuario_id: auth.user.id,
      endpoint,
      p256dh,
      auth: authKey,
      user_agent: (request.headers.get("user-agent") ?? "").slice(0, 300),
      updated_at: now,
    };
    const { data: existing } = await supabase
      .from("push_suscripciones")
      .select("id")
      .eq("endpoint", endpoint)
      .maybeSingle();
    const { error } = existing
      ? await supabase.from("push_suscripciones").update(row).eq("id", (existing as { id: string }).id)
      : await supabase.from("push_suscripciones").insert(row);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/push/subscribe]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    const body = (await request.json().catch(() => ({}))) as { endpoint?: string };
    const endpoint = body.endpoint?.trim() ?? "";
    if (!endpoint) return NextResponse.json({ ok: false, error: "Falta endpoint" }, { status: 400 });
    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    await supabase
      .from("push_suscripciones")
      .delete()
      .eq("endpoint", endpoint)
      .eq("empresa_id", auth.empresa_id)
      .eq("usuario_id", auth.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/push/subscribe] delete", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
