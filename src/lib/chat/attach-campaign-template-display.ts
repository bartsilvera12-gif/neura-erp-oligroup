import "server-only";

import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { buildCampaignTemplateDisplay } from "@/lib/campaigns/campaign-template-display";

/**
 * Agrega `template_display` (media de cabecera + botones de la campaña) a los mensajes
 * `template` enviados por campañas. Solo lectura; si falla, devuelve las filas sin cambios.
 */
export async function attachCampaignTemplateDisplay<T extends Record<string, unknown>>(
  empresaId: string,
  rows: T[]
): Promise<T[]> {
  try {
    const campaignIds = new Set<string>();
    for (const r of rows) {
      if (r.message_type !== "template") continue;
      const rp = r.raw_payload as Record<string, unknown> | null | undefined;
      const cid = typeof rp?.campaign_id === "string" ? rp.campaign_id.trim() : "";
      if (cid) campaignIds.add(cid);
    }
    if (campaignIds.size === 0) return rows;

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data, error } = await sb
      .from("chat_campaigns")
      .select("id, template_components_json, send_config_json")
      .eq("empresa_id", empresaId)
      .in("id", [...campaignIds]);
    if (error || !Array.isArray(data)) {
      if (error) console.warn("[chat-messages][template-display]", error.message);
      return rows;
    }

    const byId = new Map<string, ReturnType<typeof buildCampaignTemplateDisplay>>();
    for (const c of data as Array<{ id: string; template_components_json: unknown; send_config_json: unknown }>) {
      byId.set(String(c.id), buildCampaignTemplateDisplay(c.template_components_json, c.send_config_json));
    }

    return rows.map((r) => {
      if (r.message_type !== "template") return r;
      const rp = r.raw_payload as Record<string, unknown> | null | undefined;
      const cid = typeof rp?.campaign_id === "string" ? rp.campaign_id.trim() : "";
      const display = cid ? byId.get(cid) : undefined;
      return display ? { ...r, template_display: display } : r;
    });
  } catch (e) {
    console.warn("[chat-messages][template-display]", e instanceof Error ? e.message : e);
    return rows;
  }
}
