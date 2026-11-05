import { NextRequest, NextResponse } from "next/server";
import { getFacturasSupabaseFromAuth } from "@/lib/facturacion/facturas-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { montosFacturaItemParaInsert, tasaIvaDesdeIvaTipo } from "@/lib/facturacion/factura-item-montos";
import { obtenerSiguienteNumeroFacturaEmpresa } from "@/lib/facturacion/factura-suscripcion-servidor";
import { toCalendarDateStr } from "@/lib/fechas/calendario";

/**
 * POST /api/sorteos/facturacion/emitir
 *
 * Crea la factura comercial (facturas + factura_items) para una o varias VENTAS de sorteo
 * (sorteo_entradas) confirmadas y SIN facturar, y vincula cada venta a su factura
 * (`sorteo_entradas.factura_id`) para el control de duplicados. NO emite a SIFEN: eso lo hace
 * el panel SIFEN existente sobre la factura creada (borrador -> firmar -> enviar -> KuDE).
 *
 * Emisión 100% MANUAL: nunca se llama automáticamente desde la compra de una boleta.
 * Receptor: el `cliente_id` de la venta (persona física con cédula = no contribuyente / B2C).
 *
 * Body: { entrada_ids: string[], iva_tipo?: "exenta"|"iva_5"|"iva_10" }
 * Devuelve: { results: [{ entrada_id, ok, factura_id?, numero_factura?, error? }], creadas, fallidas }
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getFacturasSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const { auth, supabase } = ctx;
    const empresaId = auth.empresa_id;

    const body = (await request.json().catch(() => ({}))) as {
      entrada_ids?: unknown;
      iva_tipo?: unknown;
    };

    const entradaIds = Array.isArray(body.entrada_ids)
      ? body.entrada_ids.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    if (entradaIds.length === 0) {
      return NextResponse.json(errorResponse("Seleccioná al menos una venta para facturar."), { status: 400 });
    }
    if (entradaIds.length > 100) {
      return NextResponse.json(errorResponse("Máximo 100 ventas por emisión."), { status: 400 });
    }

    const ivaTipoRaw = typeof body.iva_tipo === "string" ? body.iva_tipo.trim().toLowerCase() : "";
    if (ivaTipoRaw && !["exenta", "iva_5", "iva_10"].includes(ivaTipoRaw)) {
      return NextResponse.json(errorResponse("iva_tipo inválido: use 'exenta', 'iva_5' o 'iva_10'."), { status: 400 });
    }
    const tasaIvaItem = tasaIvaDesdeIvaTipo(ivaTipoRaw);

    const hoy = toCalendarDateStr(new Date().toISOString()) || new Date().toISOString().slice(0, 10);

    type Result = {
      entrada_id: string;
      ok: boolean;
      factura_id?: string;
      numero_factura?: string;
      error?: string;
    };
    const results: Result[] = [];

    for (const entradaId of entradaIds) {
      try {
        // 1) Cargar la venta y validar
        const { data: entrada, error: entErr } = await supabase
          .from("sorteo_entradas")
          .select("id, empresa_id, cliente_id, nombre_participante, numero_orden, monto_total, estado_pago, factura_id")
          .eq("id", entradaId)
          .eq("empresa_id", empresaId)
          .maybeSingle();
        if (entErr) {
          results.push({ entrada_id: entradaId, ok: false, error: entErr.message });
          continue;
        }
        if (!entrada) {
          results.push({ entrada_id: entradaId, ok: false, error: "Venta no encontrada." });
          continue;
        }
        const e = entrada as {
          cliente_id: string | null;
          nombre_participante: string | null;
          numero_orden: number | null;
          monto_total: number | null;
          estado_pago: string | null;
          factura_id: string | null;
        };
        if (e.factura_id) {
          results.push({ entrada_id: entradaId, ok: false, error: "Esta venta ya fue facturada." });
          continue;
        }
        if (e.estado_pago !== "confirmado") {
          results.push({ entrada_id: entradaId, ok: false, error: "Solo se pueden facturar ventas confirmadas." });
          continue;
        }
        const clienteId = String(e.cliente_id ?? "").trim();
        if (!clienteId) {
          results.push({ entrada_id: entradaId, ok: false, error: "La venta no tiene un cliente asociado para usar como receptor." });
          continue;
        }
        const monto = Math.round(Number(e.monto_total) || 0);
        if (monto <= 0) {
          results.push({ entrada_id: entradaId, ok: false, error: "El monto de la venta no es válido." });
          continue;
        }

        // 2) Crear la factura comercial
        const numeroFactura = await obtenerSiguienteNumeroFacturaEmpresa(supabase, empresaId);
        const { data: factura, error: facErr } = await supabase
          .from("facturas")
          .insert([
            {
              empresa_id: empresaId,
              cliente_id: clienteId,
              numero_factura: numeroFactura,
              fecha: hoy,
              fecha_vencimiento: hoy,
              monto,
              saldo: monto,
              estado: "Pendiente",
              tipo: "contado",
              moneda: "GS",
            },
          ])
          .select("id, numero_factura")
          .single();
        if (facErr || !factura?.id) {
          results.push({ entrada_id: entradaId, ok: false, error: facErr?.message ?? "No se pudo crear la factura." });
          continue;
        }
        const facturaId = (factura as { id: string }).id;

        // 3) Ítem de la factura (monto incluye IVA según la tasa elegida)
        const ordenTxt = e.numero_orden != null ? ` — orden ${e.numero_orden}` : "";
        const nombreTxt = (e.nombre_participante ?? "").trim();
        const descripcion = `Boleta(s) de sorteo${ordenTxt}${nombreTxt ? ` — ${nombreTxt}` : ""}`.slice(0, 200);
        const linea = montosFacturaItemParaInsert({
          totalLinea: monto,
          moneda: "GS",
          cantidad: 1,
          precioUnitario: monto,
          tasaIva: tasaIvaItem,
        });
        const { error: itemErr } = await supabase.from("factura_items").insert({
          factura_id: facturaId,
          empresa_id: empresaId,
          descripcion,
          cantidad: 1,
          precio_unitario: linea.precio_unitario,
          subtotal: linea.subtotal,
          iva: linea.iva,
          total: linea.total,
        });
        if (itemErr) {
          await supabase.from("facturas").delete().eq("id", facturaId).eq("empresa_id", empresaId);
          results.push({ entrada_id: entradaId, ok: false, error: `No se pudo registrar el detalle: ${itemErr.message}` });
          continue;
        }

        // 4) Vincular la venta a la factura (guarda anti-duplicado: solo si sigue sin facturar)
        const { data: linked, error: linkErr } = await supabase
          .from("sorteo_entradas")
          .update({ factura_id: facturaId, facturado_at: new Date().toISOString() })
          .eq("id", entradaId)
          .eq("empresa_id", empresaId)
          .is("factura_id", null)
          .select("id")
          .maybeSingle();
        if (linkErr || !linked) {
          // Alguien la facturó en paralelo (o no se pudo vincular): deshago la factura para no dejar huérfana.
          await supabase.from("factura_items").delete().eq("factura_id", facturaId).eq("empresa_id", empresaId);
          await supabase.from("facturas").delete().eq("id", facturaId).eq("empresa_id", empresaId);
          results.push({
            entrada_id: entradaId,
            ok: false,
            error: linkErr?.message ?? "La venta ya fue facturada por otra operación.",
          });
          continue;
        }

        results.push({
          entrada_id: entradaId,
          ok: true,
          factura_id: facturaId,
          numero_factura: (factura as { numero_factura?: string }).numero_factura ?? numeroFactura,
        });
      } catch (err) {
        results.push({ entrada_id: entradaId, ok: false, error: err instanceof Error ? err.message : "Error" });
      }
    }

    const creadas = results.filter((r) => r.ok).length;
    const fallidas = results.length - creadas;
    return NextResponse.json(successResponse({ results, creadas, fallidas }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
