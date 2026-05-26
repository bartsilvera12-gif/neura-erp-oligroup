import { resolveApiAuthContext } from "@/lib/middleware/api-auth-context";
import { createSupabaseServerClient, createSupabaseServerClientWithDbSchema } from "@/lib/supabase/server";
import { SUPABASE_APP_SCHEMA, resolveEmpresaDataSchema } from "@/lib/supabase/schema";
import { getSingleClientSchemaOrNull } from "@/lib/instance/single-client";

/** PostgREST schema de datos ERP (`empresas.data_schema` o plantilla legada). */
export async function resolveDataSchemaForCurrentUserServer(): Promise<string> {
  // En instancia single_client el schema operativo es fijo (NEURA_CLIENT_SCHEMA).
  // No hace falta consultar `empresas.data_schema` — el catálogo puede tener un
  // valor heredado del dump origen (p.ej. `erp_*_<empresa_uuid>`) que en self-hosted
  // no existe como schema, y dispararía queries a un schema fantasma.
  const singleClient = getSingleClientSchemaOrNull();
  if (singleClient) return singleClient;

  const catalog = await createSupabaseServerClient();
  const {
    data: { user },
  } = await catalog.auth.getUser();
  if (!user?.email) {
    return SUPABASE_APP_SCHEMA;
  }

  const { data: urows } = await catalog
    .from("usuarios")
    .select("empresa_id")
    .eq("email", user.email)
    .limit(1);

  const empresaId = (urows?.[0] as { empresa_id?: string } | undefined)?.empresa_id;
  if (!empresaId) {
    return SUPABASE_APP_SCHEMA;
  }

  const { data: emp } = await catalog
    .from("empresas")
    .select("data_schema")
    .eq("id", empresaId)
    .maybeSingle();

  return resolveEmpresaDataSchema((emp as { data_schema?: string | null } | null)?.data_schema);
}

/** Cliente servidor con sesión del usuario y tablas de negocio en el schema de la empresa. */
export async function createSupabaseServerClientForEmpresaData() {
  const schema = await resolveDataSchemaForCurrentUserServer();
  return createSupabaseServerClientWithDbSchema(schema);
}

/**
 * `empresa_id` del usuario autenticado.
 * Misma resolución que `/api/*` (`resolveApiAuthContext`): JWT por cookies, `usuarios` por
 * `auth_user_id` y variantes de email con service role — no solo `eq("email", ...)`.
 */
export async function getEmpresaIdForCurrentUserServer(): Promise<string | null> {
  const r = await resolveApiAuthContext(undefined);
  if (!r.ok || !r.ctx.empresa_id) return null;
  return r.ctx.empresa_id;
}
