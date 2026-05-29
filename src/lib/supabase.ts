import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import { isSingleClientMode, getSingleClientSchemaOrNull } from "@/lib/instance/single-client";

// Placeholders para permitir build en Vercel sin env vars; en producción debe configurar las variables.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-key";

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.warn("[Supabase] NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY no definidas. Configure las variables en Vercel.");
}

/**
 * Schema PostgREST a usar por el cliente browser.
 *
 * Resuelto en build-time (porque createBrowserClient se llama al evaluar este módulo).
 * Para que el bundle del browser quede con `triple7` en single_client, AMBAS vars deben
 * estar disponibles al BUILD: `NEXT_PUBLIC_NEURA_INSTANCE_MODE` y `NEXT_PUBLIC_NEURA_CLIENT_SCHEMA`.
 * Sin esas (solo server-side NEURA_*), el browser cae al sentinel legacy `zentra_erp`
 * y rompe RLS / queries en self-hosted.
 */
function resolveBrowserDbSchema(): string {
  if (isSingleClientMode()) {
    const s = getSingleClientSchemaOrNull();
    if (s) return s;
  }
  return SUPABASE_APP_SCHEMA;
}

/** Cliente Supabase que persiste la sesión en cookies (necesario para que la API lea la sesión). */
export const supabase = createBrowserClient(supabaseUrl, supabaseKey, {
  db: { schema: resolveBrowserDbSchema() },
});

/** Cliente browser para tablas en un esquema ERP concreto (p. ej. omnicanal tenant). */
export function createBrowserClientForSchema(schema: string) {
  return createBrowserClient(supabaseUrl, supabaseKey, {
    db: { schema },
  });
}
