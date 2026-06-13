/**
 * Validación de paridad READ-ONLY: predicado SQL REAL de producción
 * (`buildBotTabSqlPredicate`) vs la función TS `conversationBelongsToBotTab`,
 * sobre las conversaciones open/pending reales de triple7.
 *
 * NO modifica nada. Solo SELECT.
 * Ejecutar: npx tsx scripts/_inbox-tab-parity.ts
 */
import fs from "node:fs";
import { Client } from "pg";

// Cargar .env.local ANTES de tocar módulos que validan schema.
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

import {
  conversationBelongsToBotTab,
  buildActiveFlowMatchSet,
  type FlowSessionRowMin,
  type InboxBotClassificationInput,
} from "../src/lib/chat/inbox-bot-tab-classification";
import { buildBotTabSqlPredicate } from "../src/lib/chat/inbox-bot-tab-sql-predicate";

const URL = process.env.SUPABASE_DB_URL_TRIPLE7_SELFHOSTED!;
const EMP = "82f8a15a-5dd6-48d9-99b3-97210b5130bd";
const SCHEMA = "triple7";
const ACTIVE = ["active", "running"];
const TARGET = "4a81a092-fcfc-4ae5-86a4-1bb60742fe3d";

async function main() {
  const c = new Client({ connectionString: URL, ssl: false });
  await c.connect();

  const flows = await c.query(`SELECT id::text, flow_code FROM ${SCHEMA}.chat_flows WHERE empresa_id=$1::uuid AND activo=true`, [EMP]);
  const activeFlowCodeSet = buildActiveFlowMatchSet(flows.rows as { id: string; flow_code: string }[]);

  const convs = await c.query(
    `SELECT id::text, status, flow_status, human_taken_over, active_flow_session_id::text, flow_code
       FROM ${SCHEMA}.chat_conversations
      WHERE empresa_id=$1::uuid AND status IN ('open','pending') AND COALESCE(hidden_by_tag,false)=false`,
    [EMP]
  );
  console.log("conversaciones open/pending=" + convs.rowCount);

  // sessionById (punteros, cualquier status) + activeSessionByConversationId (active/running)
  const sessionById = new Map<string, FlowSessionRowMin>();
  const pointerIds = [...new Set(convs.rows.map((r) => (r.active_flow_session_id || "").trim()).filter(Boolean))];
  for (let i = 0; i < pointerIds.length; i += 500) {
    const chunk = pointerIds.slice(i, i + 500);
    const qr = await c.query(`SELECT id::text, status, flow_code, conversation_id::text FROM ${SCHEMA}.chat_flow_sessions WHERE empresa_id=$1::uuid AND id = ANY($2::uuid[])`, [EMP, chunk]);
    for (const r of qr.rows) sessionById.set(String(r.id), { id: String(r.id), status: r.status, flow_code: r.flow_code, conversation_id: String(r.conversation_id) });
  }
  const activeSessionByConversationId = new Map<string, FlowSessionRowMin>();
  const convIds = convs.rows.map((r) => r.id);
  for (let i = 0; i < convIds.length; i += 500) {
    const chunk = convIds.slice(i, i + 500);
    const qr = await c.query(
      `SELECT id::text, status, flow_code, conversation_id::text FROM ${SCHEMA}.chat_flow_sessions WHERE empresa_id=$1::uuid AND conversation_id = ANY($2::uuid[]) AND lower(trim(status)) = ANY($3::text[])`,
      [EMP, chunk, ACTIVE]
    );
    for (const r of qr.rows) {
      const row: FlowSessionRowMin = { id: String(r.id), status: r.status, flow_code: r.flow_code, conversation_id: String(r.conversation_id) };
      sessionById.set(row.id, row);
      activeSessionByConversationId.set(row.conversation_id, row);
    }
  }

  const ctx: InboxBotClassificationInput = { activeFlowCodeSet, sessionById, activeSessionByConversationId };
  const tsBot = new Set<string>();
  for (const conv of convs.rows) {
    if (conversationBelongsToBotTab(conv as Record<string, unknown>, ctx)) tsBot.add(conv.id);
  }
  console.log("TS clasifica BOT=" + tsBot.size + " · INBOX=" + (convs.rowCount! - tsBot.size));

  // Predicado SQL REAL del módulo de producción
  const predicate = buildBotTabSqlPredicate(SCHEMA);
  const sqlBotRows = await c.query(
    `SELECT chat_conversations.id::text id
       FROM ${SCHEMA}.chat_conversations
      WHERE chat_conversations.empresa_id = $1::uuid
        AND chat_conversations.status IN ('open','pending')
        AND COALESCE(chat_conversations.hidden_by_tag,false) = false
        AND ${predicate}`,
    [EMP]
  );
  const sqlBot = new Set<string>(sqlBotRows.rows.map((r) => r.id));
  console.log("SQL  clasifica BOT=" + sqlBot.size + " · INBOX=" + (convs.rowCount! - sqlBot.size));

  const mismatches: { id: string; ts: string; sql: string; conv: Record<string, unknown> }[] = [];
  for (const conv of convs.rows) {
    const inTs = tsBot.has(conv.id);
    const inSql = sqlBot.has(conv.id);
    if (inTs !== inSql) mismatches.push({ id: conv.id, ts: inTs ? "BOT" : "INBOX", sql: inSql ? "BOT" : "INBOX", conv });
  }
  const total = convs.rowCount!;
  const matches = total - mismatches.length;
  console.log("\n=== PARIDAD ===");
  console.log(`  total=${total} · matches=${matches} · mismatches=${mismatches.length} · paridad=${((matches * 100) / total).toFixed(3)}%`);
  for (const m of mismatches.slice(0, 20)) {
    console.log(`    conv=${m.id.slice(0, 8)} TS=${m.ts} SQL=${m.sql} | status=${m.conv.status} fs=${m.conv.flow_status} hto=${m.conv.human_taken_over} ptr=${m.conv.active_flow_session_id ? String(m.conv.active_flow_session_id).slice(0, 8) : "-"} cf=${m.conv.flow_code}`);
  }
  if (mismatches.length === 0) console.log("  ✅ PARIDAD 100% — predicado SQL real == conversationBelongsToBotTab");
  console.log(`\n  Conv 4a81a092 (0982765549): TS=${tsBot.has(TARGET) ? "BOT" : "INBOX"} SQL=${sqlBot.has(TARGET) ? "BOT" : "INBOX"}`);

  await c.end();
  if (mismatches.length > 0) process.exit(1);
}
main().catch((e) => { console.error("ERR: " + (e instanceof Error ? e.message : e)); process.exit(1); });
