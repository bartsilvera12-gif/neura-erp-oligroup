/**
 * Inserción de filas `sorteo_cupones` + actualización de contadores en `sorteos`.
 * Compartido por orden desde comprobante (chat) y venta manual ERP (transacción abierta).
 */
import "server-only";

import type pg from "pg";
import {
  findCorrelativeBlock,
  formatNumeroCuponDisplay,
  parseNumeroCuponToInt,
  pickRandomDistinctInRange,
  type CouponNumberMode,
} from "@/lib/sorteos/coupon-numbering";

export type SorteoPgRowLocked = {
  empresa_id: string;
  precio_por_boleto: string | number;
  max_boletos: number;
  total_boletos_vendidos: number;
  ultimo_numero_cupon: number;
  ultimo_numero_orden: number;
  coupon_numbering_enabled?: boolean;
  coupon_number_start?: number | null;
  coupon_number_mode?: string | null;
  coupon_number_limit?: number | null;
};

export type InsertCuponesResult =
  | { ok: true; cupones: { id: string; numero_cupon: string }[]; ultimoNumeroCuponNext: number }
  | { ok: false; message: string };

/**
 * Inserta N cupones y actualiza `sorteos` (vendidos, último cupón, último orden).
 * No hace COMMIT/ROLLBACK; el caller controla la transacción.
 */
export async function insertSorteoCuponesAndUpdateSorteoCounters(input: {
  client: pg.PoolClient;
  schemaQuoted: string;
  sortCols: Set<string>;
  cupCols: Set<string>;
  s: SorteoPgRowLocked;
  empresaId: string;
  sorteoId: string;
  entradaId: string;
  qty: number;
  ultCupon: number;
  numeroOrden: number;
}): Promise<InsertCuponesResult> {
  const qsch = input.schemaQuoted;
  const { s, sortCols, cupCols } = input;
  const qty = input.qty;
  const ultCupon = input.ultCupon;

  if (
    Boolean(s.coupon_numbering_enabled) &&
    sortCols.has("coupon_numbering_enabled") &&
    !cupCols.has("coupon_number_value")
  ) {
    return {
      ok: false,
      message:
        "El sorteo tiene numeración personalizada pero falta la migración en sorteo_cupones (coupon_number_value). Contactá soporte.",
    };
  }

  const numberingEnabled =
    Boolean(s.coupon_numbering_enabled) &&
    sortCols.has("coupon_numbering_enabled") &&
    cupCols.has("coupon_number_value");

  const cuponesOut: { id: string; numero_cupon: string }[] = [];
  let ultimoNext = ultCupon + qty;

  if (!numberingEnabled) {
    for (let i = 1; i <= qty; i++) {
      const num = ultCupon + i;
      const numStr = String(num).padStart(4, "0");
      const insC = await input.client.query<{ id: string }>(
        `INSERT INTO ${qsch}.sorteo_cupones (empresa_id, sorteo_id, entrada_id, numero_cupon)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.empresaId, input.sorteoId, input.entradaId, numStr]
      );
      cuponesOut.push({ id: insC.rows[0]?.id ?? "", numero_cupon: numStr });
    }
  } else {
    const mode = String(s.coupon_number_mode ?? "").trim() as CouponNumberMode;
    const nStart =
      s.coupon_number_start != null && Number.isFinite(Number(s.coupon_number_start))
        ? Math.trunc(Number(s.coupon_number_start))
        : null;
    const nLimit =
      s.coupon_number_limit != null && Number.isFinite(Number(s.coupon_number_limit))
        ? Math.trunc(Number(s.coupon_number_limit))
        : null;

    if (nStart == null || nStart < 0 || (mode !== "correlative" && mode !== "random")) {
      return {
        ok: false,
        message:
          "La configuración de numeración de cupones del sorteo es inválida. Revisala en Sorteos → Editar.",
      };
    }
    if (mode === "random" && nLimit == null) {
      return {
        ok: false,
        message:
          "En modo aleatorio el límite máximo es obligatorio. Configuralo en el sorteo y guardá los cambios.",
      };
    }
    if (nLimit != null && nLimit < nStart) {
      return {
        ok: false,
        message: "El límite máximo de cupones debe ser mayor o igual al número inicial.",
      };
    }

    const usedRes = await input.client.query<{ coupon_number_value: number | null; numero_cupon: string }>(
      `SELECT coupon_number_value, numero_cupon FROM ${qsch}.sorteo_cupones WHERE sorteo_id = $1`,
      [input.sorteoId]
    );
    const used = new Set<number>();
    for (const row of usedRes.rows) {
      if (row.coupon_number_value != null && Number.isFinite(Number(row.coupon_number_value))) {
        used.add(Math.trunc(Number(row.coupon_number_value)));
      } else {
        const p = parseNumeroCuponToInt(row.numero_cupon);
        if (p != null) used.add(p);
      }
    }

    // Números de boletas anuladas: quedan bloqueados, no se vuelven a asignar.
    const anuRes = await input.client.query<{ coupon_number_value: number | null; numero_cupon: string }>(
      `SELECT coupon_number_value, numero_cupon FROM ${qsch}.sorteo_cupones_anulados WHERE sorteo_id = $1`,
      [input.sorteoId]
    );
    for (const row of anuRes.rows) {
      if (row.coupon_number_value != null && Number.isFinite(Number(row.coupon_number_value))) {
        used.add(Math.trunc(Number(row.coupon_number_value)));
      } else {
        const p = parseNumeroCuponToInt(row.numero_cupon);
        if (p != null) used.add(p);
      }
    }

    let valuesToAssign: number[] = [];

    if (mode === "correlative") {
      const block = findCorrelativeBlock(nStart, nLimit, used, qty);
      if (block == null) {
        return {
          ok: false,
          message:
            nLimit != null
              ? `No hay ${qty} números correlativos disponibles entre ${nStart} y ${nLimit} para nuevos cupones.`
              : `No hay ${qty} números correlativos disponibles desde ${nStart} (rango agotado o todos ocupados).`,
        };
      }
      for (let i = 0; i < qty; i++) valuesToAssign.push(block + i);
    } else {
      const hi = nLimit ?? nStart;
      const picked = pickRandomDistinctInRange(nStart, hi, used, qty);
      if (!picked) {
        return {
          ok: false,
          message: `No hay ${qty} números aleatorios únicos disponibles entre ${nStart} y ${hi}.`,
        };
      }
      valuesToAssign = picked;
    }

    let maxIssued = ultCupon;
    for (const numVal of valuesToAssign) {
      const numStr = formatNumeroCuponDisplay(numVal);
      maxIssued = Math.max(maxIssued, numVal);
      try {
        const insC = await input.client.query<{ id: string }>(
          `INSERT INTO ${qsch}.sorteo_cupones (empresa_id, sorteo_id, entrada_id, numero_cupon, coupon_number_value)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [input.empresaId, input.sorteoId, input.entradaId, numStr, numVal]
        );
        cuponesOut.push({ id: insC.rows[0]?.id ?? "", numero_cupon: numStr });
      } catch (insErr: unknown) {
        const code = (insErr as { code?: string }).code;
        if (code === "23505") {
          return {
            ok: false,
            message:
              "Conflicto al asignar números de cupón (duplicado). Intentá de nuevo; si persiste, revisá la configuración de numeración.",
          };
        }
        throw insErr;
      }
    }
    ultimoNext = Math.max(ultCupon + qty, maxIssued);
  }

  await input.client.query(
    `UPDATE ${qsch}.sorteos SET
       total_boletos_vendidos = total_boletos_vendidos + $2,
       ultimo_numero_cupon = $3,
       ultimo_numero_orden = $4,
       updated_at = now()
     WHERE id = $1`,
    [input.sorteoId, qty, ultimoNext, input.numeroOrden]
  );

  return { ok: true, cupones: cuponesOut, ultimoNumeroCuponNext: ultimoNext };
}
