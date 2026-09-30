import "server-only";
import crypto from "node:crypto";

/**
 * Link público corto de un ticket ya generado: `/t/<token>`.
 *
 * Existe porque la signed URL de Supabase Storage ronda los 500 caracteres (path + JWT del
 * token) y WhatsApp no le genera preview: en el chat entra como un chorizo de texto. Con este
 * link el mensaje de `wa.me` queda corto y WhatsApp renderiza la imagen inline.
 *
 * token = base64url( uuid(16 bytes) || HMAC-SHA256(uuid).slice(0, 8) ) → 32 caracteres fijos.
 *
 * - No enumerable: sin el secret del servidor no se puede forjar la firma, y el delivery_id
 *   suelto no sirve de nada.
 * - Sin migración ni escrituras: el id viaja firmado dentro del token.
 * - No expira, a propósito: es el comprobante del comprador, que lo abre cuando quiere. Lo que
 *   sí expira es la signed URL que el endpoint genera de nuevo en cada visita.
 */
function secret(): string {
  const s =
    process.env.SORTEO_TICKET_LINK_SECRET?.trim() ||
    process.env.REVENDEDOR_REPORT_SECRET?.trim() ||
    process.env.SIFEN_SECRETS_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (!s) throw new Error("Sin secret para firmar el link público del ticket");
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIG_BYTES = 8;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBuffer(input: string): Buffer | null {
  const clean = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = clean.length % 4 === 0 ? "" : "=".repeat(4 - (clean.length % 4));
  try {
    return Buffer.from(clean + pad, "base64");
  } catch {
    return null;
  }
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(buf: Buffer): string {
  const h = buf.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function sigFor(deliveryId: string): Buffer {
  return crypto
    .createHmac("sha256", secret())
    .update(deliveryId.toLowerCase())
    .digest()
    .subarray(0, SIG_BYTES);
}

/** Token firmado (32 chars) para el link público del ticket. */
export function signTicketPublicToken(deliveryId: string): string {
  const id = String(deliveryId ?? "").trim().toLowerCase();
  if (!UUID_RE.test(id)) throw new Error("delivery_id inválido");
  return b64url(Buffer.concat([uuidToBytes(id), sigFor(id)]));
}

/** Devuelve el delivery_id si la firma es válida, o null. Comparación en tiempo constante. */
export function verifyTicketPublicToken(token: string): string | null {
  const raw = String(token ?? "").trim();
  if (!raw || raw.length > 64) return null;
  const buf = b64urlToBuffer(raw);
  if (!buf || buf.length !== 16 + SIG_BYTES) return null;
  const id = bytesToUuid(buf.subarray(0, 16));
  if (!UUID_RE.test(id)) return null;
  const expected = sigFor(id);
  const got = buf.subarray(16);
  if (got.length !== expected.length) return null;
  return crypto.timingSafeEqual(got, expected) ? id : null;
}

/** URL absoluta del link público, a partir de los headers de la request. */
export function ticketPublicUrl(origin: string, deliveryId: string): string {
  return `${origin.replace(/\/+$/, "")}/t/${signTicketPublicToken(deliveryId)}`;
}
