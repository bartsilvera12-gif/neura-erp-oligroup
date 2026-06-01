import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Etiquetas Automáticas — endpoint READ-ONLY que devuelve la etiqueta actual
 * de una conversación. En modo shadow (Triple 7 FASE 1), `current_tag_id` es
 * NULL para todas las conversaciones; este endpoint igual responde 200 con
 * `current=null` para que la UI pueda mostrar el estado sin crashear.
 *
 * También devuelve `suggested_category` calculada por `chat_tag_purchase_category`
 * para que la UI muestre "qué etiqueta tendría hoy según las reglas".
 *
 * NO modifica nada.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v.trim());
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
    const convId = (url.searchParams.get("conversation_id") || "").trim();
    if (!convId || !isUuid(convId)) {
      return NextResponse.json({ ok: false, error: "conversation_id inválido" }, { status: 400 });
    }

    // Lee estado de etiqueta actual + JOIN al catálogo de tags.
    const row = await pool.query(
      `SELECT c.id::text                         AS conversation_id,
              COALESCE(c.hidden_by_tag, false)   AS hidden_by_tag,
              c.hidden_by_tag_at,
              c.hidden_by_tag_rule_id::text      AS hidden_by_tag_rule_id,
              c.last_tagged_at,
              c.tag_reactivated_at,
              c.current_tag_id::text             AS current_tag_id,
              t.code                             AS current_tag_code,
              t.label                            AS current_tag_label,
              t.color                            AS current_tag_color
         FROM "${schema}".chat_conversations c
         LEFT JOIN "${schema}".chat_conversation_tags t ON t.id = c.current_tag_id
        WHERE c.id = $1::uuid AND c.empresa_id = $2::uuid
        LIMIT 1`,
      [convId, auth.empresa_id]
    );
    if (row.rowCount === 0) {
      return NextResponse.json({ ok: false, error: "Conversación no encontrada" }, { status: 404 });
    }

    // Sugerencia en vivo según la función de clasificación (READ-ONLY).
    const cat = await pool.query(
      `SELECT "${schema}".chat_tag_purchase_category($1::uuid) AS category`,
      [convId]
    );
    const category = (cat.rows?.[0]?.category as string | null) ?? null;

    // Mapea categoría → código de etiqueta (espejo de CATEGORY_TO_TAG_CODE).
    const map: Record<string, string> = {
      purchased_once: "compro_boleta",
      purchased_multiple_tickets: "compro_varias",
      repurchased: "compro_varias", // sin tag específica para 'recomprador' en FASE 1
      payment_received_incomplete: "comprobante_pendiente",
      data_incomplete: "datos_incompletos",
      abandoned: "no_compro", // sin tag específica para 'abandonado' en FASE 1
      no_purchase: "no_compro",
      unknown: "no_compro",
    };
    const suggestedCode = category ? (map[category] ?? null) : null;

    let suggestedTag: { code: string; label: string; color: string | null } | null = null;
    if (suggestedCode) {
      const t = await pool.query(
        `SELECT code, label, color
           FROM "${schema}".chat_conversation_tags
          WHERE empresa_id = $1::uuid AND code = $2
          LIMIT 1`,
        [auth.empresa_id, suggestedCode]
      );
      if ((t.rowCount ?? 0) > 0) {
        suggestedTag = {
          code: String(t.rows[0].code),
          label: String(t.rows[0].label),
          color: t.rows[0].color ?? null,
        };
      }
    }

    const r = row.rows[0];
    return NextResponse.json({
      ok: true,
      conversation_id: r.conversation_id,
      current: r.current_tag_id
        ? {
            tag_id: r.current_tag_id,
            code: r.current_tag_code ?? null,
            label: r.current_tag_label ?? null,
            color: r.current_tag_color ?? null,
            last_tagged_at: r.last_tagged_at ?? null,
          }
        : null,
      hidden_by_tag: Boolean(r.hidden_by_tag),
      hidden_by_tag_at: r.hidden_by_tag_at ?? null,
      hidden_by_tag_rule_id: r.hidden_by_tag_rule_id ?? null,
      tag_reactivated_at: r.tag_reactivated_at ?? null,
      suggested: {
        category,
        tag: suggestedTag,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
