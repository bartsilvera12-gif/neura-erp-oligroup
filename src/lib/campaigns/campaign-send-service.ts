import "server-only";
import { assignConversation } from "@/lib/chat/assign-conversation-service";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { normalizeWaPhone } from "@/lib/chat/wa-phone";
import { resolveOutboundTextContextFromIds } from "@/lib/chat/outbound-send-dispatch";
import { sendWhatsAppTemplateMessage } from "@/lib/chat/whatsapp-send-service";
import { sendYCloudWhatsappTemplateMessage } from "@/lib/chat/ycloud-send-service";
import {
  isHttpsUrl,
  templateSnapshotHasHeaderImage,
} from "@/lib/campaigns/campaign-header-image";
import {
  buildCampaignTemplatePreviewText,
  buildMetaCloudTemplatePayload,
  extractBodyPlaceholderKeysOrdered,
  logCampaignTemplateVarsResolved,
} from "@/lib/campaigns/campaign-template-payload";
import { ensureCentralChatConversationMirror } from "@/lib/chat/central-chat-conversation-mirror";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";

export type CampaignOutboundRow = {
  id: string;
  empresa_id: string;
  channel_id: string;
  queue_id: string | null;
  provider: string;
  template_name: string;
  template_language: string;
  template_components_json: unknown[];
  send_config_json?: Record<string, unknown> | null;
};

export type CampaignRecipientSendRow = {
  id: string;
  phone_e164: string;
  mapped_variables_json: Record<string, unknown>;
};

async function ensureContactAndConversationForCampaign(
  supabase: SupabaseAdmin,
  campaign: CampaignOutboundRow,
  phoneE164: string
): Promise<{ ok: true; contact_id: string; conversation_id: string } | { ok: false; error: string }> {
  const digits = normalizeWaPhone(phoneE164.replace(/^\+/, ""));
  if (!digits) return { ok: false, error: "Teléfono inválido" };

  const displayName = phoneE164;

  const { data: contact, error: cErr } = await supabase
    .from("chat_contacts")
    .upsert(
      {
        empresa_id: campaign.empresa_id,
        phone_number: digits,
        phone_normalized: digits,
        name: displayName,
      },
      { onConflict: "empresa_id,phone_number" }
    )
    .select("id")
    .single();

  if (cErr || !contact?.id) {
    return { ok: false, error: cErr?.message ?? "Contacto" };
  }

  const contactId = contact.id as string;

  const { data: existingConv } = await supabase
    .from("chat_conversations")
    .select("id")
    .eq("contact_id", contactId)
    .eq("channel_id", campaign.channel_id)
    .maybeSingle();

  if (existingConv?.id) {
    const tenantDs = await fetchDataSchemaForEmpresaId(campaign.empresa_id);
    await ensureCentralChatConversationMirror({
      pool: getChatPostgresPool(),
      tenantDataSchema: tenantDs,
      empresaId: campaign.empresa_id,
      conversationId: existingConv.id as string,
    });
    return {
      ok: true,
      contact_id: contactId,
      conversation_id: existingConv.id as string,
    };
  }

  const ts = new Date().toISOString();
  const { data: conv, error: convErr } = await supabase
    .from("chat_conversations")
    .insert({
      empresa_id: campaign.empresa_id,
      channel_id: campaign.channel_id,
      contact_id: contactId,
      queue_id: campaign.queue_id,
      status: "open",
      flow_code: null,
      flow_current_node: null,
      flow_status: "human",
      human_taken_over: true,
      last_message_at: null,
      last_message_preview: null,
      unread_count: 0,
      updated_at: ts,
    })
    .select("id")
    .single();

  if (convErr?.code === "23505") {
    const { data: again } = await supabase
      .from("chat_conversations")
      .select("id")
      .eq("contact_id", contactId)
      .eq("channel_id", campaign.channel_id)
      .maybeSingle();
    if (again?.id) {
      const tenantDs = await fetchDataSchemaForEmpresaId(campaign.empresa_id);
      await ensureCentralChatConversationMirror({
        pool: getChatPostgresPool(),
        tenantDataSchema: tenantDs,
        empresaId: campaign.empresa_id,
        conversationId: again.id as string,
      });
      return { ok: true, contact_id: contactId, conversation_id: again.id as string };
    }
  }

  if (convErr || !conv?.id) {
    return { ok: false, error: convErr?.message ?? "Conversación" };
  }

  const tenantDsNew = await fetchDataSchemaForEmpresaId(campaign.empresa_id);
  await ensureCentralChatConversationMirror({
    pool: getChatPostgresPool(),
    tenantDataSchema: tenantDsNew,
    empresaId: campaign.empresa_id,
    conversationId: conv.id as string,
  });

  const ar = await assignConversation(supabase, conv.id as string);
  if (!ar.ok) {
    console.warn("[campaign-send] assignConversation", ar.error);
  }

  return { ok: true, contact_id: contactId, conversation_id: conv.id as string };
}

function mappedVarsToSlotRecord(mapped: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(mapped)) {
    const key = k.replace(/^\{\{|\}\}$/g, "").trim();
    out[key] = String(v ?? "").trim();
  }
  return out;
}

async function persistCampaignTemplateOutboundMessage(params: {
  supabase: SupabaseAdmin;
  campaign: CampaignOutboundRow;
  recipientId: string;
  conversationId: string;
  waMessageId: string | null;
  mappedBySlot: Record<string, string>;
  providerLabel: string;
}): Promise<void> {
  const previewText = buildCampaignTemplatePreviewText({
    templateName: params.campaign.template_name,
    languageCode: params.campaign.template_language,
    componentsSnapshot: params.campaign.template_components_json as unknown[],
    mappedBySlot: params.mappedBySlot,
  });
  const ts = new Date().toISOString();
  const rawPayload: Record<string, unknown> = {
    source: "campaign_outbound",
    campaign_id: params.campaign.id,
    campaign_recipient_id: params.recipientId,
    template_name: params.campaign.template_name,
    template_language: params.campaign.template_language,
    provider: params.providerLabel,
  };
  if (params.waMessageId) {
    rawPayload.provider_message_id = params.waMessageId;
  }

  const { error: insErr } = await params.supabase.from("chat_messages").insert({
    empresa_id: params.campaign.empresa_id,
    conversation_id: params.conversationId,
    wa_message_id: params.waMessageId,
    from_me: true,
    sender_type: "system",
    automation_source: "campaign",
    message_type: "template",
    content: previewText,
    raw_payload: rawPayload,
  });
  if (insErr) {
    console.warn("[campaign-send] persist_chat_message_failed", insErr.message);
    return;
  }

  await params.supabase
    .from("chat_conversations")
    .update({
      last_message_at: ts,
      last_message_preview: previewText.slice(0, 280),
      updated_at: ts,
    })
    .eq("id", params.conversationId);
}

export type SendCampaignRecipientResult =
  | { ok: true; waMessageId: string | null }
  | { ok: false; error: string; code?: string };

export async function sendCampaignRecipientMessage(params: {
  supabase: SupabaseAdmin;
  campaign: CampaignOutboundRow;
  recipient: CampaignRecipientSendRow;
}): Promise<SendCampaignRecipientResult> {
  const { supabase, campaign, recipient } = params;
  const dataSchema = await fetchDataSchemaForEmpresaId(campaign.empresa_id);

  const ensured = await ensureContactAndConversationForCampaign(supabase, campaign, recipient.phone_e164);
  if (!ensured.ok) {
    return { ok: false, error: ensured.error };
  }

  await supabase
    .from("chat_campaign_recipients")
    .update({
      contact_id: ensured.contact_id,
      conversation_id: ensured.conversation_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", recipient.id)
    .eq("empresa_id", campaign.empresa_id);

  const mappedBySlot = mappedVarsToSlotRecord(
    (recipient.mapped_variables_json || {}) as Record<string, unknown>
  );

  const placeholderKeys = extractBodyPlaceholderKeysOrdered(campaign.template_components_json);
  const missingPlaceholders = placeholderKeys.filter((k) => !String(mappedBySlot[k] ?? "").trim());
  if (placeholderKeys.length > 0 && missingPlaceholders.length > 0) {
    return {
      ok: false,
      error: `Faltan valores para: ${missingPlaceholders.map((s) => `{{${s}}}`).join(", ")}`,
    };
  }

  logCampaignTemplateVarsResolved({
    campaign_id: campaign.id,
    recipient_id: recipient.id,
    template_name: campaign.template_name,
    placeholders_count: placeholderKeys.length,
    params_count: placeholderKeys.length,
    missing_placeholders: missingPlaceholders,
  });

  const cfg = (campaign.send_config_json ?? {}) as Record<string, unknown>;
  const headerFromConfig =
    typeof cfg.header_image_url === "string" ? cfg.header_image_url.trim() : "";

  if (templateSnapshotHasHeaderImage(campaign.template_components_json)) {
    if (!headerFromConfig || !isHttpsUrl(headerFromConfig)) {
      console.warn("[campaign-image-header][missing-url]");
      return {
        ok: false,
        error:
          "Falta la URL de cabecera válida (https) en la campaña. Validá el Excel y la configuración antes de enviar.",
      };
    }
  }

  const templatePayload = buildMetaCloudTemplatePayload({
    templateName: campaign.template_name,
    languageCode: campaign.template_language,
    componentsSnapshot: campaign.template_components_json,
    mappedBySlot,
    headerImageUrl: headerFromConfig || null,
  });

  const ctx = await resolveOutboundTextContextFromIds(
    supabase,
    { contactId: ensured.contact_id, channelId: campaign.channel_id },
    { dataSchema, empresaId: campaign.empresa_id }
  );

  const extId = `campaign:${campaign.id}:recipient:${recipient.id}`;
  const prov = String(campaign.provider ?? "").trim().toLowerCase();

  if (prov === "ycloud") {
    if (ctx.provider !== "ycloud") {
      return { ok: false, error: "Canal no es YCloud" };
    }
    const res = await sendYCloudWhatsappTemplateMessage({
      apiKey: ctx.apiKey,
      fromE164: ctx.fromE164,
      toDigits: normalizeWaPhone(recipient.phone_e164.replace(/^\+/, "")),
      templatePayload,
      externalId: extId,
    });
    if (!res.ok) {
      return {
        ok: false,
        error: res.error,
        code: res.status != null ? String(res.status) : undefined,
      };
    }
    await persistCampaignTemplateOutboundMessage({
      supabase,
      campaign,
      recipientId: recipient.id,
      conversationId: ensured.conversation_id,
      waMessageId: res.waMessageId,
      mappedBySlot,
      providerLabel: "ycloud",
    });
    return { ok: true, waMessageId: res.waMessageId };
  }

  if (ctx.provider !== "meta") {
    return { ok: false, error: "Proveedor no soportado para plantillas" };
  }

  const res = await sendWhatsAppTemplateMessage({
    toDigits: normalizeWaPhone(recipient.phone_e164.replace(/^\+/, "")),
    phoneNumberId: ctx.phoneNumberId,
    accessToken: ctx.accessToken,
    templatePayload,
  });

  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      code: res.status != null ? String(res.status) : undefined,
    };
  }
  await persistCampaignTemplateOutboundMessage({
    supabase,
    campaign,
    recipientId: recipient.id,
    conversationId: ensured.conversation_id,
    waMessageId: res.waMessageId,
    mappedBySlot,
    providerLabel: "meta",
  });
  return { ok: true, waMessageId: res.waMessageId };
}
