import "server-only";

import type { Pool } from "pg";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

/**
 * FASE 4 — Auto-takeover cuando un operador humano envía un mensaje manual.
 *
 * Causa que ataca: la operadora escribe a una conversación que sigue en
 * `flow_status='bot' / human_taken_over=false`. El próximo inbound del
 * cliente activa el flow-engine y el bot responde por encima del humano.
 *
 * Fix: cuando el outbound es enviado por un operador humano (sender_type
 * === 'human' con `sent_by_user_id` real), promovemos automáticamente la
 * conversación a `flow_status='human' / human_taken_over=true`. El flow-
 * engine ya respeta esos flags (`isConversationInBotAutomationMode` en
 * `flow-engine-service.ts:86-91`), así que el bot deja de procesar
 * inbounds para esa conversación.
 *
 * Idempotente: si ya está en humano, no toca DB ni registra evento.
 * NO envía mensaje al cliente. NO toca routing, sorteos, tickets, ni
 * Fase 1.
 *
 * Rollback rápido: `AUTO_TAKEOVER_ON_HUMAN_SEND=false` en env + redeploy.
 */
const AUTO_TAKEOVER_ON_HUMAN_SEND_ENABLED =
  (process.env.AUTO_TAKEOVER_ON_HUMAN_SEND ?? "true").trim().toLowerCase() !== "false";

export type AutoTakeoverInput = {
  /** Cliente Supabase admin (service role) ya bound al schema correcto. */
  supabase: AppSupabaseClient;
  /** Pool PG directo si la operación corre en tenant no expuesto vía PostgREST. */
  pool: Pool | null;
  /** Schema del tenant (p. ej. `triple7`). Solo se usa cuando `useTenantPg=true`. */
  schema: string;
  /** Si true, se usa el pool directo en lugar de PostgREST. */
  useTenantPg: boolean;
  empresaId: string;
  conversationId: string;
  /** Tipo del remitente del outbound recién enviado. */
  senderType: "human" | "ai" | "system";
  /** Sólo se activa si hay un user real autenticado. */
  byUserId: string | null;
  byUserName: string | null;
};

export type AutoTakeoverResult =
  | { applied: false; reason: "flag_off" | "not_human_sender" | "no_user" | "already_human" | "conv_not_found" | "error"; error?: string }
  | { applied: true; previous_status: string | null; previous_human_taken_over: boolean };

/**
 * Idempotente: si la conversación ya está en humano, no hace UPDATE ni INSERT
 * de evento. Retorna `{applied:false, reason:'already_human'}`.
 *
 * NUNCA tira: cualquier error queda en `{applied:false, reason:'error'}` para
 * que el caller (endpoints /send y /send-media) no rompa la respuesta del
 * mensaje principal por un error en el takeover.
 */
export async function maybeAutoTakeoverOnHumanSend(
  input: AutoTakeoverInput
): Promise<AutoTakeoverResult> {
  if (!AUTO_TAKEOVER_ON_HUMAN_SEND_ENABLED) {
    return { applied: false, reason: "flag_off" };
  }
  if (input.senderType !== "human") {
    return { applied: false, reason: "not_human_sender" };
  }
  if (!input.byUserId) {
    // Sin operador autenticado real no aplicamos takeover (defensa: evita
    // que un caller mal configurado promueva conversaciones por accidente).
    return { applied: false, reason: "no_user" };
  }

  try {
    // 1) Leer estado actual — idempotencia
    let currentStatus: string | null = null;
    let currentHumanTakenOver = false;
    let currentFlowCode: string | null = null;
    let currentFlowCurrentNode: string | null = null;

    if (input.useTenantPg && input.pool) {
      const convT = quoteSchemaTable(input.schema, "chat_conversations");
      const r = await input.pool.query<{
        flow_status: string | null;
        human_taken_over: boolean | null;
        flow_code: string | null;
        flow_current_node: string | null;
      }>(
        `SELECT flow_status, human_taken_over, flow_code, flow_current_node
         FROM ${convT}
         WHERE id=$1::uuid AND empresa_id=$2::uuid LIMIT 1`,
        [input.conversationId, input.empresaId]
      );
      if (r.rowCount === 0) return { applied: false, reason: "conv_not_found" };
      const row = r.rows[0];
      currentStatus = row.flow_status;
      currentHumanTakenOver = Boolean(row.human_taken_over);
      currentFlowCode = row.flow_code;
      currentFlowCurrentNode = row.flow_current_node;
    } else {
      const { data, error } = await input.supabase
        .from("chat_conversations")
        .select("flow_status, human_taken_over, flow_code, flow_current_node")
        .eq("id", input.conversationId)
        .eq("empresa_id", input.empresaId)
        .maybeSingle();
      if (error) return { applied: false, reason: "error", error: error.message };
      if (!data) return { applied: false, reason: "conv_not_found" };
      const row = data as {
        flow_status?: string | null;
        human_taken_over?: boolean | null;
        flow_code?: string | null;
        flow_current_node?: string | null;
      };
      currentStatus = row.flow_status ?? null;
      currentHumanTakenOver = Boolean(row.human_taken_over);
      currentFlowCode = row.flow_code ?? null;
      currentFlowCurrentNode = row.flow_current_node ?? null;
    }

    // 2) Idempotencia: si ya está en humano, no tocar
    if (currentHumanTakenOver || currentStatus === "human") {
      return { applied: false, reason: "already_human" };
    }

    // 3) UPDATE conversación → modo humano
    const updatedAt = new Date().toISOString();
    if (input.useTenantPg && input.pool) {
      const convT = quoteSchemaTable(input.schema, "chat_conversations");
      await input.pool.query(
        `UPDATE ${convT}
         SET flow_status='human', human_taken_over=true, updated_at=$1::timestamptz
         WHERE id=$2::uuid AND empresa_id=$3::uuid
           AND human_taken_over=false`,
        [updatedAt, input.conversationId, input.empresaId]
      );
    } else {
      const { error: upErr } = await input.supabase
        .from("chat_conversations")
        .update({
          flow_status: "human",
          human_taken_over: true,
          updated_at: updatedAt,
        })
        .eq("id", input.conversationId)
        .eq("empresa_id", input.empresaId)
        .eq("human_taken_over", false);
      if (upErr) return { applied: false, reason: "error", error: upErr.message };
    }

    // 4) INSERT evento en chat_flow_events (auditoría)
    //    Sin bloquear: si falla, log warn y seguimos.
    try {
      if (input.useTenantPg && input.pool) {
        const evT = quoteSchemaTable(input.schema, "chat_flow_events");
        await input.pool.query(
          `INSERT INTO ${evT} (empresa_id, conversation_id, flow_code, node_code, event_type, payload)
           VALUES ($1::uuid, $2::uuid, $3, $4, 'takeover_human_enabled', $5::jsonb)`,
          [
            input.empresaId,
            input.conversationId,
            currentFlowCode,
            currentFlowCurrentNode,
            JSON.stringify({
              mode: "human",
              by_user_id: input.byUserId,
              by_user_name: input.byUserName,
              source: "auto_on_manual_send",
            }),
          ]
        );
      } else {
        await input.supabase.from("chat_flow_events").insert({
          empresa_id: input.empresaId,
          conversation_id: input.conversationId,
          flow_code: currentFlowCode,
          node_code: currentFlowCurrentNode,
          event_type: "takeover_human_enabled",
          payload: {
            mode: "human",
            by_user_id: input.byUserId,
            by_user_name: input.byUserName,
            source: "auto_on_manual_send",
          },
        });
      }
    } catch (evErr) {
      console.warn("[auto-takeover][event-insert-failed]", {
        conversationId: input.conversationId,
        message: evErr instanceof Error ? evErr.message : String(evErr),
      });
    }

    console.info("[auto-takeover][enabled]", {
      conversationId: input.conversationId,
      previous_status: currentStatus,
      by_user_id: input.byUserId,
      source: "auto_on_manual_send",
    });

    return {
      applied: true,
      previous_status: currentStatus,
      previous_human_taken_over: currentHumanTakenOver,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[auto-takeover][error]", {
      conversationId: input.conversationId,
      message: msg,
    });
    return { applied: false, reason: "error", error: msg };
  }
}
