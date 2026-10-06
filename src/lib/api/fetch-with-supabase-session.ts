import { serializeUnknownError } from "@/lib/errors/serialize-unknown-error";
import { supabase } from "@/lib/supabase";

/** Margen para considerar un token "por vencer" y refrescarlo antes de usarlo. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Token de acceso vigente. En móvil el navegador suspende la pestaña y el auto-refresh de
 * supabase-js no corre, así que `getSession()` puede devolver un access_token VENCIDO; si lo
 * mandáramos tal cual, el backend responde 401 "No autenticado" aunque la sesión siga abierta.
 * Por eso refrescamos de forma PROACTIVA (una sola vez, antes de enviar) cuando está vencido o por
 * vencer. No hay reintento de la request: esto solo asegura que el token que se manda sea válido.
 */
async function resolveAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.access_token) {
    const expMs = (session.expires_at ?? 0) * 1000;
    const vencidoOPorVencer = expMs > 0 && expMs - Date.now() < EXPIRY_SKEW_MS;
    if (vencidoOPorVencer) {
      const { data } = await supabase.auth.refreshSession();
      if (data.session?.access_token) return data.session.access_token;
      // Si el refresh no devolvió token pero el actual todavía no venció del todo, usamos ese.
      if (expMs - Date.now() > 0) return session.access_token;
      return null;
    }
    return session.access_token;
  }

  // Sin sesión en memoria: intentar reconstruirla desde el refresh_token persistido.
  const { data: refreshed } = await supabase.auth.refreshSession();
  if (refreshed.session?.access_token) return refreshed.session.access_token;

  const { data: gu, error } = await supabase.auth.getUser();
  if (error || !gu.user) return null;
  const {
    data: { session: s2 },
  } = await supabase.auth.getSession();
  return s2?.access_token ?? null;
}

/**
 * fetch a rutas propias enviando el JWT de la sesión actual (localStorage); fallback cookies con
 * credentials. El token se refresca de forma proactiva en `resolveAccessToken`; la request se
 * envía UNA sola vez (sin reintento automático), para no arriesgar duplicar operaciones.
 */
export async function fetchWithSupabaseSession(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  try {
    const token = await resolveAccessToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return await fetch(input, {
      ...init,
      headers,
      credentials: init?.credentials ?? "include",
    });
  } catch (e) {
    throw new Error(`fetchWithSupabaseSession: ${serializeUnknownError(e)}`);
  }
}

/** Alias: todas las llamadas a `/api/*` autenticadas desde el browser deben usar esto (JWT localStorage). */
export const apiFetch = fetchWithSupabaseSession;
