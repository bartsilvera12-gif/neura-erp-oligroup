/**
 * Ventana horaria de una promo del flujo de WhatsApp.
 *
 * La config vive dentro de `option_payload.promo_ventana` de una fila de `chat_flow_options`
 * (no hace falta columna nueva). Permite que un botón de promo aparezca y se pueda elegir
 * SOLO dentro de una franja semanal recurrente (ej. "jueves 18:00 por 24 hs").
 *
 * Días ISO 8601: 1 = lunes … 7 = domingo (igual que `omnicanal-shift-window.ts`).
 *
 * A diferencia de `omnicanal-shift-window.ts` (que compara contra la zona horaria del proceso),
 * acá anclamos el cálculo a **America/Asuncion** (patrón de `kpis-time-bounds.ts`), porque el
 * servidor no corre necesariamente en horario de Paraguay.
 */

const TZ = "America/Asuncion" as const;
const MIN_PER_DAY = 24 * 60;
const MIN_PER_WEEK = 7 * MIN_PER_DAY;

/** Config de ventana tal como se guarda en `option_payload.promo_ventana`. */
export type PromoVentana = {
  /** `false` = promo pausada (no se muestra). */
  activa: boolean;
  /** Días ISO 1..7 en que arranca la ventana (1 = lunes … 7 = domingo). */
  dias: number[];
  /** Hora de inicio "HH:MM" (hora de Paraguay). */
  hora_inicio: string;
  /** Duración en horas desde `hora_inicio` (puede cruzar la medianoche). */
  duracion_horas: number;
};

function toMinutesOfDay(hhmm: unknown): number | null {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function normalizeDias(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<number>();
  for (const v of raw) {
    const n = Math.trunc(Number(v));
    if (Number.isFinite(n) && n >= 1 && n <= 7) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Lee y valida `option_payload.promo_ventana`. Devuelve `null` si no hay config o es inválida
 * (en cuyo caso la opción se trata como "siempre visible").
 */
export function parsePromoVentana(payload: unknown): PromoVentana | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).promo_ventana;
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  const inicio = toMinutesOfDay(obj.hora_inicio);
  if (inicio == null) return null;

  const dias = normalizeDias(obj.dias);
  if (dias.length === 0) return null;

  const dur = Number(obj.duracion_horas);
  if (!Number.isFinite(dur) || dur <= 0) return null;

  return {
    activa: obj.activa !== false, // ausente o true => activa
    dias,
    hora_inicio: typeof obj.hora_inicio === "string" ? obj.hora_inicio.trim() : "",
    duracion_horas: dur,
  };
}

/** Día ISO (1..7) y minutos del día en hora de Paraguay para el instante `now`. */
function asuncionIsoDayAndMinutes(now: Date): { isoDay: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const WEEKDAY_ISO: Record<string, number> = {
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
    Sunday: 7,
  };
  const isoDay = WEEKDAY_ISO[get("weekday")] ?? 1;
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const minutes = (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
  return { isoDay, minutes };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * `true` si la opción debe mostrarse/poder elegirse en el instante `now`.
 * - Sin `promo_ventana` válida → siempre `true` (comportamiento actual intacto).
 * - `activa: false` → `false`.
 * - Con ventana → `true` solo si `now` (hora PY) cae dentro de
 *   `[inicio, inicio + duracion)` para alguno de los días configurados, tratando la semana
 *   como circular (soporta ventanas que cruzan medianoche o el fin de semana).
 */
export function isPromoVisibleNow(payload: unknown, now: Date = new Date()): boolean {
  const v = parsePromoVentana(payload);
  if (!v) return true;
  if (!v.activa) return false;

  const startMin = toMinutesOfDay(v.hora_inicio);
  if (startMin == null) return true; // config rara: no ocultar por las dudas

  const durMin = Math.min(Math.round(v.duracion_horas * 60), MIN_PER_WEEK);
  const { isoDay, minutes } = asuncionIsoDayAndMinutes(now);
  const nowMow = (isoDay - 1) * MIN_PER_DAY + minutes;

  for (const d of v.dias) {
    const startMow = (d - 1) * MIN_PER_DAY + startMin;
    if (mod(nowMow - startMow, MIN_PER_WEEK) < durMin) return true;
  }
  return false;
}
