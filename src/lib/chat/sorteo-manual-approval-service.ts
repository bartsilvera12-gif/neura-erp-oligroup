import "server-only";

import {
  buildChatFlowDataUpsertsForSorteoOrder,
  finalizeSorteoOrderFromConfirmedFlowData,
  parseSorteoParticipantFromFlowData,
  parseSorteoPricingFromFlowData,
  prepareFlowDataForSorteoOrder,
} from "@/lib/sorteos/sorteo-order-from-chat";
import {
  MOTIVO_VALIDACION_ASESOR_PENDIENTE_DATOS,
  MOTIVO_VALIDACION_ASESOR_PENDIENTE_CONFIRMACION_CLIENTE,
  SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
  SORTEO_COMPROBANTE_VALIDACION_ID_FIELD,
} from "@/lib/chat/comprobante-validation-types";
import {
  findSorteoConfirmationReviewNodeCode,
  getFlowClosePurchasePolicy,
} from "@/lib/chat/sorteo-close-eligibility";
import {
  realignManualApprovalFlowSessionPointer,
  runManualApprovalResumeParticipantFlow,
} from "@/lib/chat/sorteo-manual-approval-resume-flow";
import { describeFlowCaptureCompletenessForLogs } from "@/lib/sorteos/sorteo-flow-capture-order";
import { loadHydratedFlowSessionData } from "@/lib/chat/flow-engine-service";
import { deliverSorteoPostOrderToCustomer } from "@/lib/chat/sorteo-post-order-customer-delivery";
import { buildOrderResultFromEntradaId } from "@/lib/sorteos/sorteo-ticket-admin";
import type { AppSupabaseClient } from "@/lib/supabase/schema";
import type { EnsureSorteoOrderCreatedData } from "@/lib/sorteos/sorteo-order-from-chat";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { createTenantPgChatSupabaseShim } from "@/lib/chat/tenant-pg-chat-supabase-shim";
import type { SupabaseAdmin } from "@/lib/chat/types";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { isLikelyUnexposedTenantChatSchema } from "@/lib/supabase/chat-data-schema";

export type ManualSorteoApprovalResult =
  | {
      ok: true;
      mode: "order_closed";
      reused: boolean;
      entradaId: string;
      numeroOrden: number;
      cuponesCount: number;
      sorteoId: string;
      whatsappWarning?: string;
      ticketWarning?: string;
    }
  | {
      ok: true;
      mode: "pending_participant_data";
      reused: boolean;
      missingFields: string[];
      nextNodeCode: string | null;
      whatsappWarning?: string;
      /** true si solo se corrigió active_flow_session_id (caso viejo desalineado). */
      sessionRealigned?: boolean;
    }
  | {
      ok: true;
      mode: "pending_final_confirmation";
      reused: boolean;
      nextNodeCode: string | null;
      whatsappWarning?: string;
    }
  | { ok: false; code: string; message: string };

type ValidationRow = {
  id: string;
  estado_validacion: string;
  motivo_validacion: string | null;
  conversation_id: string;
  flow_session_id: string;
  flow_code: string;
  sorteo_entrada_id: string | null;
};

function logManual(tag: string, payload: Record<string, unknown>) {
  console.info(`[sorteo-manual-approval][${tag}]`, payload);
}

/** Combo elegido por el operador al aprobar a mano (reemplaza al elegido por el cliente en el chat). */
export type ManualApprovalSelectedOption = {
  cantidad: number;
  /** Monto total del combo en Gs.; null = precio de lista. */
  monto: number | null;
  label?: string | null;
};

function describeCombo(cantidad: number | null, monto: number | null): string {
  const c = cantidad != null ? `${cantidad} boleta(s)` : "sin cantidad";
  return monto != null ? `${c} por Gs. ${monto}` : c;
}

function applySelectedOptionToFlowData(
  fd: Record<string, string>,
  opt: ManualApprovalSelectedOption
): Record<string, string> {
  const out = { ...fd };
  const q = String(Math.trunc(opt.cantidad));
  for (const k of [
    "sorteo_snap_cantidad",
    "sorteo_cantidad_opcion",
    "cantidad_boletos",
    "cantidad_boletas",
    "cantidad_numeros",
    "cantidad_entradas",
    "cantidad",
    "boletos",
    "boletas",
    "numeros",
    "entradas",
    "qty",
    "quantity",
  ]) {
    if (k in out || k === "sorteo_snap_cantidad" || k === "sorteo_cantidad_opcion" || k === "cantidad_boletos" || k === "cantidad") {
      out[k] = q;
    }
  }
  const m = opt.monto != null && opt.monto > 0 ? String(Math.round(opt.monto)) : "";
  for (const k of ["sorteo_snap_monto", "sorteo_monto_opcion", "monto_compra", "monto_promocional", "monto"]) {
    out[k] = m;
  }
  out["precio_fuente"] = m ? "promo" : "";
  const label = (opt.label ?? "").trim() || `${q} ${q === "1" ? "boleta" : "boletas"}`;
  for (const k of [
    "sorteo_snap_opcion_label",
    "opcion_label",
    "option_label",
    "sorteo_snap_resumen",
    "resumen_compra",
    "producto",
    "combo",
    "opcion",
    "descripcion",
  ]) {
    if (k in out || k.startsWith("sorteo_snap")) out[k] = label;
  }
  return out;
}

function readChatCombo(fd: Record<string, string>): { cantidad: number | null; monto: number | null; label: string } {
  const prepared = prepareFlowDataForSorteoOrder(fd);
  const p = parseSorteoParticipantFromFlowData({ ...prepared, nombre: prepared["nombre"] || "x" });
  const pricing = parseSorteoPricingFromFlowData(prepared);
  return {
    cantidad: p?.cantidad_boletos ?? null,
    monto: pricing.montoCompra,
    label: (prepared["sorteo_snap_opcion_label"] || prepared["opcion_label"] || "").trim(),
  };
}

/** Datos para el paso de confirmación: combo del chat y monto leído del comprobante. */
export async function getManualApprovalContext(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  validacionId: string;
}): Promise<
  | {
      ok: true;
      chatCantidad: number | null;
      chatMonto: number | null;
      chatLabel: string;
      ocrMonto: number | null;
    }
  | { ok: false; message: string }
> {
  const dataSchema = await fetchDataSchemaForEmpresaId(input.empresaId);
  const pool = getChatPostgresPool();
  const useShim = Boolean(pool && isLikelyUnexposedTenantChatSchema(dataSchema));
  const catalogSr = createServiceRoleClient();
  const sb: AppSupabaseClient = useShim
    ? (createTenantPgChatSupabaseShim({
        pool: pool!,
        schema: dataSchema,
        storageDelegate: catalogSr as SupabaseAdmin,
        rpcDelegate: catalogSr,
      }) as unknown as AppSupabaseClient)
    : input.supabase;
  const { data, error } = await sb
    .from("chat_comprobante_validaciones")
    .select("conversation_id, flow_session_id, flow_code, monto_validacion_ocr_gs")
    .eq("id", input.validacionId.trim())
    .eq("empresa_id", input.empresaId)
    .maybeSingle();
  if (error || !data) return { ok: false, message: error?.message ?? "Validación no encontrada" };
  const r = data as {
    conversation_id: string;
    flow_session_id: string;
    flow_code: string;
    monto_validacion_ocr_gs: number | string | null;
  };
  const fd = await loadHydratedFlowSessionData(sb, {
    empresaId: input.empresaId,
    conversationId: r.conversation_id,
    flowCode: String(r.flow_code ?? "").trim(),
    flowSessionId: String(r.flow_session_id ?? "").trim(),
  });
  const chat = readChatCombo(fd);
  const ocr = r.monto_validacion_ocr_gs != null ? Number(r.monto_validacion_ocr_gs) : null;
  return {
    ok: true,
    chatCantidad: chat.cantidad,
    chatMonto: chat.monto,
    chatLabel: chat.label,
    ocrMonto: ocr != null && Number.isFinite(ocr) && ocr > 0 ? ocr : null,
  };
}

export async function approveComprobanteAndCloseSorteoPurchase(input: {
  supabase: AppSupabaseClient;
  empresaId: string;
  usuarioId: string;
  validacionId: string;
  approvalNote?: string | null;
  /** Solo para tenants con close_purchase_only_on_final_confirmation: fuerza cierre + entrada como inbox_manual_close. */
  forceClosePurchase?: boolean;
  /** Combo elegido por el operador; si falta se usa el del chat. */
  selectedOption?: ManualApprovalSelectedOption | null;
}): Promise<ManualSorteoApprovalResult> {
  const vid = input.validacionId.trim();
  let note = (input.approvalNote ?? "").trim().slice(0, 2000);
  const dataSchema = await fetchDataSchemaForEmpresaId(input.empresaId);

  /**
   * PostgREST rechaza `db.schema = erp_*` si el schema no está en "Exposed schemas".
   * Para esos tenants, todas las lecturas/escrituras `chat_*` / `sorteos*` van por PG directo (shim).
   */
  const pool = getChatPostgresPool();
  const useTenantPgShim = Boolean(pool && isLikelyUnexposedTenantChatSchema(dataSchema));
  if (isLikelyUnexposedTenantChatSchema(dataSchema) && !pool) {
    logManual("error", { code: "no_pg_pool", schema: dataSchema, empresa_id: input.empresaId });
    return {
      ok: false,
      code: "no_pg_pool",
      message:
        "Este tenant no está expuesto en la API y falta pool Postgres en el servidor (SUPABASE_DB_URL). Contactá soporte.",
    };
  }

  const catalogSr = createServiceRoleClient();
  const tenantSb: AppSupabaseClient = useTenantPgShim
    ? (createTenantPgChatSupabaseShim({
        pool: pool!,
        schema: dataSchema,
        storageDelegate: catalogSr as SupabaseAdmin,
        rpcDelegate: catalogSr,
      }) as unknown as AppSupabaseClient)
    : input.supabase;

  logManual("start", {
    schema: dataSchema,
    empresa_id: input.empresaId,
    validation_id: vid,
    approved_by: input.usuarioId,
    data_client: useTenantPgShim ? "tenant_pg_shim" : "postgrest",
  });

  const { data: vRow, error: vErr } = await tenantSb
    .from("chat_comprobante_validaciones")
    .select(
      "id, estado_validacion, motivo_validacion, conversation_id, flow_session_id, flow_code, sorteo_entrada_id"
    )
    .eq("id", vid)
    .eq("empresa_id", input.empresaId)
    .maybeSingle();

  if (vErr) {
    logManual("error", { validation_id: vid, code: "query", message: vErr.message });
    return { ok: false, code: "query", message: vErr.message };
  }
  const row = vRow as ValidationRow | null;
  if (!row) {
    return { ok: false, code: "not_found", message: "Validación no encontrada" };
  }

  logManual("validation-loaded", {
    schema: dataSchema,
    empresa_id: input.empresaId,
    validation_id: row.id,
    estado_prev: row.estado_validacion,
    tiene_entrada: Boolean(row.sorteo_entrada_id),
  });

  const { data: conv, error: cErr } = await tenantSb
    .from("chat_conversations")
    .select("id, contact_id, channel_id")
    .eq("id", row.conversation_id)
    .eq("empresa_id", input.empresaId)
    .maybeSingle();
  if (cErr || !conv) {
    return { ok: false, code: "conversation", message: cErr?.message ?? "Conversación no encontrada" };
  }
  const contactId = String((conv as { contact_id?: string }).contact_id ?? "");
  const channelId = String((conv as { channel_id?: string }).channel_id ?? "");
  if (!contactId || !channelId) {
    return { ok: false, code: "conversation_incomplete", message: "Conversación sin contacto o canal" };
  }

  const flowCode = row.flow_code.trim();
  const flowSessionId = row.flow_session_id.trim();
  if (!flowCode || !flowSessionId) {
    return { ok: false, code: "flow", message: "Validación sin flow_code o flow_session_id" };
  }

  /** Idempotencia: ya linked entrada */
  if (row.sorteo_entrada_id) {
    const existing = await buildOrderResultFromEntradaId(
      tenantSb,
      row.sorteo_entrada_id,
      input.empresaId
    );
    if (existing) {
      logManual("order-reused", {
        schema: dataSchema,
        empresa_id: input.empresaId,
        validation_id: row.id,
        entrada_id: existing.entradaId,
        cupones_count: existing.cupones.length,
      });
      const hydFd = await loadHydratedFlowSessionData(tenantSb, {
        empresaId: input.empresaId,
        conversationId: row.conversation_id,
        flowCode,
        flowSessionId,
      });
      const sendOut = await deliverSorteoPostOrderToCustomer({
        supabase: tenantSb,
        empresaId: input.empresaId,
        conversationId: row.conversation_id,
        contactId,
        channelId,
        flowSessionId,
        orderResult: existing,
        flowData: hydFd,
        automationSource: "sorteo_manual_approval",
      });
      const whatsappWarning = sendOut.textError;
      const ticketWarning = sendOut.ticketError;
      logManual("done", {
        schema: dataSchema,
        empresa_id: input.empresaId,
        validation_id: row.id,
        entrada_id: existing.entradaId,
        reused: true,
        cupones_count: existing.cupones.length,
      });
      return {
        ok: true,
        mode: "order_closed",
        reused: true,
        entradaId: existing.entradaId,
        numeroOrden: existing.numeroOrden,
        cuponesCount: existing.cupones.length,
        sorteoId: existing.sorteoId,
        whatsappWarning,
        ticketWarning,
      };
    }
  }

  let hydFd = await loadHydratedFlowSessionData(tenantSb, {
    empresaId: input.empresaId,
    conversationId: row.conversation_id,
    flowCode,
    flowSessionId,
  });

  const selOpt = input.selectedOption;
  if (selOpt && Number.isFinite(selOpt.cantidad) && selOpt.cantidad >= 1 && selOpt.cantidad <= 1000) {
    const orig = readChatCombo(hydFd);
    hydFd = applySelectedOptionToFlowData(hydFd, selOpt);
    const audit = `[Aprobado por usuario ${input.usuarioId}. Combo original: ${describeCombo(orig.cantidad, orig.monto)}. Combo aprobado: ${describeCombo(Math.trunc(selOpt.cantidad), selOpt.monto)}]`;
    note = `${note ? note + " " : ""}${audit}`.slice(0, 2000);
    const keys = [
      "sorteo_snap_cantidad",
      "sorteo_cantidad_opcion",
      "cantidad_boletos",
      "cantidad",
      "sorteo_snap_monto",
      "sorteo_monto_opcion",
      "monto_compra",
      "monto_promocional",
      "monto",
      "precio_fuente",
      "sorteo_snap_opcion_label",
      "opcion_label",
      "option_label",
      "sorteo_snap_resumen",
      "resumen_compra",
    ];
    await tenantSb.from("chat_flow_data").upsert(
      keys.map((k) => ({
        empresa_id: input.empresaId,
        conversation_id: row.conversation_id,
        flow_code: flowCode,
        flow_session_id: flowSessionId,
        field_name: k,
        field_value: hydFd[k] ?? "",
      })),
      { onConflict: "flow_session_id,field_name" }
    );
  }

  hydFd = {
    ...hydFd,
    [SORTEO_COMPROBANTE_VALIDACION_ID_FIELD]: row.id,
    [SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD]: "aprobado_manual",
    [SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD]: "asesor_aprobo_comprobante",
  };

  const flowCompleteness = await describeFlowCaptureCompletenessForLogs(
    tenantSb,
    input.empresaId,
    flowCode,
    hydFd
  );
  const participantOk = !flowCompleteness?.firstIncomplete;
  if (!participantOk) {
    logManual("missing-fields", {
      schema: dataSchema,
      empresa_id: input.empresaId,
      validation_id: row.id,
      missing: flowCompleteness?.missing_fields ?? [],
      flow_required_fields: flowCompleteness?.required_fields ?? [],
    });

    if (
      row.estado_validacion === "aprobado_manual" &&
      String(row.motivo_validacion ?? "").trim() === MOTIVO_VALIDACION_ASESOR_PENDIENTE_DATOS
    ) {
      const { data: convAlign } = await tenantSb
        .from("chat_conversations")
        .select("active_flow_session_id")
        .eq("id", row.conversation_id)
        .eq("empresa_id", input.empresaId)
        .maybeSingle();
      const convSid = String(
        (convAlign as { active_flow_session_id?: string | null } | null)?.active_flow_session_id ?? ""
      ).trim();
      const valSid = flowSessionId.trim();
      if (convSid === valSid) {
        logManual("idempotent-pending-skip", {
          schema: dataSchema,
          empresa_id: input.empresaId,
          validation_id: row.id,
        });
        return {
          ok: true,
          mode: "pending_participant_data",
          reused: true,
          missingFields: flowCompleteness?.missing_fields ?? [],
          nextNodeCode: null,
        };
      }

      logManual("pending-session-realign", {
        schema: dataSchema,
        empresa_id: input.empresaId,
        validation_id: row.id,
        conversation_active_flow_session_id: convSid || null,
        validation_flow_session_id: valSid,
      });
      const ra = await realignManualApprovalFlowSessionPointer({
        supabase: tenantSb,
        empresaId: input.empresaId,
        conversationId: row.conversation_id,
        flowCode,
        validationFlowSessionId: valSid,
        validationId: row.id,
        usuarioId: input.usuarioId,
      });
      if (!ra.ok) {
        logManual("error", { phase: "session_realign", message: ra.error ?? "unknown" });
        return {
          ok: false,
          code: "session_realign",
          message: ra.error ?? "No se pudo alinear la sesión del flujo con la validación.",
        };
      }
      return {
        ok: true,
        mode: "pending_participant_data",
        reused: true,
        missingFields: flowCompleteness?.missing_fields ?? [],
        nextNodeCode: null,
        sessionRealigned: ra.realigned,
      };
    }

    const resumeTarget = flowCompleteness?.firstIncomplete
      ? {
          nodeCode: flowCompleteness.firstIncomplete.nodeCode,
          messageText: flowCompleteness.firstIncomplete.messageText,
          saveAsField: flowCompleteness.firstIncomplete.saveAsField,
        }
      : null;
    if (!resumeTarget) {
      logManual("error", { code: "no_resume_node", validation_id: row.id });
      return {
        ok: false,
        code: "no_resume_node",
        message:
          "El comprobante puede aprobarse pero no encontramos un paso del flujo para pedir los datos faltantes. Revisá la configuración del flujo o cargá los datos manualmente en el chat.",
      };
    }

    const prevEstP = row.estado_validacion;
    const prevMotP = row.motivo_validacion;

    const { error: upPend } = await tenantSb
      .from("chat_comprobante_validaciones")
      .update({
        estado_validacion: "aprobado_manual",
        motivo_validacion: MOTIVO_VALIDACION_ASESOR_PENDIENTE_DATOS,
        previous_estado_validacion: prevEstP,
        previous_motivo_validacion: prevMotP,
        manual_approval_usuario_id: input.usuarioId,
        manual_approval_at: new Date().toISOString(),
        manual_approval_source: "inbox_manual",
        manual_approval_note: note || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("empresa_id", input.empresaId);

    if (upPend) {
      logManual("error", { phase: "validation_update_pending", message: upPend.message });
      return { ok: false, code: "validation_update", message: upPend.message };
    }

    logManual("pending-data", {
      schema: dataSchema,
      empresa_id: input.empresaId,
      validation_id: row.id,
      next_node: resumeTarget.nodeCode,
    });

    console.info("[sorteo-manual-approval][resume-node-selected]", {
      missing_fields: flowCompleteness?.missing_fields ?? [],
      selected_node_code: resumeTarget.nodeCode,
      selected_save_as_field: resumeTarget.saveAsField,
      selection_reason: "flow_order",
    });

    try {
      const wOut = await runManualApprovalResumeParticipantFlow({
        supabase: tenantSb,
        empresaId: input.empresaId,
        usuarioId: input.usuarioId,
        conversationId: row.conversation_id,
        flowCode,
        flowSessionId,
        channelId,
        contactId,
        validationId: row.id,
        missingFields: flowCompleteness?.missing_fields ?? [],
        nextNodeCode: resumeTarget.nodeCode,
        note,
        mergedFlowDataPatch: {},
      });
      logManual("resume-flow", {
        schema: dataSchema,
        validation_id: row.id,
        conversation_id: row.conversation_id,
        next_node_code: resumeTarget.nodeCode,
      });
      logManual("done", {
        schema: dataSchema,
        empresa_id: input.empresaId,
        validation_id: row.id,
        mode: "pending_participant_data",
      });
      return {
        ok: true,
        mode: "pending_participant_data",
        reused: false,
        missingFields: flowCompleteness?.missing_fields ?? [],
        nextNodeCode: resumeTarget.nodeCode,
        whatsappWarning: wOut.whatsappWarning,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logManual("error", { phase: "resume_flow", message: msg });
      return { ok: false, code: "resume_flow", message: msg };
    }
  }

  const closePurchasePolicy = await getFlowClosePurchasePolicy(tenantSb, input.empresaId, flowCode);
  if (
    closePurchasePolicy.closePurchaseOnlyOnFinalConfirmation &&
    !input.forceClosePurchase &&
    participantOk
  ) {
    hydFd = {
      ...hydFd,
      [SORTEO_COMPROBANTE_VALIDACION_ID_FIELD]: row.id,
      [SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD]: "aprobado_manual",
      [SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD]:
        MOTIVO_VALIDACION_ASESOR_PENDIENTE_CONFIRMACION_CLIENTE,
    };

    const prevEstC = row.estado_validacion;
    const prevMotC = row.motivo_validacion;
    const { error: upValOnly } = await tenantSb
      .from("chat_comprobante_validaciones")
      .update({
        estado_validacion: "aprobado_manual",
        motivo_validacion: MOTIVO_VALIDACION_ASESOR_PENDIENTE_CONFIRMACION_CLIENTE,
        previous_estado_validacion: prevEstC,
        previous_motivo_validacion: prevMotC,
        manual_approval_usuario_id: input.usuarioId,
        manual_approval_at: new Date().toISOString(),
        manual_approval_source: "inbox_manual",
        manual_approval_note: note || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("empresa_id", input.empresaId);

    if (upValOnly) {
      logManual("error", { phase: "validation_update_validation_only", message: upValOnly.message });
      return { ok: false, code: "validation_update", message: upValOnly.message };
    }

    await tenantSb.from("chat_flow_data").upsert(
      [
        {
          empresa_id: input.empresaId,
          conversation_id: row.conversation_id,
          flow_code: flowCode,
          flow_session_id: flowSessionId,
          field_name: SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
          field_value: "aprobado_manual",
        },
        {
          empresa_id: input.empresaId,
          conversation_id: row.conversation_id,
          flow_code: flowCode,
          flow_session_id: flowSessionId,
          field_name: SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
          field_value: MOTIVO_VALIDACION_ASESOR_PENDIENTE_CONFIRMACION_CLIENTE,
        },
      ],
      { onConflict: "flow_session_id,field_name" }
    );

    const confirmNode = await findSorteoConfirmationReviewNodeCode(tenantSb, input.empresaId, flowCode);

    console.info("[sorteo-close][manual-approval-validation-only]", {
      schema: dataSchema,
      empresa_id: input.empresaId,
      validation_id: row.id,
      conversation_id: row.conversation_id,
      flow_session_id: flowSessionId,
      flow_code: flowCode,
      next_node_code: confirmNode,
    });

    if (!confirmNode) {
      return {
        ok: false,
        code: "no_confirmation_node",
        message:
          "No encontramos el nodo de resumen/confirmación en el flujo. Revisá la configuración del chat o usá cierre manual explícito.",
      };
    }

    try {
      const wOut = await runManualApprovalResumeParticipantFlow({
        supabase: tenantSb,
        empresaId: input.empresaId,
        usuarioId: input.usuarioId,
        conversationId: row.conversation_id,
        flowCode,
        flowSessionId,
        channelId,
        contactId,
        validationId: row.id,
        missingFields: [],
        nextNodeCode: confirmNode,
        note,
        resumeVariant: "pending_final_confirmation",
      });
      logManual("done", {
        schema: dataSchema,
        empresa_id: input.empresaId,
        validation_id: row.id,
        mode: "pending_final_confirmation",
      });
      return {
        ok: true,
        mode: "pending_final_confirmation",
        reused: false,
        nextNodeCode: confirmNode,
        whatsappWarning: wOut.whatsappWarning,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logManual("error", { phase: "resume_flow_pending_confirmation", message: msg });
      return { ok: false, code: "resume_flow", message: msg };
    }
  }

  const { data: contactRow } = await tenantSb
    .from("chat_contacts")
    .select("phone_number")
    .eq("id", contactId)
    .eq("empresa_id", input.empresaId)
    .maybeSingle();
  const waDigits = String((contactRow as { phone_number?: string } | null)?.phone_number ?? "").replace(/\D/g, "");
  if (!waDigits) {
    return { ok: false, code: "phone", message: "No se pudo resolver WhatsApp del contacto" };
  }

  logManual("finalize_invoke", {
    schema: dataSchema,
    empresa_id: input.empresaId,
    conversation_id: row.conversation_id,
    flow_session_id: flowSessionId,
    validation_id: row.id,
    force_close_purchase: Boolean(input.forceClosePurchase),
  });

  if (input.forceClosePurchase) {
    console.info("[sorteo-close][final-confirmation-ok]", {
      schema: dataSchema,
      empresa_id: input.empresaId,
      conversation_id: row.conversation_id,
      flow_session_id: flowSessionId,
      validation_id: row.id,
      approval_source: "inbox_manual_close",
    });
  }

  const fin = await finalizeSorteoOrderFromConfirmedFlowData(tenantSb, {
    empresaId: input.empresaId,
    conversationId: row.conversation_id,
    flowCode,
    flowSessionId,
    whatsappNumero: waDigits,
    flowData: hydFd,
  });

  if (!fin.ok) {
    logManual("error", {
      schema: dataSchema,
      empresa_id: input.empresaId,
      validation_id: row.id,
      message: fin.message,
    });
    return { ok: false, code: "finalize_failed", message: fin.message };
  }

  if (fin.skipped) {
    const msg =
      fin.reason === "sin_comprobante_en_sesion"
        ? "Falta comprobante o media en la sesión del flujo."
        : fin.reason === "datos_flujo_incompletos"
          ? "Datos del participante incompletos (revisión interna). Volvé a intentar o completá los datos en el flujo."
        : fin.reason === "comprobante_no_validado"
          ? "Estado de comprobante no permite cierre."
          : `No se pudo cerrar: ${fin.reason ?? "desconocido"}`;
    logManual("error", { validation_id: row.id, reason: fin.reason });
    return { ok: false, code: fin.reason ?? "skipped", message: msg };
  }

  const orderData: EnsureSorteoOrderCreatedData = fin;

  const ctxUpserts = buildChatFlowDataUpsertsForSorteoOrder(
    input.empresaId,
    row.conversation_id,
    flowCode,
    flowSessionId,
    orderData
  );
  const { error: ctxErr } = await tenantSb.from("chat_flow_data").upsert(ctxUpserts, {
    onConflict: "flow_session_id,field_name",
  });
  if (ctxErr) {
    logManual("error", { phase: "flow_data_order_context", message: ctxErr.message });
    return { ok: false, code: "flow_data", message: ctxErr.message };
  }

  const prevEst = row.estado_validacion;
  const prevMot = row.motivo_validacion;

  const { error: upErr } = await tenantSb
    .from("chat_comprobante_validaciones")
    .update({
      estado_validacion: "aprobado_manual",
      motivo_validacion: "asesor_aprobo_comprobante",
      sorteo_entrada_id: orderData.entradaId,
      previous_estado_validacion: prevEst,
      previous_motivo_validacion: prevMot,
      manual_approval_usuario_id: input.usuarioId,
      manual_approval_at: new Date().toISOString(),
      manual_approval_source: input.forceClosePurchase ? "inbox_manual_close" : "inbox_manual",
      manual_approval_note: note || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("empresa_id", input.empresaId);

  if (upErr) {
    logManual("error", { phase: "validation_update", message: upErr.message });
    return {
      ok: false,
      code: "validation_update",
      message:
        "La orden se registró pero falló actualizar la validación. Revisá en Entradas / Cupones. " + upErr.message,
    };
  }

  const estadoUpserts = [
    {
      empresa_id: input.empresaId,
      conversation_id: row.conversation_id,
      flow_code: flowCode,
      flow_session_id: flowSessionId,
      field_name: SORTEO_COMPROBANTE_ESTADO_VALIDACION_FIELD,
      field_value: "aprobado_manual",
    },
    {
      empresa_id: input.empresaId,
      conversation_id: row.conversation_id,
      flow_code: flowCode,
      flow_session_id: flowSessionId,
      field_name: SORTEO_COMPROBANTE_MOTIVO_VALIDACION_FIELD,
      field_value: "asesor_aprobo_comprobante",
    },
  ];
  await tenantSb.from("chat_flow_data").upsert(estadoUpserts, {
    onConflict: "flow_session_id,field_name",
  });

  await tenantSb.from("chat_flow_events").insert({
    empresa_id: input.empresaId,
    conversation_id: row.conversation_id,
    flow_code: flowCode,
    node_code: null,
    flow_session_id: flowSessionId,
    event_type: "sorteo_manual_approval",
    payload: {
      validation_id: row.id,
      entrada_id: orderData.entradaId,
      numero_orden: orderData.numeroOrden,
      approved_by: input.usuarioId,
      note: note || null,
      idempotent: orderData.idempotent === true,
    },
  });

  logManual("order-created", {
    schema: dataSchema,
    empresa_id: input.empresaId,
    conversation_id: row.conversation_id,
    flow_session_id: flowSessionId,
    validation_id: row.id,
    entrada_id: orderData.entradaId,
    sorteo_id: orderData.sorteoId,
    cupones_count: orderData.cupones.length,
    approved_by: input.usuarioId,
  });

  const mergedFlowForDelivery = {
    ...hydFd,
    ...Object.fromEntries(
      ctxUpserts.map((r) => [r.field_name, r.field_value] as [string, string])
    ),
  };

  const sendOut = await deliverSorteoPostOrderToCustomer({
    supabase: tenantSb,
    empresaId: input.empresaId,
    conversationId: row.conversation_id,
    contactId,
    channelId,
    flowSessionId,
    orderResult: orderData,
    flowData: mergedFlowForDelivery,
    automationSource: "sorteo_manual_approval",
  });

  logManual("ticket-sent", {
    schema: dataSchema,
    empresa_id: input.empresaId,
    conversation_id: row.conversation_id,
    flow_session_id: flowSessionId,
    validation_id: row.id,
    entrada_id: orderData.entradaId,
    sorteo_id: orderData.sorteoId,
    cupones_count: orderData.cupones.length,
    approved_by: input.usuarioId,
    text_ok: !sendOut.textError,
    ticket_ok: !sendOut.ticketError,
  });

  logManual("done", {
    schema: dataSchema,
    empresa_id: input.empresaId,
    validation_id: row.id,
    entrada_id: orderData.entradaId,
    cupones_count: orderData.cupones.length,
    approved_by: input.usuarioId,
  });

  return {
    ok: true,
    mode: "order_closed",
    reused: orderData.idempotent === true,
    entradaId: orderData.entradaId,
    numeroOrden: orderData.numeroOrden,
    cuponesCount: orderData.cupones.length,
    sorteoId: orderData.sorteoId,
    whatsappWarning: sendOut.textError,
    ticketWarning: sendOut.ticketError,
  };
}
