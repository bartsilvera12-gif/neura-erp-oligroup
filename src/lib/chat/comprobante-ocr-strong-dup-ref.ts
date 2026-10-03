/**
 * Largo mínimo del nro de comprobante/operación OCR para usarlo como bloqueo fuerte de duplicado.
 * En PY los nros de comprobante de transferencia son típicamente de 8–13 dígitos (ej. Basa = 10).
 * Umbral en 8: atrapa referencias reales sin confundir tokens cortos/genéricos (que además caen por blocklist).
 */
export const MIN_OCR_REF_LENGTH_FOR_STRONG_DUPLICATE = 8;

const OCR_REF_STRONG_BLOCKLIST = new Set(
  [
    "CONCEPTO",
    "VOLVER",
    "INICIO",
    "MENU",
    "PAGAR",
    "CANCELAR",
    "CONTINUAR",
    "ACEPTAR",
    "TRANSFERENCIA",
    "OPERACION",
    "OPERACIÓN",
    "COMPROBANTE",
    "IMPORTE",
    "MONTO",
  ].map((s) => s.toUpperCase())
);

/** Solo refs que pueden usarse para bloqueo fuerte entre sesiones. */
export function ocrReferenceUsableForStrongDuplicate(ref: string | null | undefined): string | null {
  const r = (ref ?? "").trim().toUpperCase();
  if (r.length < MIN_OCR_REF_LENGTH_FOR_STRONG_DUPLICATE) return null;
  if (OCR_REF_STRONG_BLOCKLIST.has(r)) return null;
  const compact = r.replace(/[^A-Z0-9]/g, "");
  if (compact.length > 0 && OCR_REF_STRONG_BLOCKLIST.has(compact)) return null;
  return r;
}
