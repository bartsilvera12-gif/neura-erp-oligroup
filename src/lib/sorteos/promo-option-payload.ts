/**
 * Fuente única de verdad para el `option_payload` de una PROMO del flujo de WhatsApp.
 *
 * Una promo es un botón (`chat_flow_options`) cuyo payload lleva cantidad + monto promocional
 * (con las claves espejo que entiende el motor) y una ventana horaria (`promo_ventana`). Tanto
 * la pantalla de "Promociones" como el endpoint `/api/sorteos/promos` construyen/leen el payload
 * desde acá, para no duplicar la lógica (la misma forma que arma el editor de flujos en
 * `buildPayloadFromSimple`).
 */
import { parseMoneyPy } from "@/lib/sorteos/parse-money-py";
import { parsePromoVentana } from "@/lib/sorteos/promo-window";

export type PromoInput = {
  cantidad: number;
  monto: number;
  /** Nombre legible para reportes (opcional). */
  promoNombre?: string;
  /** Días ISO 1..7 (1 = lunes … 7 = domingo). */
  dias: number[];
  /** "HH:MM" (hora de Paraguay). */
  horaInicio: string;
  duracionHoras: number;
  activa: boolean;
};

export type PromoRead = {
  optionId: string;
  label: string;
  cantidad: number | null;
  monto: number | null;
  dias: number[];
  horaInicio: string;
  duracionHoras: number;
  activa: boolean;
};

function normalizeDias(dias: number[]): number[] {
  const set = new Set<number>();
  for (const d of dias) {
    const n = Math.trunc(Number(d));
    if (Number.isFinite(n) && n >= 1 && n <= 7) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Arma el `option_payload` de una promo a partir de la config simple. Mantiene cualquier otra
 * clave que ya tuviera el payload (ej. `producto`, `opcion_label`).
 */
export function buildPromoOptionPayload(
  input: PromoInput,
  existingPayload?: Record<string, unknown> | null
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(existingPayload ?? {}) };

  base.cantidad = Math.trunc(input.cantidad);

  const monto = Math.round(input.monto);
  // Claves espejo que lee el motor (ver augmentSorteoPricingFromInteractiveOption / manual-promos).
  base.monto = monto;
  base.monto_compra = monto;
  base.monto_promocional = monto;
  base.sorteo_monto_opcion = monto;
  base.precio_fuente = "promo";

  const nombre = (input.promoNombre ?? "").trim();
  if (nombre) base.promo_nombre = nombre;
  else delete base.promo_nombre;

  base.promo_ventana = {
    activa: input.activa,
    dias: normalizeDias(input.dias),
    hora_inicio: input.horaInicio.trim(),
    duracion_horas: Number.isFinite(input.duracionHoras) && input.duracionHoras > 0
      ? input.duracionHoras
      : 24,
  };

  return base;
}

type OptionLike = {
  id?: unknown;
  label?: unknown;
  option_payload?: unknown;
};

/** Lee una fila de opción a la forma simple que usa la pantalla. */
export function readPromoFromOption(option: OptionLike): PromoRead {
  const payload =
    option.option_payload && typeof option.option_payload === "object"
      ? (option.option_payload as Record<string, unknown>)
      : {};
  const ventana = parsePromoVentana(payload);

  const cantRaw = payload.cantidad;
  const cantidad =
    cantRaw == null ? null : Number.isFinite(Number(cantRaw)) ? Math.trunc(Number(cantRaw)) : null;

  const montoRaw = payload.monto ?? payload.monto_compra ?? payload.monto_promocional;
  const monto = montoRaw == null ? null : parseMoneyPy(String(montoRaw));

  return {
    optionId: String(option.id ?? ""),
    label: typeof option.label === "string" ? option.label : "",
    cantidad,
    monto: monto != null && monto > 0 ? Math.round(monto) : null,
    dias: ventana?.dias ?? [],
    horaInicio: ventana?.hora_inicio || "18:00",
    duracionHoras: ventana?.duracion_horas ?? 24,
    activa: ventana?.activa ?? true,
  };
}

/** `true` si la opción tiene una ventana de promo válida configurada. */
export function optionHasPromoVentana(payload: unknown): boolean {
  return parsePromoVentana(payload) != null;
}

/** Deriva un `meta_button_id` único (patrón del editor de flujos). */
export function buildUniqueMetaButtonId(label: string, used: Set<string>): string {
  let base =
    label
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50) || `promo_${Date.now()}`;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${n}`.slice(0, 50);
    n += 1;
  }
  return candidate;
}
