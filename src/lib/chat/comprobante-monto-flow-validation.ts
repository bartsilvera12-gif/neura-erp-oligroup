import type { AppSupabaseClient } from "@/lib/supabase/schema";
import {
  compactMontoOcrAuditForMotivo,
  type MontoOcrSelectionAudit,
} from "@/lib/chat/comprobante-ocr-monto-selection";

/** Orden por defecto alineado con augmentSorteoPricing / flujo sorteos. */
export const DEFAULT_MONTO_FIELDS_PRIORIDAD = ["monto", "monto_compra", "sorteo_monto_opcion"] as const;

export type MontoValidacionAuditStatus =
  | "omitido_config"
  | "omitido_sin_esperado"
  | "omitido_sin_ocr"
  | "omitido_ocr_implausible"
  | "coincide"
  | "discrepancia";

export type MontoValidacionAudit = {
  monto_validacion_esperado_gs: number | null;
  monto_validacion_ocr_gs: number | null;
  monto_validacion_diferencia_gs: number | null;
  monto_validacion_status: MontoValidacionAuditStatus | null;
  /** Resumen no sensible del picker OCR (opcional) */
  monto_ocr_pick_reason?: string | null;
  monto_ocr_candidates_compact?: string | null;
};

/** Parsea dígitos del string de monto elegido por `selectReceiptMontoFromOcrText`. */
export function parseMontoOcrDigitsToGs(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  const n = Number(d);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function parseExpectedFlowValueToGs(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const digits = t.replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/**
 * Lee chat_flow_data solo para el flow_session_id dado; primer campo con valor numérico válido según prioridad.
 */
export async function fetchExpectedMontoGsFromFlowSession(
  supabase: AppSupabaseClient,
  flowSessionId: string,
  fieldNames: string[]
): Promise<number | null> {
  const sid = flowSessionId.trim();
  if (!sid || fieldNames.length === 0) return null;

  const names = [...new Set(fieldNames.map((n) => n.trim()).filter(Boolean))];
  if (names.length === 0) return null;

  const { data, error } = await supabase
    .from("chat_flow_data")
    .select("field_name, field_value")
    .eq("flow_session_id", sid)
    .in("field_name", names);

  if (error || !data?.length) return null;

  const byLower = new Map<string, string>();
  for (const row of data as { field_name?: string; field_value?: string }[]) {
    const fn = (row.field_name ?? "").trim();
    if (!fn) continue;
    byLower.set(fn.toLowerCase(), row.field_value ?? "");
  }

  for (const name of names) {
    const v = byLower.get(name.toLowerCase());
    const parsed = parseExpectedFlowValueToGs(v);
    if (parsed != null) return parsed;
  }

  return null;
}

export type ValidateReceiptAmountAgainstFlowResult =
  | { apply: false; audit: MontoValidacionAudit }
  | { apply: true; ok: true; audit: MontoValidacionAudit }
  | { apply: true; ok: false; audit: MontoValidacionAudit };

/**
 * Capa opt-in: solo evalúa discrepancia cuando flag activo y existen ambos montos.
 * Si no aplica, devuelve apply:false y audit con status omitido_*.
 */
export async function validateReceiptAmountAgainstFlow(
  supabase: AppSupabaseClient,
  input: {
    flowSessionId: string;
    validar_monto_vs_flujo: boolean;
    monto_tolerancia_absoluta_gs: number;
    monto_fields_prioridad: string[];
    extractedMontoString: string;
    /**
     * Si el pipeline ya leyó `chat_flow_data`, evita una segunda query.
     * `undefined` = aún no consultado (se hará fetch si aplica).
     */
    precalcEsperadoGs?: number | null;
    montoOcrSelectionAudit?: MontoOcrSelectionAudit | null;
  }
): Promise<ValidateReceiptAmountAgainstFlowResult> {
  const emptyAudit = (): MontoValidacionAudit => ({
    monto_validacion_esperado_gs: null,
    monto_validacion_ocr_gs: null,
    monto_validacion_diferencia_gs: null,
    monto_validacion_status: null,
    monto_ocr_pick_reason: null,
    monto_ocr_candidates_compact: null,
  });

  const mergePickAudit = (base: MontoValidacionAudit): MontoValidacionAudit => {
    const a = input.montoOcrSelectionAudit;
    if (!a) return base;
    return {
      ...base,
      monto_ocr_pick_reason: a.chosen_reason,
      monto_ocr_candidates_compact: compactMontoOcrAuditForMotivo(a) || null,
    };
  };

  if (!input.validar_monto_vs_flujo) {
    return {
      apply: false,
      audit: mergePickAudit({
        ...emptyAudit(),
        monto_validacion_status: "omitido_config",
      }),
    };
  }

  const ocrGs = parseMontoOcrDigitsToGs(input.extractedMontoString);
  if (ocrGs == null) {
    return {
      apply: false,
      audit: mergePickAudit({
        ...emptyAudit(),
        monto_validacion_status: "omitido_sin_ocr",
      }),
    };
  }

  const fieldOrder =
    input.monto_fields_prioridad.length > 0
      ? input.monto_fields_prioridad
      : [...DEFAULT_MONTO_FIELDS_PRIORIDAD];

  const esperadoGs =
    input.precalcEsperadoGs !== undefined
      ? input.precalcEsperadoGs
      : await fetchExpectedMontoGsFromFlowSession(supabase, input.flowSessionId, fieldOrder);

  if (esperadoGs == null) {
    return {
      apply: false,
      audit: mergePickAudit({
        ...emptyAudit(),
        monto_validacion_esperado_gs: null,
        monto_validacion_ocr_gs: ocrGs,
        monto_validacion_diferencia_gs: null,
        monto_validacion_status: "omitido_sin_esperado",
      }),
    };
  }

  // Solo confiamos en el monto leído por OCR si parece un pago REAL del sorteo:
  // redondo (múltiplo de 1.000) y dentro de un rango sensato. Si no lo es, es casi
  // seguro que el OCR agarró otra cosa (nro de cuenta, una referencia larga, un
  // importe partido) y marcar "monto no coincide" sería un FALSO POSITIVO sobre una
  // orden legítima. En ese caso se omite la validación de monto (no se traba).
  const ocrPlausible = ocrGs >= 5000 && ocrGs <= 1_500_000 && ocrGs % 1000 === 0;
  if (!ocrPlausible) {
    return {
      apply: false,
      audit: mergePickAudit({
        ...emptyAudit(),
        monto_validacion_esperado_gs: esperadoGs,
        monto_validacion_ocr_gs: ocrGs,
        monto_validacion_diferencia_gs: null,
        monto_validacion_status: "omitido_ocr_implausible",
      }),
    };
  }

  const tol = Math.max(0, Math.round(Number(input.monto_tolerancia_absoluta_gs) || 0));
  const diff = Math.abs(esperadoGs - ocrGs);
  const ok = diff <= tol;

  return {
    apply: true,
    ok,
    audit: mergePickAudit({
      monto_validacion_esperado_gs: esperadoGs,
      monto_validacion_ocr_gs: ocrGs,
      monto_validacion_diferencia_gs: diff,
      monto_validacion_status: ok ? "coincide" : "discrepancia",
    }),
  };
}
