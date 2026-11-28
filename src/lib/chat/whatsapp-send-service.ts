/**
 * Envío vía WhatsApp Cloud API (Graph)
 *
 * Límites documentados (Cloud API): reply buttons máx. 3; lista interactiva hasta 10 filas (total).
 */
export const WA_META_REPLY_BUTTON_MAX = 3;
export const WA_META_LIST_ROW_MAX = 10;
/** Título de cada reply button (Meta). */
export const WA_META_REPLY_TITLE_MAX = 20;
/** Título de cada fila de lista (Meta). */
export const WA_META_LIST_ROW_TITLE_MAX = 24;
export const WA_META_LIST_ROW_DESCRIPTION_MAX = 72;
/** Texto del botón que abre la lista (Meta). */
export const WA_META_LIST_MENU_BUTTON_MAX = 20;
/**
 * Acorta un título de botón al máximo de Meta sin cortar números (ej. "15 boletas por 100000"
 * quedaba "15 boletas por 10000", un precio distinto). Primero compacta palabras, y solo si
 * aun así no entra corta por palabras completas.
 */
export function fitWhatsAppButtonTitle(raw: string, max = WA_META_REPLY_TITLE_MAX): string {
  const full = raw.trim().replace(/\s+/g, " ");
  if (full.length <= max) return full;
  const steps: Array<(s: string) => string> = [
    (s) => s.replace(/\s+por\s+/gi, " x "),
    (s) => s.replace(/\bboletas?\b/gi, "bol."),
    (s) => s.replace(/\s+x\s+/gi, "x"),
    (s) => s.replace(/\s+/g, ""),
  ];
  let cur = full;
  for (const step of steps) {
    cur = step(cur);
    if (cur.length <= max) return cur;
  }
  // Último recurso: cortar sin partir una palabra/número.
  const cut = cur.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const nextChar = cur.charAt(max);
  if (nextChar && nextChar !== " " && lastSpace > 0) return cut.slice(0, lastSpace).trim();
  return cut.trim();
}

export type SendWhatsAppTextParams = {
  toDigits: string;
  text: string;
  phoneNumberId: string;
  accessToken: string;
  graphVersion?: string;
};

export type SendWhatsAppTextResult =
  | { ok: true; waMessageId: string | null; raw: unknown }
  | { ok: false; error: string; status?: number; code?: string; raw?: unknown };

export type SendWhatsAppButtonsParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  bodyText: string;
  buttons: Array<{
    id: string;
    title: string;
  }>;
  graphVersion?: string;
};

export type SendWhatsAppImageParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  imageUrl: string;
  caption?: string;
  graphVersion?: string;
};

export type SendWhatsAppDocumentParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  /** URL HTTPS pública (p. ej. Supabase Storage). */
  link: string;
  filename: string;
  caption?: string;
  graphVersion?: string;
};

export type SendWhatsAppAudioParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  /** URL HTTPS pública del audio (ogg/opus, mpeg, etc.). */
  audioUrl: string;
  graphVersion?: string;
};

async function sendWhatsAppPayload(
  params: {
    phoneNumberId: string;
    accessToken: string;
    graphVersion?: string;
  },
  body: Record<string, unknown>
): Promise<SendWhatsAppTextResult> {
  const v = params.graphVersion ?? process.env.WHATSAPP_GRAPH_VERSION ?? "v19.0";
  const url = `https://graph.facebook.com/${v}/${params.phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errMsg =
      typeof raw.error === "object" && raw.error && "message" in (raw.error as object)
        ? String((raw.error as { message?: string }).message)
        : res.statusText;
    return {
      ok: false,
      error: errMsg || `HTTP ${res.status}`,
      status: res.status,
      raw,
    };
  }
  const messages = raw.messages as Array<{ id?: string }> | undefined;
  const waMessageId = messages?.[0]?.id ?? null;
  return { ok: true, waMessageId, raw };
}

export async function sendWhatsAppText(
  params: SendWhatsAppTextParams
): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "text",
    text: { body: params.text },
  });
}

export async function sendWhatsAppInteractiveButtons(
  params: SendWhatsAppButtonsParams
): Promise<SendWhatsAppTextResult> {
  if (params.buttons.length > WA_META_REPLY_BUTTON_MAX) {
    console.warn("[flow-send]", "buttons_truncated_unexpected", {
      received: params.buttons.length,
      max: WA_META_REPLY_BUTTON_MAX,
      hint: "Usar sendWhatsAppChoiceMessage para >3 opciones",
    });
  }
  const buttons = params.buttons.slice(0, WA_META_REPLY_BUTTON_MAX).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: fitWhatsAppButtonTitle(b.title) },
  }));

  if (buttons.length === 0) {
    return { ok: false, error: "No hay botones para enviar" };
  }

  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: params.bodyText.slice(0, 1024) },
      action: { buttons },
    },
  });
}

export type SendWhatsAppInteractiveListParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  bodyText: string;
  /** Etiqueta del botón que despliega la lista (máx. 20). */
  openListButtonText: string;
  rows: Array<{ id: string; title: string; description?: string }>;
  graphVersion?: string;
};

export async function sendWhatsAppInteractiveList(
  params: SendWhatsAppInteractiveListParams
): Promise<SendWhatsAppTextResult> {
  const dropped = Math.max(0, params.rows.length - WA_META_LIST_ROW_MAX);
  if (dropped > 0) {
    console.warn("[flow-send]", "list_rows_truncated", {
      dropped,
      kept: WA_META_LIST_ROW_MAX,
      hint: "WhatsApp permite máximo 10 filas en lista interactiva",
    });
  }
  const rows = params.rows.slice(0, WA_META_LIST_ROW_MAX).map((r) => {
    const title = r.title.trim().slice(0, WA_META_LIST_ROW_TITLE_MAX);
    const descRaw = (r.description ?? "").trim();
    const description =
      descRaw.length > 0 ? descRaw.slice(0, WA_META_LIST_ROW_DESCRIPTION_MAX) : undefined;
    return {
      id: r.id.trim().slice(0, 200),
      title: title || "—",
      ...(description ? { description } : {}),
    };
  });

  if (rows.length === 0) {
    return { ok: false, error: "No hay filas para lista interactiva" };
  }

  const openBtn = params.openListButtonText.trim().slice(0, WA_META_LIST_MENU_BUTTON_MAX) || "Opciones";

  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: params.bodyText.slice(0, 1024) },
      action: {
        button: openBtn,
        sections: [
          {
            title: "Opciones".slice(0, 24),
            rows,
          },
        ],
      },
    },
  });
}

export type SendWhatsAppChoiceMessageParams = SendWhatsAppButtonsParams & {
  /** Solo si hay >3 opciones: texto del botón menú para abrir la lista. */
  listMenuButtonText?: string;
};

/**
 * Reply buttons si hay ≤3 opciones; mensaje tipo lista si hay 4–10 (límite Meta).
 * No recorta en silencio sin log: >10 filas → truncado con warn en sendWhatsAppInteractiveList.
 */
export async function sendWhatsAppChoiceMessage(
  params: SendWhatsAppChoiceMessageParams
): Promise<SendWhatsAppTextResult> {
  const n = params.buttons.length;
  if (n <= WA_META_REPLY_BUTTON_MAX) {
    console.info("[flow-send]", "choice_payload", {
      mode: "reply_buttons",
      count: n,
      maxReplyButtons: WA_META_REPLY_BUTTON_MAX,
    });
    return sendWhatsAppInteractiveButtons(params);
  }

  const menu =
    (params.listMenuButtonText ?? "Ver opciones").trim().slice(0, WA_META_LIST_MENU_BUTTON_MAX) ||
    "Ver opciones";

  console.info("[flow-send]", "choice_payload", {
    mode: "list_message",
    count: n,
    replyButtonMax: WA_META_REPLY_BUTTON_MAX,
    listRowMax: WA_META_LIST_ROW_MAX,
    menuButton: menu,
  });

  const rows = params.buttons.map((b) => {
    const full = b.title.trim();
    if (full.length <= WA_META_LIST_ROW_TITLE_MAX) {
      return { id: b.id, title: full };
    }
    return {
      id: b.id,
      title: full.slice(0, WA_META_LIST_ROW_TITLE_MAX),
      description: full
        .slice(WA_META_LIST_ROW_TITLE_MAX, WA_META_LIST_ROW_TITLE_MAX + WA_META_LIST_ROW_DESCRIPTION_MAX)
        .trim(),
    };
  });

  return sendWhatsAppInteractiveList({
    toDigits: params.toDigits,
    phoneNumberId: params.phoneNumberId,
    accessToken: params.accessToken,
    graphVersion: params.graphVersion,
    bodyText: params.bodyText,
    openListButtonText: menu,
    rows,
  });
}

export async function sendWhatsAppImage(
  params: SendWhatsAppImageParams
): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "image",
    image: {
      link: params.imageUrl,
      ...(params.caption ? { caption: params.caption.slice(0, 1024) } : {}),
    },
  });
}

export async function sendWhatsAppAudio(params: SendWhatsAppAudioParams): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "audio",
    audio: { link: params.audioUrl },
  });
}

export type SendWhatsAppVideoParams = {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  videoUrl: string;
  caption?: string;
  graphVersion?: string;
};

export async function sendWhatsAppVideo(params: SendWhatsAppVideoParams): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "video",
    video: {
      link: params.videoUrl,
      ...(params.caption ? { caption: params.caption.slice(0, 1024) } : {}),
    },
  });
}

export async function sendWhatsAppDocument(
  params: SendWhatsAppDocumentParams
): Promise<SendWhatsAppTextResult> {
  const fn = params.filename.trim() || "documento";
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "document",
    document: {
      link: params.link,
      filename: fn.slice(0, 240),
    },
  };
  const doc = (body.document as Record<string, unknown>);
  if (params.caption?.trim()) doc.caption = params.caption.trim().slice(0, 1024);
  return sendWhatsAppPayload(params, body);
}

/** Plantilla aprobada (Cloud API). `templatePayload` = objeto `template` completo (name, language, components). */
export async function sendWhatsAppTemplateMessage(params: {
  toDigits: string;
  phoneNumberId: string;
  accessToken: string;
  templatePayload: Record<string, unknown>;
  graphVersion?: string;
}): Promise<SendWhatsAppTextResult> {
  return sendWhatsAppPayload(params, {
    messaging_product: "whatsapp",
    to: params.toDigits,
    type: "template",
    template: params.templatePayload,
  });
}
