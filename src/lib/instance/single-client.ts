/**
 * Instancia monocliente (single_client) — Triple 7 / ERPs dedicados.
 *
 * Convivencia con multi-tenant:
 *   - NEURA_INSTANCE_MODE no definido o cualquier otro valor → comportamiento legado multi-tenant.
 *   - NEURA_INSTANCE_MODE=single_client → schema operativo FIJO en process.env.NEURA_CLIENT_SCHEMA,
 *     sin resolución dinámica contra zentra_erp.empresas en hot path.
 *
 * El nombre comercial NEURA_CLIENT_NAME se usa solo para UI/branding/logs;
 * no condiciona ninguna decisión de seguridad ni de routing.
 *
 * Sobre `server-only`: estas funciones leen `process.env.NEURA_*` sin prefijo `NEXT_PUBLIC_`,
 * por lo que en el bundle de cliente quedan `undefined` y `isSingleClientMode()` retorna `false`
 * en browser. Las decisiones de routing operativo (resolución de schema, bloqueo de crear empresa,
 * allowlist estricto de módulos) viven en handlers server-side y son las únicas autoritativas.
 */

const SINGLE_CLIENT_MODE_VALUE = "single_client" as const;

export type NeuraInstanceMode = typeof SINGLE_CLIENT_MODE_VALUE | "multi_tenant";

function readMode(): NeuraInstanceMode {
  // Server: process.env.NEURA_INSTANCE_MODE (runtime).
  // Browser: process.env.NEXT_PUBLIC_NEURA_INSTANCE_MODE (Next.js inlinea NEXT_PUBLIC_* en build).
  // Sin esto el bundle del browser SIEMPRE cae al sentinel legacy (zentra_erp), rompiendo single_client.
  const raw = (
    process.env.NEURA_INSTANCE_MODE ??
    process.env.NEXT_PUBLIC_NEURA_INSTANCE_MODE ??
    ""
  ).trim().toLowerCase();
  return raw === SINGLE_CLIENT_MODE_VALUE ? SINGLE_CLIENT_MODE_VALUE : "multi_tenant";
}

export function isSingleClientMode(): boolean {
  return readMode() === SINGLE_CLIENT_MODE_VALUE;
}

export function getInstanceMode(): NeuraInstanceMode {
  return readMode();
}

/**
 * Schema operativo fijo en modo single_client. Lanza si el modo es single_client pero la env no está seteada,
 * porque cualquier fallback silencioso a otro schema corrompería datos.
 *
 * Retorna `null` si el modo es multi_tenant (el caller debe resolver dinámico).
 */
export function getSingleClientSchemaOrNull(): string | null {
  if (!isSingleClientMode()) return null;
  // Mismo fallback que readMode(): server lee NEURA_*, browser NEXT_PUBLIC_NEURA_*.
  const raw = (
    process.env.NEURA_CLIENT_SCHEMA ??
    process.env.NEXT_PUBLIC_NEURA_CLIENT_SCHEMA ??
    ""
  ).trim();
  if (raw.length === 0) {
    throw new Error(
      "[single-client] NEURA_INSTANCE_MODE=single_client pero NEURA_CLIENT_SCHEMA no está definida.",
    );
  }
  return raw;
}

/**
 * Variante asertiva: lanza si NO está en single_client. Útil en bloqueos explícitos.
 */
export function assertSingleClientSchema(): string {
  if (!isSingleClientMode()) {
    throw new Error("[single-client] assertSingleClientSchema() llamado en modo multi_tenant.");
  }
  return getSingleClientSchemaOrNull() as string;
}

/** Nombre comercial del cliente (UI/branding). Solo informativo. */
export function getSingleClientName(): string {
  const raw = (
    process.env.NEURA_CLIENT_NAME ??
    process.env.NEXT_PUBLIC_NEURA_CLIENT_NAME ??
    ""
  ).trim();
  return raw.length > 0 ? raw : "ERP";
}
