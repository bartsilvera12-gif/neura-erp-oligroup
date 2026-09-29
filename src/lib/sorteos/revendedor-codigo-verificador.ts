/**
 * Código verificador de 4 dígitos del revendedor (identificación interna).
 * Se guarda en `sorteo_revendedores.metadata.codigo_verificador` (sin columna nueva)
 * y es único por sorteo. No interviene en el flujo del bot ni en la atribución.
 */

export const CODIGO_VERIFICADOR_KEY = "codigo_verificador";

export function isCodigoVerificadorValido(v: string): boolean {
  return /^\d{4}$/.test(v);
}

export function readCodigoVerificador(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
  const v = (metadata as Record<string, unknown>)[CODIGO_VERIFICADOR_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export const CODIGO_VERIFICADOR_ERROR = "El código verificador debe tener exactamente 4 dígitos.";
export const CODIGO_VERIFICADOR_DUPLICADO = "Ese código verificador ya lo usa otro revendedor de este sorteo.";
