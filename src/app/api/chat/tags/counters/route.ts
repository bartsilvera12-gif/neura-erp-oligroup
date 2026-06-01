import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Etiquetas Automáticas — endpoint READ-ONLY de contadores agregados.
 *
 * En modo shadow (Triple 7 FASE 1), `current_tag_id` y `hidden_by_tag` son NULL
 * para todas las conversaciones, por lo que `applied_count` y `hidden_count`
 * darán 0. El endpoint igual responde 200 con todas las etiquetas listadas y
 * los conteos en 0 para que el sidebar/UI los rendere sin crashear.
 *
 * También devuelve `dry_run_last24h_count` por etiqueta: cuántas filas de
 * dry_run aparecen en `chat_conversation_tag_history` en las últimas 24h. Eso
 * permite a la UI mostrar "qué dice el shadow" sin tocar conversaciones.
 *
 * NO modifica nada.
 */

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

    // Listado de etiquetas + contadores
    const rows = await pool.query(
      `WITH tags AS (
         SELECT id, code, label, color, sort_order, is_active, is_system
           FROM "${schema}".chat_conversation_tags
          WHERE empresa_id = $1::uuid
       ),
       applied AS (
         SELECT current_tag_id AS tag_id, COUNT(*)::int AS n
           FROM "${schema}".chat_conversations
          WHERE empresa_id = $1::uuid AND current_tag_id IS NOT NULL
          GROUP BY current_tag_id
       ),
       hidden AS (
         SELECT current_tag_id AS tag_id, COUNT(*)::int AS n
           FROM "${schema}".chat_conversations
          WHERE empresa_id = $1::uuid
            AND current_tag_id IS NOT NULL
            AND COALESCE(hidden_by_tag, false) = true
          GROUP BY current_tag_id
       ),
       dryrun AS (
         SELECT new_tag_id AS tag_id, COUNT(*)::int AS n
           FROM "${schema}".chat_conversation_tag_history
          WHERE empresa_id = $1::uuid
            AND action = 'dry_run'
            AND created_at >= now() - interval '24 hours'
          GROUP BY new_tag_id
       )
       SELECT t.id::text AS tag_id, t.code, t.label, t.color, t.sort_order, t.is_active, t.is_system,
              COALESCE(a.n, 0) AS applied_count,
              COALESCE(h.n, 0) AS hidden_count,
              COALESCE(d.n, 0) AS dry_run_last24h_count
         FROM tags t
         LEFT JOIN applied a ON a.tag_id = t.id
         LEFT JOIN hidden  h ON h.tag_id = t.id
         LEFT JOIN dryrun  d ON d.tag_id = t.id
        ORDER BY t.sort_order ASC NULLS LAST, t.code ASC`,
      [auth.empresa_id]
    );

    const tags = rows.rows.map((r) => ({
      tag_id: String(r.tag_id),
      code: String(r.code),
      label: String(r.label),
      color: r.color ?? null,
      sort_order: Number(r.sort_order) || 0,
      is_active: Boolean(r.is_active),
      is_system: Boolean(r.is_system),
      applied_count: Number(r.applied_count) || 0,
      hidden_count: Number(r.hidden_count) || 0,
      dry_run_last24h_count: Number(r.dry_run_last24h_count) || 0,
    }));

    const totals = {
      tags: tags.length,
      applied: tags.reduce((s, t) => s + t.applied_count, 0),
      hidden: tags.reduce((s, t) => s + t.hidden_count, 0),
      dry_run_last24h: tags.reduce((s, t) => s + t.dry_run_last24h_count, 0),
    };

    return NextResponse.json({ ok: true, totals, tags });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
