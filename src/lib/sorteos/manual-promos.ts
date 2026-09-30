import { parseMoneyPy } from "@/lib/sorteos/parse-money-py";

/**
 * Promos de venta tal como las ofrece el bot: cada botón/opción del flujo de WhatsApp
 * lleva en `option_payload` la cantidad de boletas y, cuando es promo, el monto.
 *
 * La pantalla de cupón manual lee de acá para que el vendedor elija la misma promo que
 * el cliente vería en el chat, en lugar de tipear cantidad y monto a mano (que es donde
 * se cuelan las diferencias de precio).
 */
export type ManualPromo = {
  /** Estable entre recargas: sirve de `key` y de valor seleccionado. */
  id: string;
  /** Texto del botón en el bot, p. ej. "20 boletas - Gs. 100.000". */
  label: string;
  cantidad: number;
  /** Monto total de la promo. `null` si la opción solo fija cantidad (se cobra a precio de lista). */
  monto: number | null;
};

/** Fila mínima de `chat_flow_options` necesaria para derivar una promo. */
export type FlowOptionRow = {
  id?: unknown;
  label?: unknown;
  option_value?: unknown;
  sort_order?: unknown;
  option_payload?: unknown;
};

/** Mismas claves de cantidad que acepta el motor de flujos al interpretar una opción. */
const QTY_KEYS = [
  "cantidad",
  "cantidad_boletos",
  "cantidad_boletas",
  "cantidad_numeros",
  "cantidad_entradas",
  "boletos",
  "boletas",
  "numeros",
  "entradas",
  "qty",
  "quantity",
];

/** Mismas claves de monto que el motor normaliza a `monto` con precio_fuente=promo. */
const MONTO_KEYS = ["monto", "monto_compra", "monto_promocional", "sorteo_monto_opcion"];

function toQty(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(String(raw).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.trunc(n);
}

/**
 * Cantidad de una opción, en el mismo orden de precedencia que usa el bot:
 * payload → option_value numérico → texto del label ("20 boletas").
 */
export function cantidadFromOption(row: FlowOptionRow): number | null {
  const payload =
    row.option_payload && typeof row.option_payload === "object"
      ? (row.option_payload as Record<string, unknown>)
      : null;

  if (payload) {
    const lower = new Map(Object.entries(payload).map(([k, v]) => [k.trim().toLowerCase(), v]));
    for (const k of QTY_KEYS) {
      const n = toQty(lower.get(k));
      if (n != null) return n;
    }
  }

  const ov = typeof row.option_value === "string" ? row.option_value.trim() : "";
  if (ov) {
    const direct = toQty(ov);
    if (direct != null) return direct;
    const lead = ov.match(/^(\d+)/);
    if (lead) {
      const n = toQty(lead[1]);
      if (n != null) return n;
    }
  }

  const label = typeof row.label === "string" ? row.label.trim() : "";
  for (const re of [/^(\d+)\s*bolet/i, /^(\d+)\s*entrada/i, /^(\d+)\s*ticket/i, /(\d+)\s*bolet/i, /^(\d+)\b/]) {
    const m = label.match(re);
    if (m) {
      const n = toQty(m[1]);
      if (n != null) return n;
    }
  }
  return null;
}

/** Monto de la opción desde el payload (`parseMoneyPy` para tolerar "100.000", "Gs 100000", etc.). */
export function montoFromOption(row: FlowOptionRow): number | null {
  const payload =
    row.option_payload && typeof row.option_payload === "object"
      ? (row.option_payload as Record<string, unknown>)
      : null;
  if (!payload) return null;
  const lower = new Map(Object.entries(payload).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const k of MONTO_KEYS) {
    const raw = lower.get(k);
    if (raw == null) continue;
    const parsed = parseMoneyPy(String(raw));
    if (parsed != null && parsed > 0) return Math.round(parsed);
  }
  return null;
}

/**
 * Convierte opciones del flujo en promos: se queda con las que definen cantidad y
 * deduplica por cantidad+monto, porque el mismo combo suele repetirse en varios nodos
 * del flujo (menú inicial, reintento, etc.).
 */
export function buildManualPromos(rows: FlowOptionRow[]): ManualPromo[] {
  const out: ManualPromo[] = [];
  const vistos = new Set<string>();

  for (const row of rows) {
    const cantidad = cantidadFromOption(row);
    if (cantidad == null) continue;
    const monto = montoFromOption(row);
    const clave = `${cantidad}|${monto ?? ""}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    const label = typeof row.label === "string" ? row.label.trim() : "";
    out.push({
      id: clave,
      label: label || `${cantidad} ${cantidad === 1 ? "boleta" : "boletas"}`,
      cantidad,
      monto,
    });
  }

  out.sort((a, b) => a.cantidad - b.cantidad || (a.monto ?? 0) - (b.monto ?? 0));
  return out;
}
