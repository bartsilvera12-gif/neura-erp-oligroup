import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

/**
 * Etiquetas Automáticas — listado READ-ONLY de conversaciones realmente
 * etiquetadas (chat_conversations.current_tag_id IS NOT NULL).
 *
 * Reemplaza el uso de /api/chat/tags/snapshot para la UI: snapshot lee
 * chat_conversation_tag_history (action='dry_run' por default), pero en
 * producción los lotes aplicados generan action='applied' y el verdadero
 * estado vivo está en chat_conversations.current_tag_id.
 *
 * Filtros: tag_code, phone (partial), date_from, date_to (sobre last_message_at).
 * Paginación: limit (default 50, max 200), offset (default 0).
 *
 * NO modifica ninguna tabla. NO toca WhatsApp/Meta/webhook/flow-engine.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseIntParam(value: string | null, fallback: number, max?: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  if (max && n > max) return max;
  return n;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function maskPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = String(p).replace(/\D+/g, "");
  if (digits.length <= 4) return digits;
  return `***${digits.slice(-4)}`;
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
    const phoneRaw = (url.searchParams.get("phone") || "").replace(/\D+/g, "");
    const dateFromIso = parseDate(url.searchParams.get("date_from"));
    const dateToIso = parseDate(url.searchParams.get("date_to"));
    const limit = parseIntParam(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(0, parseIntParam(url.searchParams.get("offset"), 0, 1_000_000));

    const params: unknown[] = [auth.empresa_id];
    const where: string[] = [`c.empresa_id = $1`, `c.current_tag_id IS NOT NULL`];

    if (tagCode) {
      params.push(tagCode);
      where.push(`t.code = $${params.length}`);
    }
    if (phoneRaw && phoneRaw.length >= 3) {
      params.push(`%${phoneRaw}%`);
      where.push(`ct.phone_number ILIKE $${params.length}`);
    }
    if (dateFromIso) {
      params.push(dateFromIso);
      where.push(`c.last_message_at >= $${params.length}::timestamptz`);
    }
    if (dateToIso) {
      params.push(dateToIso);
      where.push(`c.last_message_at <= $${params.length}::timestamptz`);
    }

    const whereSql = where.join(" AND ");

    // Total
    const countQ = `
      SELECT COUNT(*)::int AS n
        FROM "${schema}".chat_conversations c
        LEFT JOIN "${schema}".chat_conversation_tags t ON t.id = c.current_tag_id
        LEFT JOIN "${schema}".chat_contacts ct ON ct.id = c.contact_id
       WHERE ${whereSql}
    `;
    const countRes = await pool.query<{ n: number }>(countQ, params);
    const totalCount = countRes.rows?.[0]?.n ?? 0;

    // Rows page
    params.push(limit);
    const pLimit = params.length;
    params.push(offset);
    const pOffset = params.length;

    const listQ = `
      SELECT
        c.id::text                  AS conversation_id,
        c.contact_id::text          AS contact_id,
        c.last_message_at,
        c.last_message_preview,
        c.flow_current_node         AS current_node_code,
        c.hidden_by_tag             AS hidden_by_tag,
        c.last_tagged_at,
        t.id::text                  AS tag_id,
        t.code                      AS tag_code,
        t.label                     AS tag_label,
        t.color                     AS tag_color,
        ct.name                     AS contact_name,
        ct.phone_number             AS phone_number
      FROM "${schema}".chat_conversations c
      LEFT JOIN "${schema}".chat_conversation_tags t ON t.id = c.current_tag_id
      LEFT JOIN "${schema}".chat_contacts ct ON ct.id = c.contact_id
      WHERE ${whereSql}
      ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
      LIMIT $${pLimit}::int OFFSET $${pOffset}::int
    `;
    const listRes = await pool.query(listQ, params);

    const rows = (listRes.rows ?? []).map((r) => ({
      conversation_id: String(r.conversation_id),
      contact_id: r.contact_id ? String(r.contact_id) : null,
      tag_id: r.tag_id ? String(r.tag_id) : null,
      tag_code: r.tag_code ?? null,
      tag_label: r.tag_label ?? null,
      tag_color: r.tag_color ?? null,
      contact_name: r.contact_name ?? null,
      phone_masked: maskPhone(r.phone_number),
      last_message_at: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      last_message_preview: r.last_message_preview ?? null,
      current_node_code: r.current_node_code ?? null,
      hidden_by_tag: r.hidden_by_tag === true,
      last_tagged_at: r.last_tagged_at ? new Date(r.last_tagged_at).toISOString() : null,
    }));

    return NextResponse.json({
      ok: true,
      filters: {
        tag_code: tagCode || null,
        phone_digits: phoneRaw || null,
        date_from: dateFromIso,
        date_to: dateToIso,
      },
      pagination: { limit, offset, total: totalCount },
      rows,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
