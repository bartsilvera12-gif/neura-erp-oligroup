import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import { getSingleClientSchemaOrNull, isSingleClientMode } from "@/lib/instance/single-client";

/** Slug + sufijo hex de empresa (p. ej. erp_demo_audit_3b885371). */
const RE_ERP = /^erp_[a-zA-Z0-9_]+$/;
const RE_ER_UUID = /^er_[0-9a-f]{32}$/;
/** Schema canónico de instancia dedicada single_client (p. ej. "triple7"). */
const RE_SINGLE_CLIENT_SLUG = /^[a-z][a-z0-9_]{1,62}$/;

/**
 * Valida nombre de schema Postgres para interpolación segura en SQL (solo datos chat).
 */
export function assertAllowedChatDataSchema(schema: string): string {
  const s = schema.trim();
  if (!s) throw new Error("schema vacío");
  if (s === "public" || s === SUPABASE_APP_SCHEMA) return s;
  if (RE_ERP.test(s) || RE_ER_UUID.test(s)) return s;
  // single_client: el schema dedicado declarado en NEURA_CLIENT_SCHEMA es válido.
  // Aceptamos solo cuando el modo está activo y el slug coincide exactamente con la env;
  // así no se relaja la validación para multi_tenant.
  if (isSingleClientMode()) {
    const sc = getSingleClientSchemaOrNull();
    if (sc && s === sc && RE_SINGLE_CLIENT_SLUG.test(s)) return s;
  }
  throw new Error(`schema no permitido: ${s}`);
}

/** Esquema tenant donde PostgREST suele fallar si no está en "Exposed schemas". */
export function isLikelyUnexposedTenantChatSchema(schema: string): boolean {
  const s = schema.trim();
  if (!s || s === SUPABASE_APP_SCHEMA || s === "public") return false;
  return RE_ERP.test(s) || RE_ER_UUID.test(s);
}
