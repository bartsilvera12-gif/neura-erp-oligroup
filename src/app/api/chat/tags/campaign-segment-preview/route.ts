import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { isUnsafeBucket } from "@/lib/chat/tags/phone-purchase-guard";

/**
 * Preview de segmento para campañas. READ-ONLY estricto.
 *
 * Dado un `tag_code`, devuelve:
 *  - cohorte candidato (todas las conversaciones con `current_tag_id = X`)
 *  - excluidos por compra global (phone con entrada no rechazada en cualquier conv)
 *  - excluidos por phone faltante
 *  - destinatarios seguros (set único por phone_normalized)
 *
 * REGLA OBLIGATORIA: para tags inseguros (`datos_incompletos`,
 * `comprobante_pendiente`, `no_compro`), se excluyen TODOS los phones con
 * compra global. Para tags de compra (`compro_boleta`, `compro_varias`) NO
 * se aplica el filtro de exclusión por compra — al contrario, son
 * compradores conocidos y son el target legítimo.
 *
 * NO envía mensajes. NO crea campañas. NO toca chat_conversations.
 * NO toca sorteo_entradas ni sorteo_cupones.
 */

const VALID_TAGS = new Set([
  "compro_boleta",
  "compro_varias",
  "datos_incompletos",
  "comprobante_pendiente",
  "no_compro",
]);

function maskPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const d = String(p).replace(/\D+/g, "");
  if (d.length <= 4) return d;
  return `***${d.slice(-4)}`;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const pool = getChatPostgresPool();
    if (!pool) {
      return NextResponse.json({ ok: false, error: "Pool no disponible" }, { status: 503 });
    }
    const schema = assertAllowedChatDataSchema(await fetchDataSchemaForEmpresaId(auth.empresa_id));

    const url = new URL(request.url);
    const tagCode = (url.searchParams.get("tag_code") || "").trim();
    const showSample = (url.searchParams.get("sample") || "").toLowerCase() === "true";

    if (!tagCode || !VALID_TAGS.has(tagCode)) {
      return NextResponse.json(
        { ok: false, error: `tag_code inválido. Esperado uno de: ${[...VALID_TAGS].join(", ")}` },
        { status: 400 }
      );
    }

    const convT = quoteSchemaTable(schema, "chat_conversations");
    const tagsT = quoteSchemaTable(schema, "chat_conversation_tags");
    const contactsT = quoteSchemaTable(schema, "chat_contacts");
    const entradasT = quoteSchemaTable(schema, "sorteo_entradas");

    const unsafe = isUnsafeBucket(tagCode);

    // Cohorte: conv con current_tag_id = tag
    const cohortQ = await pool.query<{
      conversation_id: string;
      contact_id: string | null;
      phone_normalized: string | null;
      phone_number: string | null;
      contact_name: string | null;
      has_purchase: boolean;
    }>(
      `WITH purchaser_phones AS (
         SELECT DISTINCT ct.phone_normalized AS phone
           FROM ${entradasT} e
           JOIN ${convT} cc ON cc.id = COALESCE(e.chat_conversation_id, e.conversacion_id)
           JOIN ${contactsT} ct ON ct.id = cc.contact_id
          WHERE e.empresa_id = $1::uuid
            AND e.estado_pago <> 'rechazado'
            AND ct.phone_normalized IS NOT NULL
            AND ct.phone_normalized <> ''
       )
       SELECT c.id::text AS conversation_id,
              ct.id::text AS contact_id,
              ct.phone_normalized,
              ct.phone_number,
              ct.name AS contact_name,
              EXISTS (SELECT 1 FROM purchaser_phones pp WHERE pp.phone = ct.phone_normalized) AS has_purchase
         FROM ${convT} c
         JOIN ${tagsT} t ON t.id = c.current_tag_id
         LEFT JOIN ${contactsT} ct ON ct.id = c.contact_id
        WHERE c.empresa_id = $1::uuid
          AND t.empresa_id = $1::uuid
          AND t.code = $2`,
      [auth.empresa_id, tagCode]
    );

    const cohort = cohortQ.rows;

    // Calcular sets
    const excludedByPurchase: typeof cohort = [];
    const excludedByMissingPhone: typeof cohort = [];
    const safeRecipientsByPhone = new Map<string, typeof cohort[number]>();

    for (const r of cohort) {
      const phone = (r.phone_normalized || "").trim();
      if (!phone) {
        excludedByMissingPhone.push(r);
        continue;
      }
      if (unsafe && r.has_purchase) {
        excludedByPurchase.push(r);
        continue;
      }
      // El primer registro por phone gana — dedupe a nivel de teléfono
      if (!safeRecipientsByPhone.has(phone)) {
        safeRecipientsByPhone.set(phone, r);
      }
    }

    const safeRecipients = [...safeRecipientsByPhone.values()];

    const sample = showSample
      ? safeRecipients.slice(0, 10).map((r) => ({
          conversation_id: r.conversation_id,
          contact_name: r.contact_name,
          phone_masked: maskPhone(r.phone_number),
        }))
      : undefined;

    const exclusionSample = showSample
      ? excludedByPurchase.slice(0, 10).map((r) => ({
          conversation_id: r.conversation_id,
          contact_name: r.contact_name,
          phone_masked: maskPhone(r.phone_number),
          reason: "compra_global",
        }))
      : undefined;

    return NextResponse.json({
      ok: true,
      tag_code: tagCode,
      tag_is_unsafe: unsafe,
      guard_version: "phone-purchase-guard-v1",
      cohort_size: cohort.length,
      excluded_by_purchase_count: excludedByPurchase.length,
      excluded_by_missing_phone_count: excludedByMissingPhone.length,
      safe_recipients_count: safeRecipients.length,
      sample_safe_recipients: sample,
      sample_excluded_by_purchase: exclusionSample,
      notes: unsafe
        ? "Segmento INSEGURO por naturaleza. Compradores globales por phone excluidos. Dedupe por phone aplicado."
        : "Segmento de compradores. No se aplica exclusión por compra (es el target).",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
