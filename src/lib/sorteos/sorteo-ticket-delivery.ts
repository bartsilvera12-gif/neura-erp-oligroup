import "server-only";

import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import { fetchSorteoRowTicketFieldsFromPg } from "@/lib/sorteos/sorteo-order-direct-pg";
import { persistOutgoingChatMessage } from "@/lib/chat/outgoing-message-persist";
import { resolveOutboundTextContextFromIds } from "@/lib/chat/outbound-send-dispatch";
import { sendWhatsAppImage } from "@/lib/chat/whatsapp-send-service";
import { sendYCloudWhatsappMediaViaLink } from "@/lib/chat/ycloud-send-service";
import type { EnsureSorteoOrderCreatedData } from "@/lib/sorteos/sorteo-order-from-chat";
import { flowDataStubFromEntrada, loadSorteoTicketEntradaDbSnapshot } from "@/lib/sorteos/sorteo-ticket-admin";
import {
  buildSorteoTicketRenderData,
  buildSorteoTicketRenderLogPayload,
} from "@/lib/sorteos/sorteo-ticket-render-data";
import {
  normalizeTicketImageConfig,
  SORTEO_TICKET_DEFAULT_STUB,
  type SorteoTicketDeliveryMode,
} from "@/lib/sorteos/sorteo-ticket-types";
import { renderTicketPngUnified, type SorteoTicketRenderInput } from "@/lib/sorteos/sorteo-ticket-render";
import {
  createSignedUrlForTicket,
  downloadAssetIfExists,
  ensureTicketBucketsExist,
  SORTEO_TICKET_ASSETS_BUCKET,
  SORTEO_TICKET_GENERATED_BUCKET,
  sorteoTicketAssetBackgroundPath,
  sorteoTicketAssetLogoPath,
  sorteoTicketAssetTemplateCandidates,
  sorteoTicketGeneratedPath,
  sorteoTicketGeneratedPathForCupon,
  uploadGeneratedTicketPng,
} from "@/lib/sorteos/sorteo-ticket-storage";

export type SorteoTicketTrigger = "confirmacion_final" | "comprobante_imagen";

type DeliveryRow = {
  id: string;
  status: string;
  template_revision: number;
  is_current: boolean;
};

function safeErr(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message;
    if (/key|token|password|secret|bearer|api-?key/i.test(m)) return "error_interno";
    return m.slice(0, 500);
  }
  return "error_desconocido";
}

async function loadEmpresaNombre(empresaId: string): Promise<string> {
  const catalog = createServiceRoleClient();
  const { data } = await catalog
    .from("empresas")
    .select("nombre")
    .eq("id", empresaId)
    .maybeSingle();
  const n = (data as { nombre?: string } | null)?.nombre;
  return (typeof n === "string" && n.trim() ? n.trim() : "Empresa");
}

/** Shim del webhook (`sorteos` por PG) o catálogo; si PostgREST falla en tenant, fallback SQL directo. */
async function loadSorteoRowForTicket(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  sorteoId: string;
}): Promise<{
  nombre: string;
  ticket_delivery_mode: SorteoTicketDeliveryMode | undefined;
  ticket_image_config: unknown;
  precio_por_boleto?: number;
} | null> {
  const { data, error } = await input.supabase
    .from("sorteos")
    .select("id, nombre, ticket_delivery_mode, ticket_image_config, precio_por_boleto")
    .eq("id", input.sorteoId)
    .maybeSingle();
  if (!error && data) {
    const precioNum = Number((data as { precio_por_boleto?: number | string | null }).precio_por_boleto);
    return {
      nombre: String((data as { nombre?: string }).nombre ?? "").trim(),
      ticket_delivery_mode: (data as { ticket_delivery_mode?: string }).ticket_delivery_mode as
        | SorteoTicketDeliveryMode
        | undefined,
      ticket_image_config: (data as { ticket_image_config?: unknown }).ticket_image_config,
      precio_por_boleto: Number.isFinite(precioNum) ? precioNum : undefined,
    };
  }
  const schema = await fetchDataSchemaForEmpresaId(input.empresaId);
  const pg = await fetchSorteoRowTicketFieldsFromPg(schema, input.sorteoId);
  if (!pg) {
    if (error) {
      console.warn("[sorteo-ticket] sorteo_row_pg_fallback_miss", {
        sorteoId: String(input.sorteoId).slice(0, 8),
        message: error.message,
      });
    }
    return null;
  }
  return {
    nombre: String(pg.nombre ?? "").trim(),
    ticket_delivery_mode: pg.ticket_delivery_mode as SorteoTicketDeliveryMode | undefined,
    ticket_image_config: pg.ticket_image_config,
  };
}

async function loadChatFlowDataNewestPerField(
  sb: AppSupabaseClient,
  conversationId: string
): Promise<Record<string, string>> {
  const cid = conversationId.trim();
  if (!cid) return {};
  const { data, error } = await sb
    .from("chat_flow_data")
    .select("field_name, field_value, updated_at")
    .eq("conversation_id", cid)
    .order("updated_at", { ascending: false });
  if (error || !data?.length) {
    if (error) {
      console.warn("[sorteo-ticket] chat_flow_data_load_warn", { message: error.message });
    }
    return {};
  }
  const out: Record<string, string> = {};
  for (const row of data as { field_name?: string; field_value?: unknown }[]) {
    const fn = typeof row.field_name === "string" ? row.field_name.trim() : "";
    if (!fn || fn in out) continue;
    out[fn] = String(row.field_value ?? "").trim();
  }
  return out;
}

async function mergeFlowDataForTicketRender(params: {
  supabase: AppSupabaseClient;
  conversationId: string | null;
  entradaId: string;
  flowData: Record<string, string>;
}): Promise<Record<string, string>> {
  const chatMap = params.conversationId?.trim()
    ? await loadChatFlowDataNewestPerField(params.supabase, params.conversationId)
    : {};
  /** Base: historial del chat; no pisar con vacíos del caller (p. ej. stub de regenerar). */
  const merged: Record<string, string> = { ...chatMap };
  for (const [k, v] of Object.entries(params.flowData)) {
    const t = (v ?? "").trim();
    if (t) merged[k] = t;
  }
  try {
    const stub = await flowDataStubFromEntrada(params.supabase, params.entradaId);
    for (const [k, v] of Object.entries(stub)) {
      const cur = (merged[k] ?? "").trim();
      const nv = (v ?? "").trim();
      if (!cur && nv) merged[k] = nv;
    }
  } catch (e) {
    console.warn("[sorteo-ticket] entrada_stub_merge_skip", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return merged;
}

export type MaybeGenerateAndSendSorteoTicketDeliveryInput = {
  supabase: AppSupabaseClient;
  empresaId: string;
  sorteoId: string;
  entradaId: string;
  conversationId: string | null;
  flowSessionId: string | null;
  contactId: string;
  channelId: string;
  orderResult: EnsureSorteoOrderCreatedData;
  flowData: Record<string, string>;
  trigger: SorteoTicketTrigger;
  /** Solo generar PNG + storage; sin WhatsApp (p. ej. regenerar diseño desde panel). */
  skipWhatsApp?: boolean;
};

export type MaybeGenerateAndSendSorteoTicketDeliveryResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  deliveryId?: string;
  lastStatus?: "pending" | "generated" | "sent" | "error";
  storageBucket?: string | null;
  storagePath?: string | null;
  whatsappMessageId?: string | null;
  provider?: string | null;
  /** Solo dry-run: signed URL creada y HEAD OK sobre el PNG */
  signedUrlCreated?: boolean;
  signedUrlHeadOk?: boolean;
  signedUrlError?: string | null;
};

/**
 * Genera PNG, sube a storage, envía por WhatsApp. Errores: no lanza; registra fila `error`.
 */
export async function maybeGenerateAndSendSorteoTicketDelivery(
  input: MaybeGenerateAndSendSorteoTicketDeliveryInput
): Promise<MaybeGenerateAndSendSorteoTicketDeliveryResult> {
  const {
    supabase,
    empresaId,
    sorteoId,
    entradaId,
    conversationId,
    flowSessionId,
    orderResult,
    flowData,
    trigger,
  } = input;

  console.info("[sorteo-ticket] delivery_start", {
    entradaId,
    sorteoId,
    trigger,
    empresaId,
    conversationId,
    skipWhatsApp: Boolean(input.skipWhatsApp),
  });

  const schema = await fetchDataSchemaForEmpresaId(empresaId);
  const db = supabase;

  const sorteoRow = await loadSorteoRowForTicket({ supabase, empresaId, sorteoId });
  if (!sorteoRow) {
    console.warn("[sorteo-ticket] sorteo_not_found", { sorteoId: String(sorteoId).slice(0, 8) });
    return { ok: true, skipped: true, reason: "sorteo_not_found" };
  }
  console.info("[sorteo-ticket] mode_resolved", {
    source: "delivery_fn",
    entradaId,
    raw_mode: sorteoRow.ticket_delivery_mode ?? null,
    nombre_present: Boolean(sorteoRow.nombre?.trim()),
  });

  const mode = sorteoRow.ticket_delivery_mode;
  const effectiveMode: SorteoTicketDeliveryMode = mode ?? "text_only";
  if (effectiveMode === "text_only") {
    console.info("[sorteo-ticket] skipped_text_only", { entradaId, phase: "delivery_fn" });
    return { ok: true, skipped: true, reason: "text_only" };
  }

  const config = normalizeTicketImageConfig(sorteoRow.ticket_image_config);
  const sorteoNombre = sorteoRow.nombre || "Sorteo";

  const { data: existList } = await db
    .from("sorteo_ticket_deliveries")
    .select("id, status, template_revision, is_current")
    .eq("entrada_id", entradaId)
    .eq("is_current", true)
    .limit(1);
  const current = (existList?.[0] ?? null) as DeliveryRow | null;
  if (current?.status === "sent") {
    console.info("[sorteo-ticket] skipped_already_sent", {
      entradaId,
      deliveryId: current?.id,
      status: current?.status,
    });
    return {
      ok: true,
      skipped: true,
      reason: "already_sent",
      deliveryId: current?.id,
      lastStatus: "sent",
    };
  }

  const { data: maxRows } = await db
    .from("sorteo_ticket_deliveries")
    .select("template_revision")
    .eq("entrada_id", entradaId)
    .order("template_revision", { ascending: false })
    .limit(1);
  const maxRev = Number((maxRows?.[0] as { template_revision?: number } | undefined)?.template_revision ?? 0) || 0;

  const templateRevision = current ? current.template_revision : maxRev + 1;
  const deliveryId = current?.id;

  const flowDataMerged = await mergeFlowDataForTicketRender({
    supabase: db,
    conversationId,
    entradaId,
    flowData,
  });
  const { data: prevPayloadRow } = await db
    .from("sorteo_ticket_deliveries")
    .select("payload_snapshot")
    .eq("entrada_id", entradaId)
    .eq("empresa_id", empresaId)
    .order("template_revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  const prevPayloadRaw = (prevPayloadRow as { payload_snapshot?: unknown } | null)?.payload_snapshot;
  const prevPayload =
    prevPayloadRaw != null && typeof prevPayloadRaw === "object" && !Array.isArray(prevPayloadRaw)
      ? (prevPayloadRaw as Record<string, unknown>)
      : null;

  const entradaDb = await loadSorteoTicketEntradaDbSnapshot(db, entradaId, empresaId);
  const { fields: normalized, sourceUsed } = buildSorteoTicketRenderData({
    entradaDb,
    flowData: flowDataMerged,
    orderResult,
    sorteoNombreCatalog: sorteoNombre,
    payloadSnapshot: prevPayload,
  });

  console.info("[sorteo-ticket] render_data_resolved", {
    entradaId,
    sorteoId,
    trigger,
    ...buildSorteoTicketRenderLogPayload({ fields: normalized, sourceUsed }),
  });

  const payloadSnapshot = {
    trigger,
    idempotent: orderResult.idempotent,
    cupones: normalized.cupones,
    sorteo_nombre: normalized.sorteoNombre,
  };

  const numeroOrdenRow = (normalized.numeroOrden || "").trim() || String(orderResult.numeroOrden);

  let rowId = deliveryId ?? "";
  if (!rowId) {
    const ins = await db
      .from("sorteo_ticket_deliveries")
      .insert({
        empresa_id: empresaId,
        sorteo_id: sorteoId,
        entrada_id: entradaId,
        conversation_id: conversationId?.trim() || null,
        flow_session_id:
          flowSessionId && /^[0-9a-f-]{36}$/i.test(flowSessionId.trim()) ? flowSessionId.trim() : null,
        delivery_mode: effectiveMode,
        status: "pending",
        cliente_nombre: normalized.clienteNombre.trim() || null,
        cliente_documento: normalized.documento.trim() || null,
        telefono: normalized.telefono.trim() || null,
        numero_orden: numeroOrdenRow,
        cupones: orderResult.cupones.map((c) => ({ id: c.id, numero_cupon: c.numero_cupon })),
        payload_snapshot: payloadSnapshot,
        config_snapshot: config as Record<string, unknown>,
        template_revision: templateRevision,
        is_current: true,
      })
      .select("id")
      .maybeSingle();
    if (ins.error || !ins.data) {
      console.warn("[sorteo-ticket] insert_pending_failed", { message: ins.error?.message });
      return { ok: false, skipped: false, reason: "insert_failed" };
    }
    rowId = (ins.data as { id: string }).id;
    console.info("[sorteo-ticket] delivery_saved", {
      deliveryId: rowId,
      status: "pending",
      phase: "insert",
    });
  } else if (current?.status === "error") {
    await db
      .from("sorteo_ticket_deliveries")
      .update({
        status: "pending",
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);
  }

  try {
    await ensureTicketBucketsExist(supabase);

    console.info("[sorteo-ticket] render_start", { deliveryId: rowId, entradaId });

    const empresaNombre = await loadEmpresaNombre(empresaId);
    const logoPath = sorteoTicketAssetLogoPath(empresaId, sorteoId);
    const bgPath = sorteoTicketAssetBackgroundPath(empresaId, sorteoId);
    let logoDl = await downloadAssetIfExists(supabase, SORTEO_TICKET_ASSETS_BUCKET, logoPath);
    if (!logoDl) {
      logoDl = await downloadAssetIfExists(
        supabase,
        SORTEO_TICKET_ASSETS_BUCKET,
        `${empresaId}/${sorteoId}/logo.webp`
      );
    }
    const bgDl = await downloadAssetIfExists(supabase, SORTEO_TICKET_ASSETS_BUCKET, bgPath);

    let templateDl: { bytes: Buffer; mime: string } | null = null;
    if ((config.design_mode ?? "auto") === "custom_template") {
      const tb = config.custom_template_storage_bucket?.trim() || SORTEO_TICKET_ASSETS_BUCKET;
      const tp = config.custom_template_storage_path?.trim();
      if (tp) {
        templateDl = await downloadAssetIfExists(supabase, tb, tp);
      }
      if (!templateDl) {
        for (const cand of sorteoTicketAssetTemplateCandidates(empresaId, sorteoId)) {
          templateDl = await downloadAssetIfExists(supabase, SORTEO_TICKET_ASSETS_BUCKET, cand);
          if (templateDl) break;
        }
      }
    }

    const fechaHora = new Date().toLocaleString("es-PY", {
      dateStyle: "short",
      timeStyle: "short",
    });

    const renderInput: SorteoTicketRenderInput = {
      empresaNombre,
      sorteoNombre: (normalized.sorteoNombre || orderResult.sorteoNombre || sorteoNombre).trim(),
      clienteNombre: normalized.clienteNombre.trim() || undefined,
      documento: normalized.documento.trim() || undefined,
      telefono: normalized.telefono.trim() || undefined,
      ciudad: normalized.ciudad,
      numeroOrden: (normalized.numeroOrden || "").trim() || String(orderResult.numeroOrden),
      cupones: normalized.cupones,
      ...(typeof sorteoRow.precio_por_boleto === "number" && sorteoRow.precio_por_boleto > 0
        ? { precioGs: sorteoRow.precio_por_boleto }
        : {}),
      fechaHora,
      config,
      logoBytes: logoDl?.bytes ?? null,
      logoMime: logoDl?.mime ?? null,
      backgroundBytes: bgDl?.bytes ?? null,
      backgroundMime: bgDl?.mime ?? null,
      templateBytes: templateDl?.bytes ?? null,
      templateMime: templateDl?.mime ?? null,
    };

    // ===== Una imagen por boleta =====
    // Si la orden tiene 2+ cupones, se genera y envía UNA imagen por cada
    // cupón (pedido del cliente: "compra 3 boletas → recibe 3 imágenes", no
    // todas en una sola imagen). Con 0 o 1 cupón el comportamiento es idéntico
    // al histórico: una sola imagen con el mismo path clásico.
    const cuponesEmit = normalized.cupones.filter((c) => String(c).trim());
    const perCupon = cuponesEmit.length > 1;

    type TicketJob = { cupones: string[]; path: string; cupon: string | null };
    const jobs: TicketJob[] = perCupon
      ? cuponesEmit.map((c, i) => ({
          cupones: [c],
          path: sorteoTicketGeneratedPathForCupon(
            empresaId,
            sorteoId,
            entradaId,
            templateRevision,
            i + 1
          ),
          cupon: c,
        }))
      : [
          {
            cupones: normalized.cupones,
            path: sorteoTicketGeneratedPath(empresaId, sorteoId, entradaId, templateRevision),
            cupon: cuponesEmit[0] ?? null,
          },
        ];

    // Render + upload de todas las imágenes primero; recién después se envían.
    const rendered: { path: string; hash: string; cupon: string | null }[] = [];
    for (const job of jobs) {
      const { png, hash } = await renderTicketPngUnified({ ...renderInput, cupones: job.cupones });
      const up = await uploadGeneratedTicketPng(supabase, job.path, png);
      if (up.error) {
        throw new Error(up.error);
      }
      rendered.push({ path: job.path, hash, cupon: job.cupon });
      console.info("[sorteo-ticket] storage_uploaded", {
        bucket: SORTEO_TICKET_GENERATED_BUCKET,
        storage_path: job.path,
        deliveryId: rowId,
      });
    }

    const primary = rendered[0]!;
    const cuponImages = rendered.map((r) => ({ path: r.path, cupon: r.cupon }));

    await db
      .from("sorteo_ticket_deliveries")
      .update({
        status: "generated",
        storage_bucket: "sorteo-tickets-generated",
        storage_path: primary.path,
        png_bytes_hash: primary.hash,
        // `cupon_images`: lista completa de imágenes por boleta (para reenvío y
        // para que el proxy del ERP renderice cada una inline).
        payload_snapshot: { ...payloadSnapshot, cupon_images: cuponImages },
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);

    console.info("[sorteo-ticket] delivery_saved", {
      deliveryId: rowId,
      status: "generated",
      storage_path: primary.path,
      images: rendered.length,
    });

    if (input.skipWhatsApp) {
      const signedDry = await createSignedUrlForTicket(supabase, primary.path, 600);
      let headOk = false;
      if (signedDry.url) {
        try {
          const head = await fetch(signedDry.url, { method: "HEAD" });
          headOk = head.ok;
        } catch {
          headOk = false;
        }
      }
      console.info("[sorteo-ticket] signed_url_created", {
        deliveryId: rowId,
        hasUrl: Boolean(signedDry.url),
        signedUrlHeadOk: headOk,
        phase: "dry_run",
      });
      return {
        ok: true,
        deliveryId: rowId,
        lastStatus: "generated",
        storageBucket: "sorteo-tickets-generated",
        storagePath: primary.path,
        signedUrlCreated: Boolean(signedDry.url),
        signedUrlHeadOk: headOk,
        signedUrlError: signedDry.error ?? null,
      };
    }

    let outbound: Awaited<ReturnType<typeof resolveOutboundTextContextFromIds>>;
    try {
      outbound = await resolveOutboundTextContextFromIds(
        supabase,
        { contactId: input.contactId, channelId: input.channelId },
        { dataSchema: schema, empresaId }
      );
    } catch (e) {
      throw new Error(safeErr(e));
    }

    const caption =
      (config.caption ?? "").trim() ||
      (config.title ?? "").trim() ||
      `Orden Nº ${orderResult.numeroOrden} — ${sorteoNombre}`.slice(0, 1024);

    console.info("[sorteo-ticket] whatsapp_send_start", {
      deliveryId: rowId,
      provider: outbound.provider,
      channelId: input.channelId,
      contactId: input.contactId,
      images: rendered.length,
    });

    // Envío secuencial: una imagen por boleta, mismo caption en todas.
    let firstWaId: string | null = null;
    for (let i = 0; i < rendered.length; i++) {
      const img = rendered[i]!;
      const signed = await createSignedUrlForTicket(supabase, img.path, 600);
      if (!signed.url) {
        throw new Error(signed.error ?? "signed_url");
      }

      let sendResult: { ok: boolean; waMessageId?: string | null; raw?: unknown; error?: string };
      if (outbound.provider === "ycloud") {
        sendResult = await sendYCloudWhatsappMediaViaLink({
          apiKey: outbound.apiKey,
          fromE164: outbound.fromE164,
          toDigits: outbound.toDigits,
          kind: "image",
          mediaLink: signed.url,
          caption,
        });
      } else {
        sendResult = await sendWhatsAppImage({
          toDigits: outbound.toDigits,
          phoneNumberId: outbound.phoneNumberId,
          accessToken: outbound.accessToken,
          imageUrl: signed.url,
          caption,
        });
      }

      if (!sendResult.ok) {
        console.warn("[sorteo-ticket] whatsapp_send_error", {
          deliveryId: rowId,
          provider: outbound.provider,
          imageIndex: i + 1,
          error: sendResult.error ?? "send_failed",
        });
        throw new Error(sendResult.error ?? "send_failed");
      }

      const waId =
        typeof sendResult.waMessageId === "string" && sendResult.waMessageId
          ? sendResult.waMessageId
          : null;
      if (i === 0) firstWaId = waId;

      console.info("[sorteo-ticket] whatsapp_send_ok", {
        deliveryId: rowId,
        whatsapp_message_id: waId,
        provider: outbound.provider,
        imageIndex: i + 1,
      });

      if (conversationId?.trim()) {
        // Enriquecemos `raw_payload` con `image.link` apuntando al endpoint del
        // ERP que regenera signed URLs a demanda. Con varias boletas agregamos
        // `?p=<path>` (validado por prefijo de carpeta en el proxy) para que el
        // chat del ERP renderice inline la imagen exacta de cada boleta.
        const rawBase =
          typeof sendResult.raw === "object" && sendResult.raw !== null
            ? (sendResult.raw as Record<string, unknown>)
            : {};
        const erpImageProxy =
          rendered.length > 1
            ? `/api/sorteos/tickets/${rowId}/image?p=${encodeURIComponent(img.path)}`
            : `/api/sorteos/tickets/${rowId}/image`;
        const enrichedRaw: Record<string, unknown> = {
          ...rawBase,
          image: {
            link: erpImageProxy,
            caption: caption || undefined,
          },
          sorteo_ticket: {
            delivery_id: rowId,
            storage_bucket: "sorteo-tickets-generated",
            storage_path: img.path,
          },
        };
        await persistOutgoingChatMessage(supabase, {
          conversation: { id: conversationId.trim(), empresa_id: empresaId },
          content: caption ? `Ticket imagen\n${caption}` : "Ticket imagen enviado",
          messageType: "image",
          waMessageId: waId,
          raw: enrichedRaw,
          senderType: "system",
          automationSource: "sorteo_ticket",
        });
      }
    }

    await db
      .from("sorteo_ticket_deliveries")
      .update({
        status: "sent",
        whatsapp_message_id: firstWaId,
        provider: outbound.provider,
        channel_id: input.channelId,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", rowId);

    console.info("[sorteo-ticket] delivery_saved", {
      deliveryId: rowId,
      status: "sent",
      whatsapp_message_id: firstWaId,
      provider: outbound.provider,
      images: rendered.length,
    });

    return {
      ok: true,
      deliveryId: rowId,
      lastStatus: "sent",
      storageBucket: "sorteo-tickets-generated",
      storagePath: primary.path,
      whatsappMessageId: firstWaId,
      provider: outbound.provider,
    };
  } catch (e) {
    const msg = safeErr(e);
    console.warn("[sorteo-ticket] delivery_failed", {
      entradaId,
      deliveryId: rowId || null,
      reason: msg.slice(0, 200),
    });
    if (rowId) {
      await db
        .from("sorteo_ticket_deliveries")
        .update({
          status: "error",
          error_message: msg,
          updated_at: new Date().toISOString(),
        })
        .eq("id", rowId);
      console.warn("[sorteo-ticket] delivery_saved", {
        deliveryId: rowId,
        status: "error",
        error_message: msg.slice(0, 120),
      });
    }
    return {
      ok: false,
      skipped: false,
      reason: msg,
      deliveryId: rowId || undefined,
      lastStatus: rowId ? "error" : undefined,
    };
  }
}

export type SorteoTicketPhaseResult = {
  suppressPlainTextBody: boolean;
  needsPostFlowImage: boolean;
};

/**
 * Antes del mensaje de cierre del flujo: image_only intenta ticket; text_and_image difiere imagen.
 */
export async function runSorteoTicketPreClose(params: {
  supabase: AppSupabaseClient;
  empresaId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  flowSessionId: string | null;
  orderResult: EnsureSorteoOrderCreatedData;
  flowData: Record<string, string>;
  trigger: SorteoTicketTrigger;
}): Promise<SorteoTicketPhaseResult> {
  console.info("[sorteo-ticket] pre_close_enter", {
    trigger: params.trigger,
    conversationId: params.conversationId,
    sorteoId: params.orderResult.sorteoId,
    entradaId: params.orderResult.entradaId,
  });

  const meta = await loadSorteoRowForTicket({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
  });
  if (!meta) {
    console.warn("[sorteo-ticket] pre_close_sorteo_meta_miss", {
      sorteoId: String(params.orderResult.sorteoId).slice(0, 8),
    });
    return { suppressPlainTextBody: false, needsPostFlowImage: false };
  }
  const effectiveMode: SorteoTicketDeliveryMode = meta.ticket_delivery_mode ?? "text_only";

  console.info("[sorteo-ticket] mode_resolved", {
    source: "pre_close",
    effectiveMode,
    raw_mode: meta.ticket_delivery_mode ?? null,
    sorteoId: params.orderResult.sorteoId,
  });

  if (effectiveMode === "text_only") {
    console.info("[sorteo-ticket] skipped_text_only", {
      phase: "pre_close",
      entradaId: params.orderResult.entradaId,
    });
    return { suppressPlainTextBody: false, needsPostFlowImage: false };
  }
  if (effectiveMode === "text_and_image") {
    console.info("[sorteo-ticket] pre_close_defer_image_to_after_text", {
      entradaId: params.orderResult.entradaId,
    });
    return { suppressPlainTextBody: false, needsPostFlowImage: true };
  }

  // BACKGROUND: la generación de PNG no debe bloquear el response del webhook
  // ni el siguiente paso del flow-engine. sharp es CPU-intensivo (~1-2 min en
  // contenedor self-hosted) y bloqueaba el event loop si se awaitaba aquí.
  // Lanzamos sin await; errores quedan en console.error pero no propagan.
  // En image_only no podemos suprimir el texto (no esperamos resultado del
  // render), así que cliente recibe texto + PNG cuando llegue.
  void maybeGenerateAndSendSorteoTicketDelivery({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
    entradaId: params.orderResult.entradaId,
    conversationId: params.conversationId,
    flowSessionId: params.flowSessionId,
    contactId: params.contactId,
    channelId: params.channelId,
    orderResult: params.orderResult,
    flowData: params.flowData,
    trigger: params.trigger,
  }).catch((e) => {
    console.error("[sorteo-ticket] at_close_time_background_render_error", {
      entradaId: params.orderResult.entradaId,
      message: e instanceof Error ? e.message : String(e),
    });
  });

  return {
    suppressPlainTextBody: false,
    needsPostFlowImage: false,
  };
}

export async function runSorteoTicketAfterBuyerText(params: {
  supabase: AppSupabaseClient;
  empresaId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  flowSessionId: string | null;
  orderResult: EnsureSorteoOrderCreatedData;
  flowData: Record<string, string>;
  trigger: SorteoTicketTrigger;
}): Promise<void> {
  console.info("[sorteo-ticket] after_buyer_text_enter", {
    trigger: params.trigger,
    conversationId: params.conversationId,
    entradaId: params.orderResult.entradaId,
    channelId: params.channelId,
    contactId: params.contactId,
  });

  const meta = await loadSorteoRowForTicket({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
  });
  const mode = meta?.ticket_delivery_mode ?? "text_only";
  console.info("[sorteo-ticket] mode_resolved", {
    source: "after_buyer_text",
    effectiveMode: mode,
    raw_mode: meta?.ticket_delivery_mode ?? null,
  });

  if (mode !== "text_and_image") {
    console.info("[sorteo-ticket] after_buyer_text_skip", { mode, entradaId: params.orderResult.entradaId });
    return;
  }

  // BACKGROUND: ver comentario en runSorteoTicketAtCloseTime. El render PNG
  // bloquea sharp ~1-2 min y por eso aquí también disparamos sin await.
  void maybeGenerateAndSendSorteoTicketDelivery({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
    entradaId: params.orderResult.entradaId,
    conversationId: params.conversationId,
    flowSessionId: params.flowSessionId,
    contactId: params.contactId,
    channelId: params.channelId,
    orderResult: params.orderResult,
    flowData: params.flowData,
    trigger: params.trigger,
  }).catch((e) => {
    console.error("[sorteo-ticket] after_buyer_text_background_render_error", {
      entradaId: params.orderResult.entradaId,
      message: e instanceof Error ? e.message : String(e),
    });
  });
}

export async function getSorteoTicketDeliveryModeForSorteo(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  sorteoId: string;
}): Promise<SorteoTicketDeliveryMode> {
  const meta = await loadSorteoRowForTicket(input);
  return meta?.ticket_delivery_mode ?? "text_only";
}

/** Tras enviar el PNG en image_only: si tuvo éxito o ya estaba sent, se puede omitir el texto largo del nodo. */
export function shouldSuppressSorteoFinalTextAfterImageOnlyTicket(
  delivery: MaybeGenerateAndSendSorteoTicketDeliveryResult | null | undefined
): boolean {
  if (!delivery || !delivery.ok) {
    return false;
  }
  if (delivery.skipped) {
    return delivery.reason === "already_sent";
  }
  return delivery.lastStatus === "sent";
}

/**
 * Tras el mensaje de cierre (ej. nodo compra_realizada o resumen sin siguiente nodo):
 * genera y envía el ticket (trigger confirmacion_final). `delivery` null si el modo es text_only.
 */
export async function runSorteoTicketAfterFinalNodeMessage(params: {
  supabase: AppSupabaseClient;
  empresaId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  flowSessionId: string | null;
  orderResult: EnsureSorteoOrderCreatedData;
  flowData: Record<string, string>;
}): Promise<{
  mode: SorteoTicketDeliveryMode;
  delivery: MaybeGenerateAndSendSorteoTicketDeliveryResult | null;
}> {
  const meta = await loadSorteoRowForTicket({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
  });
  const mode: SorteoTicketDeliveryMode = meta?.ticket_delivery_mode ?? "text_only";
  if (mode === "text_only") {
    return { mode, delivery: null };
  }
  // BACKGROUND: ver comentario en runSorteoTicketAtCloseTime. No awaitamos
  // el render para liberar el event loop del flow-engine. Retornamos delivery
  // null para indicar "se está procesando aparte"; los callers ya manejan
  // este caso como "no suprimir texto" (cliente recibe texto inmediato + PNG
  // cuando termine el render en background).
  void maybeGenerateAndSendSorteoTicketDelivery({
    supabase: params.supabase,
    empresaId: params.empresaId,
    sorteoId: params.orderResult.sorteoId,
    entradaId: params.orderResult.entradaId,
    conversationId: params.conversationId,
    flowSessionId: params.flowSessionId,
    contactId: params.contactId,
    channelId: params.channelId,
    orderResult: params.orderResult,
    flowData: params.flowData,
    trigger: "confirmacion_final",
  }).catch((e) => {
    console.error("[sorteo-ticket] after_final_node_background_render_error", {
      entradaId: params.orderResult.entradaId,
      message: e instanceof Error ? e.message : String(e),
    });
  });
  return { mode, delivery: null };
}

export function buildImageOnlyStubText(config: Record<string, unknown>): string {
  const c = normalizeTicketImageConfig(config);
  return (c.ticket_image_only_stub ?? "").trim() || SORTEO_TICKET_DEFAULT_STUB;
}

/**
 * Reenvía por WhatsApp un ticket ya generado (misma fila, nuevo envío; no duplica orden).
 *
 * `captionOverride` (opcional) permite reemplazar el caption del envío manual sin
 * tocar el envío automático original del flujo (que sigue derivando el caption
 * desde `ticket_image_config`). Cuando se provee, gana sobre cualquier config.
 */
export async function resendSorteoTicketByDeliveryId(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  deliveryId: string;
  captionOverride?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const schema = await fetchDataSchemaForEmpresaId(input.empresaId);
  const db = input.supabase;

  const { data: row, error: r0 } = await db
    .from("sorteo_ticket_deliveries")
    .select(
      "id, entrada_id, sorteo_id, conversation_id, channel_id, storage_path, empresa_id, numero_orden, payload_snapshot"
    )
    .eq("id", input.deliveryId)
    .eq("empresa_id", input.empresaId)
    .maybeSingle();
  if (r0 || !row) return { ok: false, error: "not_found" };

  const storagePath = (row as { storage_path?: string | null }).storage_path?.trim();
  if (!storagePath) return { ok: false, error: "no_file" };

  // Lista de imágenes por boleta (si la orden tuvo 2+ cupones se guardó
  // `cupon_images` en payload_snapshot). Reenviar = mandar todas. Fallback:
  // una sola imagen (storage_path) para tickets viejos o de 1 boleta.
  const payloadSnap = (row as { payload_snapshot?: unknown }).payload_snapshot;
  const cuponImages =
    payloadSnap && typeof payloadSnap === "object" && !Array.isArray(payloadSnap)
      ? (payloadSnap as { cupon_images?: unknown }).cupon_images
      : null;
  const resendPaths: string[] = Array.isArray(cuponImages)
    ? cuponImages
        .map((c) =>
          c && typeof c === "object" ? String((c as { path?: unknown }).path ?? "").trim() : ""
        )
        .filter(Boolean)
    : [];
  if (resendPaths.length === 0) resendPaths.push(storagePath);

  const convId = (row as { conversation_id?: string | null }).conversation_id;
  if (!convId) return { ok: false, error: "no_conversation" };

  // Una boleta regenerada (nueva revisión) se inserta sin `channel_id` (solo se
  // fijaba al marcar "sent"). Para que "Reenviar" funcione sin tocar la base a
  // mano, si la fila no trae canal lo recuperamos de la conversación. No se
  // modifica la conversación ni el contacto: solo se lee su canal.
  let channelId = (row as { channel_id?: string | null }).channel_id?.trim() || null;

  const { data: conv } = await db
    .from("chat_conversations")
    .select("contact_id, channel_id")
    .eq("id", convId)
    .maybeSingle();
  const contactId = (conv as { contact_id?: string } | null)?.contact_id;
  if (!contactId) return { ok: false, error: "no_contact" };
  if (!channelId) {
    channelId = (conv as { channel_id?: string | null } | null)?.channel_id?.trim() || null;
  }
  if (!channelId) return { ok: false, error: "no_channel" };

  const sorteoId = (row as { sorteo_id: string }).sorteo_id;
  const sr = await loadSorteoRowForTicket({
    supabase: input.supabase,
    empresaId: input.empresaId,
    sorteoId,
  });
  const cfg = normalizeTicketImageConfig(sr?.ticket_image_config);
  const sorteoNombre = String(sr?.nombre ?? "").trim();

  let outbound: Awaited<ReturnType<typeof resolveOutboundTextContextFromIds>>;
  try {
    outbound = await resolveOutboundTextContextFromIds(
      input.supabase,
      { contactId, channelId },
      { dataSchema: schema, empresaId: input.empresaId }
    );
  } catch {
    return { ok: false, error: "outbound" };
  }

  const numOrden = String((row as { numero_orden?: string | null }).numero_orden ?? "");
  const overrideCaption = (input.captionOverride ?? "").trim();
  const caption = overrideCaption
    ? overrideCaption.slice(0, 1024)
    : (cfg.caption ?? "").trim() ||
      (cfg.title ?? "").trim() ||
      `Orden Nº ${numOrden} — ${sorteoNombre}`.slice(0, 1024);

  // Reenvío secuencial: una imagen por boleta, mismo caption en todas.
  let firstWaId: string | null = null;
  for (let i = 0; i < resendPaths.length; i++) {
    const path = resendPaths[i]!;
    const signed = await createSignedUrlForTicket(input.supabase, path, 600);
    if (!signed.url) return { ok: false, error: signed.error ?? "signed_url" };

    let sendResult: { ok: boolean; waMessageId?: string | null; raw?: unknown; error?: string };
    if (outbound.provider === "ycloud") {
      sendResult = await sendYCloudWhatsappMediaViaLink({
        apiKey: outbound.apiKey,
        fromE164: outbound.fromE164,
        toDigits: outbound.toDigits,
        kind: "image",
        mediaLink: signed.url,
        caption,
      });
    } else {
      sendResult = await sendWhatsAppImage({
        toDigits: outbound.toDigits,
        phoneNumberId: outbound.phoneNumberId,
        accessToken: outbound.accessToken,
        imageUrl: signed.url,
        caption,
      });
    }

    if (!sendResult.ok) return { ok: false, error: sendResult.error ?? "send_failed" };

    const waId =
      typeof sendResult.waMessageId === "string" && sendResult.waMessageId
        ? sendResult.waMessageId
        : null;
    if (i === 0) firstWaId = waId;

    // Mismo enriquecimiento que el envío automático: guardamos `image.link`
    // apuntando al endpoint del ERP que regenera signed URLs a demanda, para
    // que el chat del ERP renderice la imagen inline también en reenvíos. Con
    // varias boletas, `?p=<path>` apunta a la imagen exacta de cada una.
    const rawBase =
      typeof sendResult.raw === "object" && sendResult.raw !== null
        ? (sendResult.raw as Record<string, unknown>)
        : {};
    const erpImageProxy =
      resendPaths.length > 1
        ? `/api/sorteos/tickets/${input.deliveryId}/image?p=${encodeURIComponent(path)}`
        : `/api/sorteos/tickets/${input.deliveryId}/image`;
    const enrichedRaw: Record<string, unknown> = {
      ...rawBase,
      image: {
        link: erpImageProxy,
        caption: caption || undefined,
      },
      sorteo_ticket: {
        delivery_id: input.deliveryId,
        storage_bucket: "sorteo-tickets-generated",
        storage_path: path,
      },
    };
    await persistOutgoingChatMessage(input.supabase, {
      conversation: { id: convId, empresa_id: input.empresaId },
      content: caption ? `Ticket imagen (reenvío)\n${caption}` : "Ticket imagen reenviado",
      messageType: "image",
      waMessageId: waId,
      raw: enrichedRaw,
      senderType: "system",
      automationSource: "sorteo_ticket_resend",
    });
  }

  await db
    .from("sorteo_ticket_deliveries")
    .update({
      // Dejamos el canal recuperado en la fila para que próximos reenvíos no
      // dependan de volver a resolverlo desde la conversación.
      channel_id: channelId,
      whatsapp_message_id: firstWaId,
      provider: outbound.provider,
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.deliveryId);

  return { ok: true };
}
