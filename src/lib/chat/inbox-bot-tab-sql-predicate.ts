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
  const flows = quoteSchemaTable(schema, "chat_flows");

  /**
   * Regla del negocio (2026-09-30): una conversación abierta/pendiente es del **Bot**
   * POR DEFECTO. Solo va al **Inbox** cuando interviene un humano
   * (`human_taken_over = true` o `flow_status = 'human'`). Ya no se exige sesión de
   * flujo ni flow_code activo: una plantilla/masivo sin respuesta —o un flujo ya
   * terminado— sigue siendo del bot y no ensucia el inbox humano.
   *
   * Verificado en datos: el handoff a humano SIEMPRE marca human_taken_over/flow_status
   * (0 conversaciones asignadas a agente/cola sin esa marca), así que este predicado no
   * manda ninguna conversación humana al bot.
   */
  return `(
    COALESCE(${conv}.human_taken_over, false) = false
    AND lower(coalesce(${conv}.flow_status, '')) <> 'human'
    AND EXISTS (SELECT 1 FROM ${flows} f WHERE f.empresa_id = $1::uuid AND f.activo = true)
  )`;
}

/** Flag de activación. OFF por defecto: comportamiento previo intacto (filtro en memoria). */
export function isInboxSqlTabFilterEnabled(): boolean {
  return (process.env.INBOX_SQL_TAB_FILTER ?? "false").trim().toLowerCase() === "true";
}
