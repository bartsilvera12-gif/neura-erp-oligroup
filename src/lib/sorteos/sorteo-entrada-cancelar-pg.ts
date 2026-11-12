import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";

export type CancelSorteoEntradaResult =
  | {
      ok: true;
      numeroOrden: number | null;
      cuponesCancelados: number;
      cantidad: number;
    }
  | { ok: false; message: string };

/**
 * Cancela (borra definitivamente) una orden de sorteo y sus boletas, generada por error.
 *
 * En UNA transacción con lock del sorteo:
 *  - borra ticket_deliveries de la entrada,
 *  - desvincula validaciones de comprobante (sorteo_entrada_id → NULL),
 *  - borra los cupones de la entrada,
 *  - borra la entrada,
 *  - resta `cantidad_boletos` de `sorteos.total_boletos_vendidos`.
 *
 * NO retrocede `ultimo_numero_cupon` ni `ultimo_numero_orden` (son correlativos con unicidad;
 * retrocederlos causaría colisiones). La boleta cancelada deja un hueco, que es lo correcto.
 *
 * Se hace con borrados explícitos (no se depende de ON DELETE CASCADE) para ser seguro
 * en cualquier esquema de tenant.
 */
export async function cancelSorteoEntradaViaDirectPostgres(input: {
  schema: string;
  empresaId: string;
  entradaId: string;
  motivo?: string;
  anuladoPor?: string;
}): Promise<CancelSorteoEntradaResult> {
  const pool = getChatPostgresPool();
  if (!pool) {
    return { ok: false, message: "El servidor no tiene conexión directa a Postgres." };
  }

  const tEnt = quoteSchemaTable(input.schema, "sorteo_entradas");
  const tSor = quoteSchemaTable(input.schema, "sorteos");
  const tCup = quoteSchemaTable(input.schema, "sorteo_cupones");
  const tAnu = quoteSchemaTable(input.schema, "sorteo_cupones_anulados");
  const tTd =quoteSchemaTable(input.schema, "sorteo_ticket_deliveries");
  const tVal = quoteSchemaTable(input.schema, "chat_comprobante_validaciones");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const er = await client.query<{
      id: string;
      sorteo_id: string;
      numero_orden: number | null;
      cantidad_boletos: number | null;
    }>(
      `SELECT id, sorteo_id, numero_orden, cantidad_boletos
         FROM ${tEnt}
        WHERE id = $1::uuid AND empresa_id = $2::uuid
        FOR UPDATE`,
      [input.entradaId, input.empresaId]
    );
    const ent = er.rows[0];
    if (!ent) {
      await client.query("ROLLBACK");
      return { ok: false, message: "La orden no existe o no pertenece a esta empresa." };
    }

    // Lock del sorteo para ajustar contadores sin carreras con ventas concurrentes.
    await client.query(`SELECT id FROM ${tSor} WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [
      ent.sorteo_id,
      input.empresaId,
    ]);

    const cc = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${tCup} WHERE entrada_id = $1::uuid AND empresa_id = $2::uuid`,
      [input.entradaId, input.empresaId]
    );
    const cupCount = cc.rows[0]?.n ?? 0;
    const qty =
      Number.isFinite(Number(ent.cantidad_boletos)) && Number(ent.cantidad_boletos) > 0
        ? Number(ent.cantidad_boletos)
        : cupCount;

    // Guardar las boletas anuladas (comprador + motivo) y bloquear sus números para siempre.
    const dr = await client.query<{
      nombre_participante: string | null;
      whatsapp_numero: string | null;
      documento: string | null;
      monto_total: string | number | null;
      estado_pago: string | null;
    }>(
      `SELECT nombre_participante, whatsapp_numero, documento, monto_total, estado_pago
         FROM ${tEnt} WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [input.entradaId, input.empresaId]
    );
    const d = dr.rows[0];
    await client.query(
      `INSERT INTO ${tAnu}
         (empresa_id, sorteo_id, numero_cupon, coupon_number_value, entrada_id_original, numero_orden,
          nombre_participante, whatsapp_numero, documento, cantidad_boletos, monto_total,
          estado_pago_al_anular, motivo, anulado_por)
       SELECT c.empresa_id, c.sorteo_id, c.numero_cupon, c.coupon_number_value, c.entrada_id, $3::int,
              $4, $5, $6, $7::int, $8::numeric, $9, $10, $11
         FROM ${tCup} c
        WHERE c.entrada_id = $1::uuid AND c.empresa_id = $2::uuid
       ON CONFLICT (sorteo_id, numero_cupon) DO NOTHING`,
      [
        input.entradaId,
        input.empresaId,
        Number.isFinite(Number(ent.numero_orden)) ? Number(ent.numero_orden) : null,
        d?.nombre_participante ?? null,
        d?.whatsapp_numero ?? null,
        d?.documento ?? null,
        qty,
        d?.monto_total ?? null,
        d?.estado_pago ?? null,
        (input.motivo ?? "").trim() || "Cancelada por administrador",
        input.anuladoPor ?? null,
      ]
    );

    // Borrados explícitos (no dependemos de ON DELETE CASCADE).
    await client.query(`DELETE FROM ${tTd} WHERE entrada_id = $1::uuid AND empresa_id = $2::uuid`, [
      input.entradaId,
      input.empresaId,
    ]);
    // Desvincular validaciones de comprobante (si la tabla/columna existe en el tenant).
    try {
      await client.query(
        `UPDATE ${tVal} SET sorteo_entrada_id = NULL WHERE sorteo_entrada_id = $1::uuid AND empresa_id = $2::uuid`,
        [input.entradaId, input.empresaId]
      );
    } catch {
      /* la tabla puede no existir en algún tenant: no bloquea la cancelación */
    }
    await client.query(`DELETE FROM ${tCup} WHERE entrada_id = $1::uuid AND empresa_id = $2::uuid`, [
      input.entradaId,
      input.empresaId,
    ]);
    await client.query(`DELETE FROM ${tEnt} WHERE id = $1::uuid AND empresa_id = $2::uuid`, [
      input.entradaId,
      input.empresaId,
    ]);

    await client.query(
      `UPDATE ${tSor}
          SET total_boletos_vendidos = GREATEST(0, total_boletos_vendidos - $2),
              updated_at = now()
        WHERE id = $1::uuid`,
      [ent.sorteo_id, qty]
    );

    await client.query("COMMIT");
    return {
      ok: true,
      numeroOrden: Number.isFinite(Number(ent.numero_orden)) ? Number(ent.numero_orden) : null,
      cuponesCancelados: cupCount,
      cantidad: qty,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, message: e instanceof Error ? e.message : "Error al cancelar la orden." };
  } finally {
    client.release();
  }
}
