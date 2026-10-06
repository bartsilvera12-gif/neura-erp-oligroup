import { serializeUnknownError } from "@/lib/errors/serialize-unknown-error";
import { supabase } from "@/lib/supabase";

/** Margen para considerar un token "por vencer" y refrescarlo antes de usarlo. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Token de acceso vigente. En móvil el navegador suspende la pestaña y el auto-refresh de
 * supabase-js no corre, así que `getSession()` puede devolver un access_token VENCIDO; si lo
 * mandáramos tal cual, el backend responde 401 "No autenticado" aunque la sesión siga abierta.
 * Por eso acá refrescamos de forma proactiva cuando está vencido/por vencer (o si `force`).
 */
async function resolveAccessToken(force = false): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.access_token) {
    const expMs = (session.expires_at ?? 0) * 1000;
    const vencidoOPorVencer = expMs > 0 && expMs - Date.now() < EXPIRY_SKEW_MS;
    if (force || vencidoOPorVencer) {
      const { data } = await supabase.auth.refreshSession();
      if (data.session?.access_token) return data.session.access_token;
      // Si el refresh no devolvió token pero el actual todavía no venció del todo, usamos ese.
      if (!force && expMs - Date.now() > 0) return session.access_token;
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
 * credentials. Ante un 401 (token recién vencido) fuerza un refresh y reintenta UNA vez: el 401 se
 * produce antes de procesar la request, así que reintentar no duplica efectos.
 */
export async function fetchWithSupabaseSession(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  try {
    const token = await resolveAccessToken();

    const doFetch = (tok: string | null) => {
      const headers = new Headers(init?.headers);
      if (tok) headers.set("Authorization", `Bearer ${tok}`);
      else headers.delete("Authorization");
      return fetch(input, {
        ...init,
        headers,
        credentials: init?.credentials ?? "include",
      });
    };

    let res = await doFetch(token);

    if (res.status === 401 && token) {
      const fresh = await resolveAccessToken(true);
      if (fresh && fresh !== token) {
        res = await doFetch(fresh);
      }
    }

    return res;
  } catch (e) {
    throw new Error(`fetchWithSupabaseSession: ${serializeUnknownError(e)}`);
  }
}

/** Alias: todas las llamadas a `/api/*` autenticadas desde el browser deben usar esto (JWT localStorage). */
export const apiFetch = fetchWithSupabaseSession;
