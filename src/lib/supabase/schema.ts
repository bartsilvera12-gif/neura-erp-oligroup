import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getSingleClientSchemaOrNull,
  isSingleClientMode,
} from "@/lib/instance/single-client";

/**
 * Esquema Postgres de datos del ERP — **sentinel literal**.
 *
 * En multi_tenant: catálogo compartido (`empresas`, `usuarios`, `modulos`).
 * En single_client: NO existe en self-hosted; se mantiene el literal como sentinel
 * para que las comparaciones `dataSchema === SUPABASE_APP_SCHEMA` que distinguen
 * "schema legacy compartido" sigan funcionando en código multi-tenant heredado.
 *
 * Para el schema operativo real del cliente Supabase ver `supabaseDbSchemaOption`
 * más abajo, que resuelve `NEURA_CLIENT_SCHEMA` en single_client.
 *
 * Requiere en Supabase: Settings → API → "Exposed schemas" incluir `zentra_erp`
 * (además de lo que ya tengas para auth/storage) cuando se opere en multi_tenant.
 */
export const SUPABASE_APP_SCHEMA = "zentra_erp" as const;

/**
 * Schema PostgREST para tablas de negocio de una empresa (`clientes`, `productos`, `chat_*` en tenant, etc.).
 *
 * - Valor en `empresas.data_schema` (tras trim) → ese schema (`erp_*` u otro explícito).
 * - `null`, `undefined` o string vacío → legado: datos en plantilla compartida `zentra_erp`.
 *
 * No requiere migraciones manuales por empresa: el fallback es automático.
 */
export function resolveEmpresaDataSchema(dataSchema: string | null | undefined): string {
  const t = typeof dataSchema === "string" ? dataSchema.trim() : "";
  return t.length > 0 ? t : SUPABASE_APP_SCHEMA;
}

/**
 * Cliente Supabase con cualquier esquema PostgREST (`zentra_erp`, `erp_*`, etc.).
 * Con @supabase/supabase-js ≥2.99 los genéricos de `SupabaseClient` son varios y condicionales;
 * acotar alguno a `string` o `"public"` rompe la asignación entre instancias (p. ej. Vercel TS).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppSupabaseClient = SupabaseClient<any, any, any, any, any>;

/**
 * Resuelve el schema PostgREST default para el cliente Supabase base.
 *
 * - En single_client: `NEURA_CLIENT_SCHEMA` (catálogo + datos viven en el mismo schema dedicado).
 * - En multi_tenant (legado): `SUPABASE_APP_SCHEMA` = `zentra_erp`.
 *
 * En browser, las envs `NEURA_*` sin prefijo `NEXT_PUBLIC_` quedan `undefined` y
 * `isSingleClientMode()` retorna `false`; el bundle de cliente cae al sentinel
 * legacy, que igual se overridea con `db: { schema }` explícito en `browser-data-client.ts`.
 */
function resolveDefaultClientSchema(): string {
  if (isSingleClientMode()) {
    const s = getSingleClientSchemaOrNull();
    if (s) return s;
  }
  return SUPABASE_APP_SCHEMA;
}

export const supabaseDbSchemaOption = {
  db: { schema: resolveDefaultClientSchema() },
} as const;

/** Cliente service role estándar (API routes, webhooks, jobs). */
export const supabaseServiceRoleClientOptions = {
  auth: { autoRefreshToken: false, persistSession: false },
  ...supabaseDbSchemaOption,
} as const;
