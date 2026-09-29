/**
 * Datos SOLO de visualización para mostrar en el inbox un mensaje de campaña (plantilla)
 * como lo ve el cliente en WhatsApp: media de cabecera + botones.
 * Se arma desde la campaña (template_components_json + send_config_json); no afecta envíos.
 */

export type CampaignTemplateDisplayButton = {
  type: string;
  text: string;
  url?: string | null;
};

export type CampaignTemplateDisplay = {
  header_format: "IMAGE" | "VIDEO" | "DOCUMENT" | "TEXT" | null;
  header_url: string | null;
  header_text: string | null;
  footer_text: string | null;
  buttons: CampaignTemplateDisplayButton[];
};

export function buildCampaignTemplateDisplay(
  components: unknown,
  sendConfig: unknown
): CampaignTemplateDisplay {
  const out: CampaignTemplateDisplay = {
    header_format: null,
    header_url: null,
    header_text: null,
    footer_text: null,
    buttons: [],
  };
  if (Array.isArray(components)) {
    for (const c of components) {
      const o = (c ?? {}) as { type?: string; format?: string; text?: string; buttons?: unknown[] };
      const type = String(o.type ?? "").toUpperCase();
      if (type === "HEADER") {
        const fmt = String(o.format ?? "").toUpperCase();
        if (fmt === "IMAGE" || fmt === "VIDEO" || fmt === "DOCUMENT") out.header_format = fmt;
        else if (fmt === "TEXT") {
          out.header_format = "TEXT";
          out.header_text = typeof o.text === "string" ? o.text : null;
        }
      } else if (type === "FOOTER") {
        out.footer_text = typeof o.text === "string" && o.text.trim() ? o.text : null;
      } else if (type === "BUTTONS" && Array.isArray(o.buttons)) {
        for (const b of o.buttons) {
          const btn = (b ?? {}) as { type?: string; text?: string; url?: string };
          const text = String(btn.text ?? "").trim();
          if (!text) continue;
          out.buttons.push({
            type: String(btn.type ?? "").toUpperCase(),
            text,
            url: typeof btn.url === "string" && btn.url.trim() ? btn.url.trim() : null,
          });
        }
      }
    }
  }
  const cfg = (sendConfig ?? {}) as Record<string, unknown>;
  const headerUrl = typeof cfg.header_image_url === "string" ? cfg.header_image_url.trim() : "";
  if (headerUrl && out.header_format && out.header_format !== "TEXT") out.header_url = headerUrl;
  return out;
}

/** Quita el prefijo "Plantilla: nombre · idioma" que se guarda en `content`. */
export function splitCampaignTemplateContent(content: string | null): { label: string | null; body: string } {
  const c = content ?? "";
  const m = /^Plantilla: ([^\n]*)\n\n?/.exec(c);
  if (!m) return { label: null, body: c };
  return { label: m[1].trim() || null, body: c.slice(m[0].length) };
}
