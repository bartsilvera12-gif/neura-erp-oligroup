"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BusinessAutomationConfigSection } from "@/components/chat/BusinessAutomationConfigSection";
import { BotWakeKeywordsSection } from "@/components/chat/BotWakeKeywordsSection";
import { ChannelQuickRepliesEditor } from "@/components/chat/ChannelQuickRepliesEditor";
import { ConfigCollapsibleSection } from "@/components/chat/ConfigCollapsibleSection";
import {
  ComprobanteValidationPanelComprobantesCore,
  ComprobanteValidationPanelDatosBancarios,
  ComprobanteValidationPanelMensajesYOcr,
} from "@/components/chat/ComprobanteValidationPanels";
import {
  comprobanteValidationSettingsForForm,
  defaultComprobanteValidationSettings,
  parseComprobanteValidationConfig,
  type ComprobanteValidationSettings,
} from "@/lib/chat/comprobante-validation-types";
import {
  businessAutomationSettingsForPersistence,
  defaultBusinessAutomationSettings,
  parseBusinessAutomationFromChannelConfig,
  type BusinessAutomationSettings,
} from "@/lib/chat/channel-business-automation-types";
import {
  saveChatChannel,
  saveYCloudWhatsappChannel,
  type ChatChannelFormInput,
  type ChatChannelRow,
} from "@/lib/chat/actions";
import { mapChannelSaveError } from "@/lib/chat/channel-save-errors";
import {
  parseBotWakeKeywordsSettingsFromConfig,
  type BotWakeKeywordsFormState,
} from "@/lib/chat/bot-wake-keywords";
import {
  defaultChannelFormSectionState,
  formSectionStateForPersistence,
  parseFormSectionStateFromChannelConfigWithCvSync,
  type ChannelFormSectionKey,
  type ChannelFormSectionStateMap,
} from "@/lib/chat/channel-form-section-state";

export type WhatsAppConnectionProfile = "meta" | "ycloud";

export function emptyWhatsAppChannelForm(): ChatChannelFormInput {
  return {
    nombre: "WhatsApp principal",
    meta_phone_number_id: "",
    provider_channel_id: "",
    activo: true,
    display_phone_number: "",
    whatsapp_access_token: "",
    meta_waba_id: "",
    meta_app_id: "",
    meta_verify_token: "",
  };
}

function rowToForm(row: ChatChannelRow): ChatChannelFormInput {
  const mp = row.meta_phone_number_id?.trim() ?? "";
  return {
    nombre: row.nombre ?? "WhatsApp",
    meta_phone_number_id: mp,
    provider_channel_id: row.provider_channel_id?.trim() || mp,
    activo: row.activo,
    display_phone_number:
      typeof row.config?.display_phone_number === "string" ? row.config.display_phone_number : "",
    whatsapp_access_token: "",
    meta_waba_id: typeof row.config?.meta_waba_id === "string" ? row.config.meta_waba_id : "",
    meta_app_id: typeof row.config?.meta_app_id === "string" ? row.config.meta_app_id : "",
    meta_verify_token: typeof row.config?.meta_verify_token === "string" ? row.config.meta_verify_token : "",
  };
}

function ycloudRowToLocal(row: ChatChannelRow) {
  const cfg = row.config ?? {};
  return {
    ycloud_api_key: "",
    ycloud_webhook_secret: typeof cfg.ycloud_webhook_secret === "string" ? cfg.ycloud_webhook_secret : "",
    ycloud_sender_id: typeof cfg.ycloud_sender_id === "string" ? cfg.ycloud_sender_id : "",
    ycloud_channel_id: typeof cfg.ycloud_channel_id === "string" ? cfg.ycloud_channel_id : "",
    ycloud_waba_id: typeof cfg.ycloud_waba_id === "string" ? cfg.ycloud_waba_id : "",
  };
}

function FormFeedback({
  error,
  success,
  id,
}: {
  error: string | null;
  success: string | null;
  id?: string;
}) {
  if (!error && !success) return null;
  return (
    <div className="space-y-2" id={id}>
      {error ? (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2">{error}</div>
      ) : null}
      {success ? (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg px-4 py-2">
          {success}
        </div>
      ) : null}
    </div>
  );
}

export type WhatsAppChannelFormProps = {
  mode: "create" | "edit";
  /** Perfil de conexión: mismos bloques operativos; solo cambian credenciales iniciales. */
  connectionProfile?: WhatsAppConnectionProfile;
  channelId?: string;
  initialRow?: ChatChannelRow | null;
  cancelHref?: string;
  onCancel?: () => void;
  onSaved?: (channelId: string) => void;
  submitLabelCreate?: string;
  submitLabelEdit?: string;
};

export function WhatsAppChannelForm({
  mode,
  connectionProfile = "meta",
  channelId,
  initialRow,
  cancelHref = "/configuracion/canales",
  onCancel,
  onSaved,
  submitLabelCreate = "Crear canal",
  submitLabelEdit = "Guardar cambios",
}: WhatsAppChannelFormProps) {
  const isYcloud = connectionProfile === "ycloud";

  const [form, setForm] = useState<ChatChannelFormInput>(() =>
    mode === "edit" && initialRow ? rowToForm(initialRow) : emptyWhatsAppChannelForm()
  );
  const [yc, setYc] = useState(() =>
    mode === "edit" && initialRow && isYcloud
      ? ycloudRowToLocal(initialRow)
      : {
          ycloud_api_key: "",
          ycloud_webhook_secret: "",
          ycloud_sender_id: "",
          ycloud_channel_id: "",
          ycloud_waba_id: "",
        }
  );
  const [cvSettings, setCvSettings] = useState<ComprobanteValidationSettings>(() => {
    const cv =
      mode === "edit" && initialRow
        ? parseComprobanteValidationConfig(initialRow.config)
        : defaultComprobanteValidationSettings();
    return cv;
  });
  const [baSettings, setBaSettings] = useState<BusinessAutomationSettings>(() =>
    mode === "edit" && initialRow
      ? parseBusinessAutomationFromChannelConfig(initialRow.config)
      : defaultBusinessAutomationSettings()
  );
  const [wakeSettings, setWakeSettings] = useState<BotWakeKeywordsFormState>(() =>
    mode === "edit" && initialRow
      ? parseBotWakeKeywordsSettingsFromConfig(initialRow.config)
      : parseBotWakeKeywordsSettingsFromConfig({})
  );
  const [sectionUi, setSectionUi] = useState<ChannelFormSectionStateMap>(() => {
    if (mode === "edit" && initialRow) {
      const cv = parseComprobanteValidationConfig(initialRow.config);
      return parseFormSectionStateFromChannelConfigWithCvSync(initialRow.config, cv.enabled);
    }
    return defaultChannelFormSectionState();
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const bottomFeedbackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (error) {
      bottomFeedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [error]);

  useEffect(() => {
    if (mode === "edit" && initialRow) {
      setForm(rowToForm(initialRow));
      const cv = parseComprobanteValidationConfig(initialRow.config);
      setCvSettings(cv);
      setBaSettings(parseBusinessAutomationFromChannelConfig(initialRow.config));
      setWakeSettings(parseBotWakeKeywordsSettingsFromConfig(initialRow.config));
      setSectionUi(parseFormSectionStateFromChannelConfigWithCvSync(initialRow.config, cv.enabled));
      if (isYcloud) {
        setYc(ycloudRowToLocal(initialRow));
      }
    }
  }, [mode, initialRow, isYcloud]);

  function patchSection(key: ChannelFormSectionKey, patch: Partial<ChannelFormSectionStateMap[ChannelFormSectionKey]>) {
    setSectionUi((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const cvPayload = comprobanteValidationSettingsForForm(cvSettings);
      const baPayload = businessAutomationSettingsForPersistence(baSettings);
      const fsPayload = formSectionStateForPersistence(sectionUi);

      if (isYcloud) {
        if (mode === "edit") {
          if (!channelId?.trim()) throw new Error("Canal no válido.");
          const id = await saveYCloudWhatsappChannel({
            id: channelId.trim(),
            nombre: form.nombre,
            activo: form.activo,
            ycloud_api_key: yc.ycloud_api_key || undefined,
            ycloud_webhook_secret: yc.ycloud_webhook_secret,
            ycloud_sender_id: yc.ycloud_sender_id,
            ycloud_channel_id: yc.ycloud_channel_id,
            ycloud_waba_id: yc.ycloud_waba_id,
            comprobante_validation: cvPayload,
            business_automation: baPayload,
            form_section_state: fsPayload,
            quick_replies_inbox_enabled: sectionUi.quick_replies.active,
            bot_wake_keywords_enabled: wakeSettings.enabled,
            bot_wake_keywords: wakeSettings.keywords,
            bot_wake_keywords_match_mode: wakeSettings.matchMode,
            bot_wake_on_any_message: wakeSettings.wakeOnAnyMessage,
          });
          setSuccess("Cambios guardados.");
          onSaved?.(id);
        } else {
          const id = await saveYCloudWhatsappChannel({
            nombre: form.nombre,
            activo: form.activo,
            ycloud_api_key: yc.ycloud_api_key || undefined,
            ycloud_webhook_secret: yc.ycloud_webhook_secret,
            ycloud_sender_id: yc.ycloud_sender_id,
            ycloud_channel_id: yc.ycloud_channel_id,
            ycloud_waba_id: yc.ycloud_waba_id,
            comprobante_validation: cvPayload,
            business_automation: baPayload,
            form_section_state: fsPayload,
            quick_replies_inbox_enabled: sectionUi.quick_replies.active,
            bot_wake_keywords_enabled: wakeSettings.enabled,
            bot_wake_keywords: wakeSettings.keywords,
            bot_wake_keywords_match_mode: wakeSettings.matchMode,
            bot_wake_on_any_message: wakeSettings.wakeOnAnyMessage,
          });
          setSuccess("Canal creado.");
          onSaved?.(id);
        }
        return;
      }

      if (mode === "edit") {
        if (!channelId?.trim()) {
          throw new Error("Canal no válido.");
        }
        const id = await saveChatChannel({
          ...form,
          id: channelId.trim(),
          comprobante_validation: cvPayload,
          business_automation: baPayload,
          form_section_state: fsPayload,
          quick_replies_inbox_enabled: sectionUi.quick_replies.active,
          bot_wake_keywords_enabled: wakeSettings.enabled,
          bot_wake_keywords: wakeSettings.keywords,
          bot_wake_keywords_match_mode: wakeSettings.matchMode,
            bot_wake_on_any_message: wakeSettings.wakeOnAnyMessage,
        });
        setSuccess("Cambios guardados.");
        onSaved?.(id);
      } else {
        const id = await saveChatChannel({
          ...form,
          comprobante_validation: cvPayload,
          business_automation: baPayload,
          form_section_state: fsPayload,
          quick_replies_inbox_enabled: sectionUi.quick_replies.active,
          bot_wake_keywords_enabled: wakeSettings.enabled,
          bot_wake_keywords: wakeSettings.keywords,
          bot_wake_keywords_match_mode: wakeSettings.matchMode,
            bot_wake_on_any_message: wakeSettings.wakeOnAnyMessage,
        });
        setSuccess("Canal creado.");
        onSaved?.(id);
      }
    } catch (err) {
      setError(
        mapChannelSaveError(err, isYcloud ? "ycloud" : "meta")
      );
    } finally {
      setSaving(false);
    }
  }

  const credTitle = isYcloud ? "Credenciales YCloud (coexistencia)" : "Credenciales y conexión";
  const credDescription = isYcloud
    ? "API key, secret de webhook, WABA ID (cuenta WhatsApp Business) e identificadores YCloud. El WABA es el que usa la API de plantillas para campañas."
    : "Identificadores Meta, token para enviar mensajes y estado del canal en el ERP.";

  return (
    <div className="w-full space-y-6">
      <FormFeedback error={error} success={success} id="canal-form-feedback-top" />

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-3">
          <ConfigCollapsibleSection
            title={credTitle}
            description={credDescription}
            active={sectionUi.credentials.active}
            expanded={sectionUi.credentials.expanded}
            onActiveChange={(v) => patchSection("credentials", { active: v })}
            onExpandedChange={(v) => patchSection("credentials", { expanded: v })}
          >
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Nombre en el ERP</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
                  value={form.nombre}
                  onChange={(e) => setForm((p) => ({ ...p, nombre: e.target.value }))}
                  placeholder="Ej: WhatsApp ventas"
                />
              </div>

              {isYcloud ? (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      API key / secret YCloud {mode === "create" ? "*" : "(vacío = no cambiar)"}
                    </label>
                    <input
                      type="password"
                      autoComplete="off"
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={yc.ycloud_api_key}
                      onChange={(e) => setYc((p) => ({ ...p, ycloud_api_key: e.target.value }))}
                      placeholder={mode === "edit" ? "Dejar vacío para conservar la clave guardada" : ""}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Webhook secret</label>
                    <input
                      type="password"
                      autoComplete="off"
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={yc.ycloud_webhook_secret}
                      onChange={(e) => setYc((p) => ({ ...p, ycloud_webhook_secret: e.target.value }))}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                        Sender / external ID
                      </label>
                      <input
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                        value={yc.ycloud_sender_id}
                        onChange={(e) => setYc((p) => ({ ...p, ycloud_sender_id: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                        Channel ID YCloud
                      </label>
                      <input
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                        value={yc.ycloud_channel_id}
                        onChange={(e) => setYc((p) => ({ ...p, ycloud_channel_id: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      WABA ID (WhatsApp Business Account)
                    </label>
                    <input
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={yc.ycloud_waba_id}
                      onChange={(e) => setYc((p) => ({ ...p, ycloud_waba_id: e.target.value }))}
                      placeholder="ID de la cuenta de negocio (plantillas / campañas)"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      Si ya cargaste Channel ID y el envío funciona pero fallan las campañas, pegá aquí el WABA que
                      muestra YCloud para esa cuenta.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      Phone number ID (Graph API) *
                    </label>
                    <input
                      required
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={form.meta_phone_number_id}
                      onChange={(e) => setForm((p) => ({ ...p, meta_phone_number_id: e.target.value }))}
                      placeholder="Ej: 123456789012345"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      Provider channel ID (opcional)
                    </label>
                    <input
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={form.provider_channel_id}
                      onChange={(e) => setForm((p) => ({ ...p, provider_channel_id: e.target.value }))}
                      placeholder="Por defecto se usa el mismo Phone number ID"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      Número visible (opcional)
                    </label>
                    <input
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
                      value={form.display_phone_number ?? ""}
                      onChange={(e) => setForm((p) => ({ ...p, display_phone_number: e.target.value }))}
                      placeholder="+595 981 000000"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      Se guarda en config para referencia; no afecta el webhook.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      WhatsApp Business Account ID (WABA) — opcional
                    </label>
                    <input
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={form.meta_waba_id ?? ""}
                      onChange={(e) => setForm((p) => ({ ...p, meta_waba_id: e.target.value }))}
                      placeholder="ID de la cuenta de negocio en Meta"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      App ID Meta — opcional
                    </label>
                    <input
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={form.meta_app_id ?? ""}
                      onChange={(e) => setForm((p) => ({ ...p, meta_app_id: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      Verify token (referencia en ERP) — opcional
                    </label>
                    <input
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={form.meta_verify_token ?? ""}
                      onChange={(e) => setForm((p) => ({ ...p, meta_verify_token: e.target.value }))}
                      placeholder="Si usás verificación por token distinto al global del servidor"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      El webhook público sigue validando contra{" "}
                      <code className="text-[10px] bg-slate-100 px-1 rounded">WHATSAPP_VERIFY_TOKEN</code> en el
                      servidor; este campo queda documentado en la fila del canal.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">
                      Token de acceso Meta (enviar mensajes)
                    </label>
                    <input
                      type="password"
                      autoComplete="off"
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono bg-white"
                      value={form.whatsapp_access_token ?? ""}
                      onChange={(e) => setForm((p) => ({ ...p, whatsapp_access_token: e.target.value }))}
                      placeholder={
                        mode === "edit"
                          ? "Dejar vacío para no cambiar el token guardado"
                          : "Pegá el token permanente de la app (WhatsApp)"
                      }
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      Necesario para enviar desde Conversaciones. Alternativa: variable{" "}
                      <code className="text-[10px] bg-slate-100 px-1 rounded">WHATSAPP_TOKEN</code> en el servidor.
                    </p>
                  </div>
                </>
              )}

              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={Boolean(form.activo)}
                  onChange={(e) => setForm((p) => ({ ...p, activo: e.target.checked }))}
                />
                Canal activo
                {isYcloud ? " (marca el canal como operativo en el ERP)" : " (recibe mensajes del webhook Meta)"}
              </label>
            </div>
          </ConfigCollapsibleSection>

          <ConfigCollapsibleSection
            title="Mensajes automáticos (estilo WhatsApp Business)"
            description="Bienvenida, horario de atención y aviso fuera de horario. Capa simple en el webhook, sin flujos."
            active={sectionUi.business_automation.active}
            expanded={sectionUi.business_automation.expanded}
            onActiveChange={(v) => patchSection("business_automation", { active: v })}
            onExpandedChange={(v) => patchSection("business_automation", { expanded: v })}
          >
            <BusinessAutomationConfigSection value={baSettings} onChange={setBaSettings} />
          </ConfigCollapsibleSection>

          <ConfigCollapsibleSection
            title="Palabras para despertar el bot"
            description="Definí qué mensajes pueden reiniciar o despertar el bot en este canal."
            active={sectionUi.bot_wake_keywords.active}
            expanded={sectionUi.bot_wake_keywords.expanded}
            onActiveChange={(v) => patchSection("bot_wake_keywords", { active: v })}
            onExpandedChange={(v) => patchSection("bot_wake_keywords", { expanded: v })}
          >
            <BotWakeKeywordsSection value={wakeSettings} onChange={setWakeSettings} />
          </ConfigCollapsibleSection>

          <ConfigCollapsibleSection
            title="Validación de comprobantes"
            description="Activación, monto vs flujo, duplicados, revisión manual y umbrales de OCR."
            active={sectionUi.comprobantes_core.active}
            expanded={sectionUi.comprobantes_core.expanded}
            onActiveChange={(v) => patchSection("comprobantes_core", { active: v })}
            onExpandedChange={(v) => patchSection("comprobantes_core", { expanded: v })}
          >
            <ComprobanteValidationPanelComprobantesCore value={cvSettings} onChange={setCvSettings} />
          </ConfigCollapsibleSection>

          <ConfigCollapsibleSection
            title="Datos bancarios esperados"
            description="Titular, cuenta y alias esperados para comparar con el OCR del comprobante."
            active={sectionUi.comprobantes_bank.active}
            expanded={sectionUi.comprobantes_bank.expanded}
            onActiveChange={(v) => patchSection("comprobantes_bank", { active: v })}
            onExpandedChange={(v) => patchSection("comprobantes_bank", { expanded: v })}
          >
            <ComprobanteValidationPanelDatosBancarios value={cvSettings} onChange={setCvSettings} />
          </ConfigCollapsibleSection>

          <ConfigCollapsibleSection
            title="Mensajes ante situaciones y reglas OCR"
            description="Textos para cada caso y tabla de reglas por campo OCR."
            active={sectionUi.comprobantes_messages.active}
            expanded={sectionUi.comprobantes_messages.expanded}
            onActiveChange={(v) => patchSection("comprobantes_messages", { active: v })}
            onExpandedChange={(v) => patchSection("comprobantes_messages", { expanded: v })}
          >
            <ComprobanteValidationPanelMensajesYOcr value={cvSettings} onChange={setCvSettings} />
          </ConfigCollapsibleSection>

          {mode === "edit" && channelId?.trim() ? (
            <ConfigCollapsibleSection
              title="Respuestas rápidas (inbox)"
              description="Plantillas reutilizables que los asesores insertan desde Conversaciones con el ícono de rayo."
              active={sectionUi.quick_replies.active}
              expanded={sectionUi.quick_replies.expanded}
              hideBodyWhenInactive
              onActiveChange={(v) =>
                patchSection("quick_replies", v ? { active: true } : { active: false, expanded: false })
              }
              onExpandedChange={(v) => {
                if (!sectionUi.quick_replies.active) return;
                patchSection("quick_replies", { expanded: v });
              }}
            >
              {sectionUi.quick_replies.active && sectionUi.quick_replies.expanded ? (
                <ChannelQuickRepliesEditor channelId={channelId.trim()} disabled={false} hideIntro />
              ) : null}
            </ConfigCollapsibleSection>
          ) : null}
        </div>

        <div ref={bottomFeedbackRef}>
          <FormFeedback error={error} success={success} id="canal-form-feedback-bottom" />
        </div>

        <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
          <button
            type="submit"
            disabled={saving}
            className="bg-[#0EA5E9] hover:bg-[#0284C7] disabled:opacity-50 text-white px-5 py-2.5 rounded-lg text-sm font-medium"
          >
            {saving ? "Guardando…" : mode === "edit" ? submitLabelEdit : submitLabelCreate}
          </button>
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="border border-slate-200 text-slate-700 hover:bg-slate-50 px-5 py-2.5 rounded-lg text-sm font-medium"
            >
              Volver al listado
            </button>
          ) : (
            <Link
              href={cancelHref}
              className="inline-flex items-center border border-slate-200 text-slate-700 hover:bg-slate-50 px-5 py-2.5 rounded-lg text-sm font-medium"
            >
              Volver
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}
