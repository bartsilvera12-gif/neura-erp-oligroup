import "server-only";

import type { AppSupabaseClient } from "@/lib/supabase/schema";
import type { EnsureSorteoOrderCreatedData } from "@/lib/sorteos/sorteo-order-from-chat";

export async function buildOrderResultFromEntradaId(
  sb: AppSupabaseClient,
  entradaId: string,
  empresaId?: string
): Promise<EnsureSorteoOrderCreatedData | null> {
  let q = sb
    .from("sorteo_entradas")
    .select(
      "id, sorteo_id, empresa_id, numero_orden, cantidad_boletos, monto_total, nombre_participante, documento, whatsapp_numero"
    )
    .eq("id", entradaId);
  if (empresaId?.trim()) {
    q = q.eq("empresa_id", empresaId.trim());
  }
  const { data: ent, error: e1 } = await q.maybeSingle();
  if (e1 || !ent) return null;

  const { data: sorteo } = await sb
    .from("sorteos")
    .select("nombre")
    .eq("id", (ent as { sorteo_id: string }).sorteo_id)
    .maybeSingle();

  const { data: cups } = await sb
    .from("sorteo_cupones")
    .select("id, numero_cupon")
    .eq("entrada_id", entradaId);

  const cupones = ((cups ?? []) as { id: string; numero_cupon: string }[]).map((c) => ({
    id: c.id,
    numero_cupon: c.numero_cupon,
  }));

  const enc = ent as {
    sorteo_id: string;
    empresa_id: string;
    numero_orden: number;
    cantidad_boletos: number;
    monto_total: number;
    nombre_participante: string;
    documento?: string | null;
    whatsapp_numero: string;
  };

  return {
    idempotent: true,
    entradaId,
    numeroOrden: Number(enc.numero_orden),
    cupones,
    sorteoId: enc.sorteo_id,
    sorteoNombre: String((sorteo as { nombre?: string } | null)?.nombre ?? ""),
    cantidadBoletos: enc.cantidad_boletos,
    montoTotal: Number(enc.monto_total),
    promoNombre: "",
    precioFuente: "lista",
  };
}

export async function flowDataStubFromEntrada(
  sb: AppSupabaseClient,
  entradaId: string
): Promise<Record<string, string>> {
  const { data: ent } = await sb
    .from("sorteo_entradas")
    .select("nombre_participante, documento, whatsapp_numero, ciudad")
    .eq("id", entradaId)
    .maybeSingle();
  const r = ent as {
    nombre_participante?: string;
    documento?: string | null;
    whatsapp_numero?: string;
    ciudad?: string | null;
  } | null;
  return {
    nombre_completo: (r?.nombre_participante ?? "").trim(),
    documento: (r?.documento ?? "").trim(),
    telefono: (r?.whatsapp_numero ?? "").trim(),
    celular: (r?.whatsapp_numero ?? "").trim(),
    ciudad: (r?.ciudad ?? "").trim(),
  };
}

/** Fuente prioritaria para el PNG: filas reales `sorteo_entradas` + `sorteo_cupones` + nombre del sorteo. */
export type SorteoTicketEntradaDbSnapshot = {
  clienteNombre: string;
  documento: string;
  telefono: string;
  ciudad: string;
  numeroOrdenStr: string;
  cupones: string[];
  sorteoNombre: string;
};

/**
 * Lee participante, orden, cupones y sorteo desde DB (misma fuente que `buildOrderResultFromEntradaId`).
 * Debe usarse antes del render del ticket para no depender solo de `chat_flow_data`.
 */
export async function loadSorteoTicketEntradaDbSnapshot(
  sb: AppSupabaseClient,
  entradaId: string,
  empresaId?: string
): Promise<SorteoTicketEntradaDbSnapshot | null> {
  let q = sb
    .from("sorteo_entradas")
    .select(
      "id, empresa_id, sorteo_id, numero_orden, nombre_participante, documento, whatsapp_numero, ciudad"
    )
    .eq("id", entradaId);
  if (empresaId?.trim()) {
    q = q.eq("empresa_id", empresaId.trim());
  }
  const { data: ent, error: eEnt } = await q.maybeSingle();
  if (eEnt || !ent) return null;

  const sorteoId = (ent as { sorteo_id: string }).sorteo_id;
  const { data: sorteo } = await sb.from("sorteos").select("nombre").eq("id", sorteoId).maybeSingle();

  const { data: cups } = await sb
    .from("sorteo_cupones")
    .select("numero_cupon")
    .eq("entrada_id", entradaId);

  const enc = ent as {
    numero_orden: number | string | null;
    nombre_participante?: string | null;
    documento?: string | null;
    whatsapp_numero?: string | null;
    ciudad?: string | null;
  };

  const cupones = ((cups ?? []) as { numero_cupon?: string | number | null }[])
    .map((c) => String(c.numero_cupon ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const no = enc.numero_orden;
  const numeroOrdenStr =
    typeof no === "number" && Number.isFinite(no)
      ? String(no)
      : String(no ?? "").trim();

  return {
    clienteNombre: String(enc.nombre_participante ?? "").trim(),
    documento: String(enc.documento ?? "").trim(),
    telefono: String(enc.whatsapp_numero ?? "").trim(),
    ciudad: String(enc.ciudad ?? "").trim(),
    numeroOrdenStr,
    cupones,
    sorteoNombre: String((sorteo as { nombre?: string } | null)?.nombre ?? "").trim(),
  };
}
