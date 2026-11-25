import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";
import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";
import { loadVapidConfig, sendWebPush } from "@/lib/push/web-push";
import {
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
} from "@/lib/chat/comprobante-validation-types";

export type AsesorPushOrigen =
  | "comprobante"
  | "boton_asesor"
  | "palabra_clave"
  | "nodo_humano"
  | "pipeline";

const LOG = "[push-asesor]";

const MOTIVO_POR_ORIGEN: Record<AsesorPushOrigen, string> = {
  comprobante: "Problema con el comprobante de transferencia",
  boton_asesor: "Tocó “Hablar con asesor”",
  palabra_clave: "Pidió hablar con un asesor",
  nodo_humano: "El flujo lo derivó a un asesor",
  pipeline: "Comprobante no validado, pasa a revisión manual",
};

const MONTO_FIELDS = ["monto", "monto_compra", "sorteo_monto_opcion"];

/** Limpia texto para pantalla bloqueada: sin números largos (cédula, cuentas) ni cadenas muy largas. */
function sanitize(text: string, max = 90): string {
  return text
    .replace(/\d[\d.\-\s]{6,}\d/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function formatMontoGs(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits || digits.length > 12) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `Gs. ${n.toLocaleString("es-PY")}`;
}

type PushSubRow = { id: string; usuario_id: string; endpoint: string; p256dh: string; auth: string };

/** Suscripciones de los administradores activos de la empresa (el rol vendedor no recibe). */
async function loadAdminSubscriptions(
  supabase: Awaited<ReturnType<typeof getChatServiceClientForEmpresa>>,
  empresaId: string
): Promise<PushSubRow[]> {
  const { data: users } = await supabase
    .from("usuarios")
    .select("auth_user_id, rol, activo")
    .eq("empresa_id", empresaId);
  const adminAuthIds = ((users ?? []) as { auth_user_id: string | null; rol: string | null; activo: boolean | null }[])
    .filter((u) => u.auth_user_id && u.activo !== false && esRolAdminEmpresa(u.rol))
    .map((u) => u.auth_user_id as string);
  if (adminAuthIds.length === 0) return [];
  const { data: subs } = await supabase
    .from("push_suscripciones")
    .select("id, usuario_id, endpoint, p256dh, auth")
    .eq("empresa_id", empresaId)
    .in("usuario_id", adminAuthIds);
  return (subs ?? []) as PushSubRow[];
}

async function deliver(
  supabase: Awaited<ReturnType<typeof getChatServiceClientForEmpresa>>,
  subs: PushSubRow[],
  payload: Record<string, unknown>
): Promise<number> {
  let sent = 0;
  for (const s of subs) {
    const r = await sendWebPush(s, payload, { urgency: "high", ttlSeconds: 6 * 60 * 60 });
    if (r.ok) sent += 1;
    else if (r.gone) {
      await supabase.from("push_suscripciones").delete().eq("id", s.id);
    } else {
      console.warn(LOG, "envio_fallido", { status: r.status, error: r.error });
    }
  }
  return sent;
}

/**
 * Avisa a los administradores que un cliente pidió un asesor. Nunca lanza: si falla, el bot sigue.
 * Un solo aviso por pedido (clave = sesión de flujo, o ventana de 10 min si no hay sesión).
 */
export async function notifyAsesorRequested(params: {
  empresaId: string;
  conversationId: string;
  origen: AsesorPushOrigen;
  flowSessionId?: string | null;
}): Promise<void> {
  try {
    const { empresaId, conversationId, origen } = params;
    const supabase = await getChatServiceClientForEmpresa(empresaId);
    if (!(await loadVapidConfig(supabase))) return;

    const subs = await loadAdminSubscriptions(supabase, empresaId);
    if (subs.length === 0) return;

    const clave = params.flowSessionId
      ? `s:${params.flowSessionId}`
      : `t:${Math.floor(Date.now() / (10 * 60 * 1000))}`;
    const { error: dupErr } = await supabase.from("push_avisos_enviados").insert({
      empresa_id: empresaId,
      conversation_id: conversationId,
      clave,
      motivo: origen,
    });
    if (dupErr) return; // ya se avisó por este pedido (o no se pudo registrar)

    const { data: conv } = await supabase
      .from("chat_conversations")
      .select("contact_id, active_flow_session_id")
      .eq("id", conversationId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    const contactId = (conv as { contact_id?: string } | null)?.contact_id;
    let nombre = "Un cliente";
    if (contactId) {
      const { data: c } = await supabase
        .from("chat_contacts")
        .select("name")
        .eq("id", contactId)
        .eq("empresa_id", empresaId)
        .maybeSingle();
      const n = sanitize(String((c as { name?: string | null } | null)?.name ?? ""), 40);
      if (n && !/^[\d+\s…]+$/.test(n)) nombre = n;
    }

    let motivo = MOTIVO_POR_ORIGEN[origen];
    let monto: string | null = null;
    const sid = params.flowSessionId ?? (conv as { active_flow_session_id?: string | null } | null)?.active_flow_session_id;
    if (sid) {
      const { data: rows } = await supabase
        .from("chat_flow_data")
        .select("field_name, field_value, created_at")
        .eq("conversation_id", conversationId)
        .eq("flow_session_id", sid)
        .in("field_name", [...MONTO_FIELDS, SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD])
        .order("created_at", { ascending: false });
      const list = (rows ?? []) as { field_name: string; field_value: string }[];
      for (const f of MONTO_FIELDS) {
        const hit = list.find((r) => r.field_name === f);
        const m = hit ? formatMontoGs(hit.field_value) : null;
        if (m) {
          monto = m;
          break;
        }
      }
      const mot = list.find((r) => r.field_name === SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD)?.field_value;
      if (origen === "comprobante" && mot?.trim()) {
        motivo = `Comprobante: ${sanitize(mot.replace(/_/g, " "), 60)}`;
      }
    }

    const body = monto ? `${motivo} · ${monto}` : motivo;
    const sent = await deliver(supabase, subs, {
      title: `🔔 ${nombre} pide un asesor`,
      body,
      tag: `asesor-${conversationId}`,
      url: `/dashboard/conversaciones?chat=${encodeURIComponent(conversationId)}`,
    });
    console.info(LOG, "enviado", { conversationId, origen, dispositivos: sent });
  } catch (e) {
    console.warn(LOG, "error_no_bloqueante", e instanceof Error ? e.message : String(e));
  }
}

/** Notificación de prueba al propio usuario (todos sus dispositivos). */
export async function sendTestPushToUser(empresaId: string, authUserId: string): Promise<{ sent: number; total: number }> {
  const supabase = await getChatServiceClientForEmpresa(empresaId);
  if (!(await loadVapidConfig(supabase))) return { sent: 0, total: 0 };
  const { data } = await supabase
    .from("push_suscripciones")
    .select("id, usuario_id, endpoint, p256dh, auth")
    .eq("empresa_id", empresaId)
    .eq("usuario_id", authUserId);
  const subs = (data ?? []) as PushSubRow[];
  const sent = await deliver(supabase, subs, {
    title: "🔔 Notificaciones activadas",
    body: "Así vas a ver los avisos cuando un cliente pida un asesor.",
    tag: "asesor-prueba",
    url: "/dashboard/conversaciones",
  });
  return { sent, total: subs.length };
}
