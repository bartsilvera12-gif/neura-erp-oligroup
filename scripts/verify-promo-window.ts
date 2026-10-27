/**
 * Prueba la ventana horaria de promos (sin DB).
 * Ejecutar: npx tsx scripts/verify-promo-window.ts
 *
 * El cálculo real está anclado a America/Asuncion. Para no depender del offset exacto
 * (PY no tiene DST estable), el test deriva el día/hora PY del instante fijo con el MISMO
 * Intl y construye las ventanas en relación a eso.
 */
import { isPromoVisibleNow, parsePromoVentana } from "../src/lib/sorteos/promo-window";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FALLO:", msg);
    process.exit(1);
  }
}

/** Día ISO (1..7) y "HH:MM" en hora de Paraguay para un instante dado. */
function pyParts(now: Date): { isoDay: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Asuncion",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const map: Record<string, number> = {
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
    Sunday: 7,
  };
  return { isoDay: map[get("weekday")] ?? 1, hhmm: `${get("hour")}:${get("minute")}` };
}

// Instante fijo cualquiera.
const NOW = new Date("2026-02-05T20:00:00Z");
const { isoDay, hhmm } = pyParts(NOW);
const otherDay = (isoDay % 7) + 1; // un día distinto, en 1..7
const prevDay = isoDay === 1 ? 7 : isoDay - 1;

// 1) Sin promo_ventana → siempre visible.
assert(isPromoVisibleNow({ monto: 50000 }, NOW), "sin ventana debe verse siempre");
assert(isPromoVisibleNow({}, NOW), "payload vacío debe verse");
assert(isPromoVisibleNow(null, NOW), "payload null debe verse");

// 2) Ventana que arranca justo ahora (hora PY) por 1h → visible.
assert(
  isPromoVisibleNow(
    { promo_ventana: { activa: true, dias: [isoDay], hora_inicio: hhmm, duracion_horas: 1 } },
    NOW
  ),
  "dentro de ventana (arranca ahora) debe verse"
);

// 3) Ventana solo otro día → oculta.
assert(
  !isPromoVisibleNow(
    { promo_ventana: { activa: true, dias: [otherDay], hora_inicio: hhmm, duracion_horas: 1 } },
    NOW
  ),
  "otro día debe ocultarse"
);

// 4) Ventana del mismo día pero 00:00 por 1h (y ahora es 20:00 PY) → oculta.
assert(
  !isPromoVisibleNow(
    { promo_ventana: { activa: true, dias: [isoDay], hora_inicio: "00:00", duracion_horas: 1 } },
    NOW
  ),
  "fuera del rango horario debe ocultarse"
);

// 5) Cruce de medianoche: arranca ayer 23:00 por 48h → todavía cubre ahora → visible.
assert(
  isPromoVisibleNow(
    { promo_ventana: { activa: true, dias: [prevDay], hora_inicio: "23:00", duracion_horas: 48 } },
    NOW
  ),
  "ventana que cruza el día debe seguir visible"
);

// 6) activa:false → oculta aunque el horario coincida.
assert(
  !isPromoVisibleNow(
    { promo_ventana: { activa: false, dias: [isoDay], hora_inicio: hhmm, duracion_horas: 1 } },
    NOW
  ),
  "activa:false debe ocultar"
);

// 7) Config inválida (sin días) → se trata como sin ventana (visible).
assert(
  isPromoVisibleNow(
    { promo_ventana: { activa: true, dias: [], hora_inicio: "18:00", duracion_horas: 24 } },
    NOW
  ),
  "ventana sin días es inválida → visible"
);

// 8) parsePromoVentana normaliza días y descarta inválidos.
const parsed = parsePromoVentana({
  promo_ventana: { dias: [4, 4, 9, 2, "x"], hora_inicio: "18:00", duracion_horas: 24 },
});
assert(parsed != null && parsed.dias.join(",") === "2,4", "parse: días normalizados y únicos");
assert(parsed != null && parsed.activa === true, "parse: activa por defecto true");

console.log("OK verify-promo-window: todos los casos pasaron.");
