import "server-only";
import crypto from "node:crypto";

/**
 * Token firmado para el reporte público de un revendedor.
 *
 * token = base64url(revendedorId) + "." + HMAC-SHA256(revendedorId).slice(0,32)
 *
 * - No adivinable ni enumerable (necesitás el secret del servidor para forjar
 *   la firma), a diferencia del `codigo_referido` secuencial (TRIPLE70001...).
 * - No requiere migración: el id viaja firmado en el token, se verifica con
 *   HMAC y recién ahí se busca el revendedor. Nada se escribe en DB.
 * - El link no expira (es un reporte de performance del vendedor).
 */
function secret(): string {
  const s =
    process.env.REVENDEDOR_REPORT_SECRET?.trim() ||
    process.env.SIFEN_SECRETS_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (!s) throw new Error("Sin secret para firmar el reporte de revendedor");
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

function sigFor(revendedorId: string): string {
  return crypto.createHmac("sha256", secret()).update(revendedorId).digest("hex").slice(0, 32);
}

/** Genera el token firmado para el link público de reporte. */
export function signRevendedorReportToken(revendedorId: string): string {
  const id = String(revendedorId ?? "").trim();
  if (!id) throw new Error("revendedorId vacío");
  return `${b64url(id)}.${sigFor(id)}`;
}

/**
 * Verifica el token y devuelve el revendedorId si la firma es válida, o null.
 * Comparación en tiempo constante para no filtrar por timing.
 */
export function verifyRevendedorReportToken(token: string): string | null {
  const raw = String(token ?? "").trim();
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const idPart = raw.slice(0, dot);
  const sigPart = raw.slice(dot + 1);
  let id: string;
  try {
    id = b64urlDecode(idPart);
  } catch {
    return null;
  }
  if (!id) return null;
  const expected = sigFor(id);
  if (sigPart.length !== expected.length) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(sigPart), Buffer.from(expected));
  return ok ? id : null;
}
