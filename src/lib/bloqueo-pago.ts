/**
 * Bloqueo del ERP por falta de pago.
 *
 * Se maneja desde el sistema de Neura (sistemas.neura.com.py): en el proyecto
 * del cliente, pestaña "Acceso" o en Gestión de clientes, botón Bloquear /
 * Desbloquear. Este ERP pregunta por su propio dominio y en menos de un minuto
 * manda toda la navegación (incluido /login) a /bloqueado y la API responde 402.
 * Los webhooks (/api/webhooks/*) quedan fuera del middleware y siguen recibiendo.
 *
 * Si el sistema de Neura no responde, el ERP deja entrar (nunca se bloquea por
 * un corte nuestro) y conserva el último estado que conoció.
 *
 * `ERP_BLOQUEADO_POR_FALTA_DE_PAGO = true` fuerza el bloqueo desde el código,
 * sin depender del botón (commit + push a main + redeploy).
 */
export const ERP_BLOQUEADO_POR_FALTA_DE_PAGO = false;

export const BLOQUEO_PAGO_PATH = "/bloqueado";

export const BLOQUEO_PAGO_MENSAJE =
  "El acceso al sistema está suspendido por falta de pago. Para reactivarlo, comunicate con Neura.";

const ACCESO_URL = "https://sistemas.neura.com.py/api/public/acceso-sistema";
const VIGENCIA_MS = 60_000;
const REINTENTO_MS = 15_000;
const TIMEOUT_MS = 2_500;

type Entrada = { bloqueado: boolean; hasta: number };

const cache = new Map<string, Entrada>();
const enCurso = new Map<string, Promise<boolean>>();

function hostDe(headers: Headers): string | null {
  const raw = (headers.get("host") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  const host = raw.replace(/:\d+$/, "").replace(/^www\./, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.startsWith("[")) {
    return null;
  }
  return host;
}

async function consultar(host: string, anterior: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${ACCESO_URL}?host=${encodeURIComponent(host)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { bloqueado?: unknown };
    const bloqueado = j?.bloqueado === true;
    cache.set(host, { bloqueado, hasta: Date.now() + VIGENCIA_MS });
    return bloqueado;
  } catch {
    cache.set(host, { bloqueado: anterior, hasta: Date.now() + REINTENTO_MS });
    return anterior;
  }
}

export async function erpBloqueadoPorFaltaDePago(headers: Headers): Promise<boolean> {
  if (ERP_BLOQUEADO_POR_FALTA_DE_PAGO) return true;
  const host = hostDe(headers);
  if (!host) return false;

  const entrada = cache.get(host);
  if (entrada && entrada.hasta > Date.now()) return entrada.bloqueado;

  let pendiente = enCurso.get(host);
  if (!pendiente) {
    pendiente = consultar(host, entrada?.bloqueado ?? false).finally(() => enCurso.delete(host));
    enCurso.set(host, pendiente);
  }
  if (entrada) return entrada.bloqueado;
  return pendiente;
}
