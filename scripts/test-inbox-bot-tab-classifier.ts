/**
 * Tests del clasificador Inbox/Bot (`conversationBelongsToBotTab`).
 *
 * El predicado SQL `buildBotTabSqlPredicate` (flag INBOX_SQL_TAB_FILTER) debe
 * replicar EXACTAMENTE esta función. Estos casos fijan el contrato como
 * invariante para que TS y SQL no diverjan en cambios futuros.
 *
 * Ejecutar: npx tsx scripts/test-inbox-bot-tab-classifier.ts
 */
import {
  conversationBelongsToBotTab,
  buildActiveFlowMatchSet,
  buildFlowSessionMap,
  type InboxBotClassificationInput,
  type FlowSessionRowMin,
} from "../src/lib/chat/inbox-bot-tab-classification";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function check(name: string, got: boolean, expected: boolean) {
  if (got === expected) {
    pass++;
    console.log(`  ✓ ${name} → ${got ? "BOT" : "INBOX"}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ✗ ${name} → got ${got ? "BOT" : "INBOX"}, expected ${expected ? "BOT" : "INBOX"}`);
  }
}

// Catálogo: un flujo activo "triple_7" con id fijo.
const FLOW_ID = "21c8e43f-9c45-4a06-a44f-853a9b70c8a5";
const activeFlowCodeSet = buildActiveFlowMatchSet([{ id: FLOW_ID, flow_code: "triple_7" }]);

function ctxWith(sessions: FlowSessionRowMin[], activeByConv: Record<string, FlowSessionRowMin>): InboxBotClassificationInput {
  return {
    activeFlowCodeSet,
    sessionById: buildFlowSessionMap(sessions),
    activeSessionByConversationId: new Map(Object.entries(activeByConv)),
  };
}

const CONV = "4a81a092-fcfc-4ae5-86a4-1bb60742fe3d";
const OTHER = "ffffffff-0000-0000-0000-000000000000";
const SESS = "5e551011-0000-0000-0000-000000000001";

console.log("=== Tests clasificador Inbox/Bot ===");

// Caso 1: human_taken_over=true → Inbox
check(
  "1. human_taken_over=true",
  conversationBelongsToBotTab(
    { id: CONV, status: "open", flow_status: "bot", human_taken_over: true, active_flow_session_id: SESS, flow_code: "triple_7" },
    ctxWith([{ id: SESS, status: "active", flow_code: "triple_7", conversation_id: CONV }], { [CONV]: { id: SESS, status: "active", flow_code: "triple_7", conversation_id: CONV } })
  ),
  false
);

// Caso 2: flow_status=human → Inbox
check(
  "2. flow_status=human",
  conversationBelongsToBotTab(
    { id: CONV, status: "open", flow_status: "human", human_taken_over: false, active_flow_session_id: null, flow_code: "triple_7" },
    ctxWith([], {})
  ),
  false
);

// Caso 3: sesión activa válida (pointer→active matching) → Bot
check(
  "3. sesion activa valida (pointer)",
  conversationBelongsToBotTab(
    { id: CONV, status: "open", flow_status: "bot", human_taken_over: false, active_flow_session_id: SESS, flow_code: "triple_7" },
    ctxWith([{ id: SESS, status: "active", flow_code: "triple_7", conversation_id: CONV }], { [CONV]: { id: SESS, status: "active", flow_code: "triple_7", conversation_id: CONV } })
  ),
  true
);

// Caso 4a: puntero stale (apunta a sesión de OTRA conv) pero hay sesión activa para esta conv → Bot (conversation_lookup)
check(
  "4a. puntero stale + sesion activa por conv",
  conversationBelongsToBotTab(
    { id: CONV, status: "open", flow_status: "bot", human_taken_over: false, active_flow_session_id: SESS, flow_code: "triple_7" },
    ctxWith(
      [{ id: SESS, status: "active", flow_code: "triple_7", conversation_id: OTHER }], // puntero apunta a sesión de OTHER
      { [CONV]: { id: "5e551011-0000-0000-0000-000000000002", status: "active", flow_code: "triple_7", conversation_id: CONV } }
    )
  ),
  true
);

// Caso 4b: puntero a sesión NON-active de esta conv (precedencia puntero) → Inbox aunque hubiera otra activa
check(
  "4b. puntero a sesion NO activa de la conv (precedencia)",
  conversationBelongsToBotTab(
    { id: CONV, status: "open", flow_status: "bot", human_taken_over: false, active_flow_session_id: SESS, flow_code: "triple_7" },
    ctxWith(
      [{ id: SESS, status: "ended", flow_code: "triple_7", conversation_id: CONV }],
      { [CONV]: { id: "5e551011-0000-0000-0000-000000000003", status: "active", flow_code: "triple_7", conversation_id: CONV } }
    )
  ),
  false
);

// Caso 5: flow_status botish + flow_code activo + SIN sesión → Bot
check(
  "5. flow_status botish + flow_code activo + sin sesion",
  conversationBelongsToBotTab(
    { id: CONV, status: "open", flow_status: "bot", human_taken_over: false, active_flow_session_id: null, flow_code: "triple_7" },
    ctxWith([], {})
  ),
  true
);

// Caso 6a: sin sesión activa + flow_status NO botish → Inbox
check(
  "6a. sin sesion + flow_status no botish",
  conversationBelongsToBotTab(
    { id: CONV, status: "open", flow_status: "", human_taken_over: false, active_flow_session_id: null, flow_code: "triple_7" },
    ctxWith([], {})
  ),
  false
);

// Caso 6b: flow_status botish PERO flow_code no está en catálogo activo → Inbox
check(
  "6b. flow_status botish + flow_code NO en catalogo",
  conversationBelongsToBotTab(
    { id: CONV, status: "open", flow_status: "bot", human_taken_over: false, active_flow_session_id: null, flow_code: "flujo_inexistente" },
    ctxWith([], {})
  ),
  false
);

// Caso 7: status closed → no es Bot (ni Inbox del universo abierto)
check(
  "7. status closed",
  conversationBelongsToBotTab(
    { id: CONV, status: "closed", flow_status: "bot", human_taken_over: false, active_flow_session_id: SESS, flow_code: "triple_7" },
    ctxWith([{ id: SESS, status: "active", flow_code: "triple_7", conversation_id: CONV }], { [CONV]: { id: SESS, status: "active", flow_code: "triple_7", conversation_id: CONV } })
  ),
  false
);

console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail ===`);
if (fail > 0) {
  console.error("FALLARON: " + fails.join(", "));
  process.exit(1);
}
console.log("✅ TODOS LOS TESTS PASARON");
