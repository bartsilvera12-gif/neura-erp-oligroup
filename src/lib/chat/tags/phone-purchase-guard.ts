import "server-only";
import type { Pool } from "pg";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

/**
 * Etiquetas — guardia anti-falsos-negativos para campañas.
 *
 * Define cuándo un `phone_normalized` se considera COMPRADOR para efectos de
 * exclusión en campañas dirigidas a "no compra / datos incompletos /
 * comprobante pendiente".
 *
 * Fuente fuerte y única: existe al menos una fila en `sorteo_entradas` con
 * `estado_pago <> 'rechazado'` ligada (via `chat_conversation_id` o legacy
 * `conversacion_id`) a una `chat_conversations` cuyo `contact.phone_normalized`
 * coincide.
 *
 * NO se usa `visited_purchase_node` ni `numero_orden` en flow_data como
 * evidencia de COMPRA REAL para este guard — pueden indicar avance del flujo
 * pero no transacción finalizada. La regla para campañas: ante la duda,
 * EXCLUIR; no enviar mensaje a un cliente que ya compró.
 *
 * READ-ONLY: el helper sólo SELECT. NO modifica nada.
 */

export type PhonePurchaseSet = Set<string>;

/**
 * Devuelve el set de `phone_normalized` que tienen al menos una compra fuerte
 * (entrada no rechazada). Una sola query agregada — barata y cacheada por
 * llamada.
 */
export async function getPhonesWithPurchaseEvidence(
  pool: Pool,
  schema: string,
  empresaId: string
): Promise<PhonePurchaseSet> {
  const sch = assertAllowedChatDataSchema(schema);
  const tent = quoteSchemaTable(sch, "sorteo_entradas");
  const tcon = quoteSchemaTable(sch, "chat_conversations");
  const tcnt = quoteSchemaTable(sch, "chat_contacts");
  // UNION ALL para cubrir ambas columnas FK conv (chat_conversation_id moderno
  // y conversacion_id legacy). DISTINCT garantiza set único.
  const q = `
    SELECT DISTINCT phone FROM (
      SELECT ct.phone_normalized AS phone
        FROM ${tent} e
        JOIN ${tcon} c  ON c.id = e.chat_conversation_id
        JOIN ${tcnt} ct ON ct.id = c.contact_id
       WHERE e.empresa_id = $1::uuid
         AND e.estado_pago <> 'rechazado'
         AND ct.phone_normalized IS NOT NULL
         AND ct.phone_normalized <> ''
      UNION ALL
      SELECT ct.phone_normalized AS phone
        FROM ${tent} e
        JOIN ${tcon} c  ON c.id = e.conversacion_id
        JOIN ${tcnt} ct ON ct.id = c.contact_id
       WHERE e.empresa_id = $1::uuid
         AND e.estado_pago <> 'rechazado'
         AND e.chat_conversation_id IS NULL
         AND ct.phone_normalized IS NOT NULL
         AND ct.phone_normalized <> ''
    ) x
  `;
  const r = await pool.query<{ phone: string }>(q, [empresaId]);
  return new Set(r.rows.map((row) => row.phone));
}

/**
 * Versión por lote: dado un conjunto de phones, devuelve sólo los que SÍ tienen
 * compra fuerte. Útil para preview de campañas sobre cohortes definidos.
 */
export async function filterPhonesWithPurchase(
  pool: Pool,
  schema: string,
  empresaId: string,
  phones: string[]
): Promise<PhonePurchaseSet> {
  if (phones.length === 0) return new Set();
  const sch = assertAllowedChatDataSchema(schema);
  const tent = quoteSchemaTable(sch, "sorteo_entradas");
  const tcon = quoteSchemaTable(sch, "chat_conversations");
  const tcnt = quoteSchemaTable(sch, "chat_contacts");
  const q = `
    SELECT DISTINCT ct.phone_normalized AS phone
      FROM ${tent} e
      JOIN ${tcon} c  ON c.id = COALESCE(e.chat_conversation_id, e.conversacion_id)
      JOIN ${tcnt} ct ON ct.id = c.contact_id
     WHERE e.empresa_id = $1::uuid
       AND e.estado_pago <> 'rechazado'
       AND ct.phone_normalized = ANY($2::text[])
  `;
  const r = await pool.query<{ phone: string }>(q, [empresaId, phones]);
  return new Set(r.rows.map((row) => row.phone));
}

/**
 * Indica si un `bucket` debe excluir compradores globales por phone.
 * Cualquier campaña/aplicación de estos tags es candidata a alcanzar
 * compradores por error y debe protegerse.
 */
export const UNSAFE_BUCKET_CODES = new Set<string>([
  "datos_incompletos",
  "comprobante_pendiente",
  "no_compro",
]);

export function isUnsafeBucket(bucket: string): boolean {
  return UNSAFE_BUCKET_CODES.has(bucket);
}
