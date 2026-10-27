/**
 * Prueba el armado/lectura del payload de promos (sin DB).
 * Ejecutar: npx tsx scripts/verify-promo-option-payload.ts
 */
import {
  buildPromoOptionPayload,
  readPromoFromOption,
  optionHasPromoVentana,
  buildUniqueMetaButtonId,
} from "../src/lib/sorteos/promo-option-payload";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FALLO:", msg);
    process.exit(1);
  }
}

// 1) Build: claves espejo de monto + precio_fuente + promo_ventana.
const payload = buildPromoOptionPayload({
  cantidad: 7,
  monto: 50000,
  promoNombre: "7 boletas 50.000",
  dias: [4, 4, 2, 9],
  horaInicio: "18:00",
  duracionHoras: 24,
  activa: true,
});
assert(payload.cantidad === 7, "cantidad");
assert(
  payload.monto === 50000 &&
    payload.monto_compra === 50000 &&
    payload.monto_promocional === 50000 &&
    payload.sorteo_monto_opcion === 50000,
  "claves espejo de monto"
);
assert(payload.precio_fuente === "promo", "precio_fuente=promo");
const v = payload.promo_ventana as Record<string, unknown>;
assert(Array.isArray(v.dias) && (v.dias as number[]).join(",") === "2,4", "días normalizados/únicos");
assert(v.activa === true && v.hora_inicio === "18:00" && v.duracion_horas === 24, "ventana ok");
assert(optionHasPromoVentana(payload), "optionHasPromoVentana true");

// 2) Read: ida y vuelta.
const read = readPromoFromOption({ id: "opt-1", label: "7 boletas 50.000", option_payload: payload });
assert(read.cantidad === 7 && read.monto === 50000, "read cantidad/monto");
assert(read.dias.join(",") === "2,4" && read.horaInicio === "18:00" && read.duracionHoras === 24, "read ventana");
assert(read.activa === true, "read activa");

// 3) Conserva otras claves del payload existente.
const merged = buildPromoOptionPayload(
  { cantidad: 15, monto: 100000, dias: [5], horaInicio: "20:00", duracionHoras: 12, activa: false },
  { producto: "boletas", opcion_label: "15x100" }
);
assert(merged.producto === "boletas" && merged.opcion_label === "15x100", "conserva claves previas");
assert((merged.promo_ventana as Record<string, unknown>).activa === false, "activa false al pausar");

// 4) Opción sin ventana → no es promo.
assert(!optionHasPromoVentana({ cantidad: 1, monto: 10000 }), "sin ventana no es promo");

// 5) meta_button_id único.
const used = new Set(["7_boletas_50_000"]);
const id = buildUniqueMetaButtonId("7 boletas 50.000", used);
assert(id === "7_boletas_50_000_2", "meta_button_id evita colisión");

console.log("OK verify-promo-option-payload: todos los casos pasaron.");
