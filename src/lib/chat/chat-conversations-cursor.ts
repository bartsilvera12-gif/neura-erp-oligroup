/**
 * PERF-3: helpers de cursor para `fetchChatConversations`.
 *
 * Se separan de `src/lib/chat/actions.ts` porque ese módulo tiene `"use server"` y
 * Next.js exige que sólo se exporten funciones async desde un módulo Server Actions.
 */

export type ChatConversationsCursorPayload = { lma: string; id: string };

export const CHAT_CONVERSATIONS_DEFAULT_PAGE_SIZE = 100;
export const CHAT_CONVERSATIONS_MAX_PAGE_SIZE = 200;

export function encodeChatConversationsCursor(p: ChatConversationsCursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

export function decodeChatConversationsCursor(
  s: string | null | undefined
): ChatConversationsCursorPayload | null {
  if (!s) return null;
  try {
    const json = Buffer.from(s, "base64url").toString("utf8");
    const obj = JSON.parse(json) as { lma?: unknown; id?: unknown };
    const lma = typeof obj.lma === "string" ? obj.lma : "";
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!lma || !id) return null;
    return { lma, id };
  } catch {
    return null;
  }
}

export function clampChatConversationsPageLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return CHAT_CONVERSATIONS_DEFAULT_PAGE_SIZE;
  return Math.min(
    CHAT_CONVERSATIONS_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(limit))
  );
}
