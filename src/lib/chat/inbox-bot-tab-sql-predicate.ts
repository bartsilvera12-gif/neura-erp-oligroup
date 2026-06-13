import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

/**
 * Predicado SQL que replica EXACTAMENTE `conversationBelongsToBotTab`
 * (`inbox-bot-tab-classification.ts`) a nivel WHERE, para poder separar
 * Inbox/Bot ANTES del LIMIT en lugar de filtrar 100 filas en memoria.
 *
 * Motivo (auditoría 2026-06-13): con el bot muy activo, las 100 conversaciones
 * más recientes son todas "bot", así que el filtrado en memoria dejaba el tab
 * Inbox vacío aunque había conversaciones humanas más abajo (posición #155+).
 *
 * Paridad validada al 100% contra la función TS sobre 2365 conversaciones
 * reales (`.tmp-vlogs/_inbox-tab-parity.js`).
 *
 * Correlación: el SELECT principal hace `FROM "<schema>"."chat_conversations"`
 * SIN alias, por lo que las columnas del outer se referencian como
 * `chat_conversations.<col>`. `$1` es siempre `empresa_id` en esa query.
 *
 * El predicado nunca evalúa NULL (todo COALESCE + CASE que retorna boolean),
 * así que `NOT (<predicado>)` para el tab Inbox es seguro.
 */
export function buildBotTabSqlPredicate(schema: string): string {
  const conv = "chat_conversations"; // correlación al outer (FROM sin alias)
  const sess = quoteSchemaTable(schema, "chat_flow_sessions");
  const flows = quoteSchemaTable(schema, "chat_flows");

  return `(
    COALESCE(${conv}.human_taken_over, false) = false
    AND lower(coalesce(${conv}.flow_status, '')) <> 'human'
    AND EXISTS (SELECT 1 FROM ${flows} f WHERE f.empresa_id = $1::uuid AND f.activo = true)
    AND CASE
      -- (1) puntero resuelve a una sesión de ESTA conversación (cualquier status)
      WHEN ${conv}.active_flow_session_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM ${sess} sp
              WHERE sp.empresa_id = $1::uuid
                AND sp.id = ${conv}.active_flow_session_id
                AND sp.conversation_id = ${conv}.id
           )
      THEN EXISTS (
             SELECT 1 FROM ${sess} sp
              WHERE sp.empresa_id = $1::uuid
                AND sp.id = ${conv}.active_flow_session_id
                AND sp.conversation_id = ${conv}.id
                AND lower(trim(sp.status)) IN ('active','running')
           )
      -- (2) sin puntero válido: ¿hay sesión active/running para la conv?
      WHEN EXISTS (
             SELECT 1 FROM ${sess} sc
              WHERE sc.empresa_id = $1::uuid
                AND sc.conversation_id = ${conv}.id
                AND lower(trim(sc.status)) IN ('active','running')
           )
      THEN true
      -- (3) sin sesión: flow_status "botish" + flow_code en catálogo activo
      ELSE (
        lower(coalesce(${conv}.flow_status, '')) IN ('bot','active','running')
        AND lower(trim(coalesce(${conv}.flow_code, ''))) <> ''
        AND lower(trim(coalesce(${conv}.flow_code, ''))) IN (
          SELECT lower(trim(flow_code)) FROM ${flows} WHERE empresa_id = $1::uuid AND activo = true
          UNION
          SELECT lower(id::text)        FROM ${flows} WHERE empresa_id = $1::uuid AND activo = true
        )
      )
    END
  )`;
}

/** Flag de activación. OFF por defecto: comportamiento previo intacto (filtro en memoria). */
export function isInboxSqlTabFilterEnabled(): boolean {
  return (process.env.INBOX_SQL_TAB_FILTER ?? "false").trim().toLowerCase() === "true";
}
