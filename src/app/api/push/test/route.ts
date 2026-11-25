import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { sendTestPushToUser } from "@/lib/push/notify-asesor";
import { isWebPushConfigured } from "@/lib/push/web-push";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    if (!esRolAdminEmpresa(auth.rol)) {
      return NextResponse.json({ ok: false, error: "Solo el administrador" }, { status: 403 });
    }
    if (!isWebPushConfigured()) {
      return NextResponse.json({ ok: false, error: "Las claves de notificaciones no están cargadas en el servidor" }, { status: 503 });
    }
    const r = await sendTestPushToUser(auth.empresa_id, auth.user.id);
    return NextResponse.json({ ok: r.sent > 0, ...r });
  } catch (e) {
    console.error("[api/push/test]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
