"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SorteoCuponOrdenRow } from "@/lib/sorteos/types";
import SorteoCuponesPagoCell from "@/components/sorteos/SorteoCuponesPagoCell";
import SorteoCuponesImpresionCell from "@/components/sorteos/SorteoCuponesImpresionCell";
import SorteoCuponesCancelarCell from "@/components/sorteos/SorteoCuponesCancelarCell";
import TicketConfirmacionModal from "@/components/sorteos/TicketConfirmacionModal";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/** Sobre este umbral, "Imprimir todos los filtrados" pide confirmación. */
const CONFIRM_TODOS_THRESHOLD = 300;

function formatGs(n: number) {
  return `${n.toLocaleString("es-PY")} ₲`;
}

function formatFecha(iso: string) {
  try {
    return new Date(iso).toLocaleString("es-PY", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

type VentaImprimir = {
  entrada_id: string;
  numero_orden: number;
  sorteo_id: string;
  sorteo_nombre: string;
  precio_boleto: number | null;
  nombre_participante: string | null;
  documento: string | null;
  whatsapp: string | null;
  ciudad: string | null;
  monto_total: number;
  cupones: string[];
  delivery_id: string | null;
};

function openPrintWindow(url: string) {
  // Nueva pestaña: mantiene la lista de cupones abierta detrás.
  window.open(url, "_blank", "noopener");
}

export default function SorteoCuponesBatchPrintClient({
  rows,
  selectedSorteoId,
  estadoParam,
  qParam,
  totalCount,
  esAdmin = false,
  filtraImpresion = false,
}: {
  /** Hay un filtro de impresión (pendientes/impresas) activo. */
  filtraImpresion?: boolean;
  rows: SorteoCuponOrdenRow[];
  /** Sorteo del filtro actual; null cuando se eligió "Todos los sorteos". */
  selectedSorteoId: string | null;
  estadoParam?: string;
  qParam?: string;
  totalCount: number;
  /** Solo los administradores ven la acción de cancelar boletas. */
  esAdmin?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ordenDesde, setOrdenDesde] = useState("");
  const [ordenHasta, setOrdenHasta] = useState("");
  const [ventaImprimir, setVentaImprimir] = useState<VentaImprimir | null>(null);
  const [busyBoletaId, setBusyBoletaId] = useState<string | null>(null);

  /** Abre la boleta ya generada de la orden (sin crear venta ni números nuevos). */
  async function imprimirBoleta(entradaId: string) {
    setBusyBoletaId(entradaId);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/mis-ventas?entrada_id=${encodeURIComponent(entradaId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { success?: boolean; data?: VentaImprimir[]; error?: string };
      const v = json.data?.[0];
      if (!res.ok || !json.success || !v) {
        window.alert(json.error || "No se encontró la boleta de esta orden");
        return;
      }
      setVentaImprimir(v);
    } catch {
      window.alert("Error al abrir la boleta");
    } finally {
      setBusyBoletaId(null);
    }
  }

  const visibleIds = useMemo(() => rows.map((r) => r.entrada_id), [rows]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }

  function printUrl(sorteoId: string, extra: Record<string, string>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) {
      if (v) p.set(k, v);
    }
    const qs = p.toString();
    return `/sorteos/${encodeURIComponent(sorteoId)}/imprimir-cupones${qs ? `?${qs}` : ""}`;
  }

  function handleImprimirSeleccionados() {
    const ids = [...selected];
    if (ids.length === 0) return;
    // Todos los seleccionados deben pertenecer al mismo sorteo (la ruta de impresión es por sorteo).
    const bySorteo = new Map<string, string[]>();
    for (const r of rows) {
      if (!selected.has(r.entrada_id)) continue;
      const list = bySorteo.get(r.sorteo_id) ?? [];
      list.push(r.entrada_id);
      bySorteo.set(r.sorteo_id, list);
    }
    if (bySorteo.size > 1) {
      window.alert(
        "Seleccionaste cupones de más de un sorteo. Para imprimir en tanda, elegí cupones de un solo sorteo (usá el filtro Sorteo)."
      );
      return;
    }
    const [sorteoId, entradaIds] = [...bySorteo.entries()][0];
    openPrintWindow(printUrl(sorteoId, { entrada_ids: entradaIds.join(",") }));
  }

  function handleImprimirRango() {
    if (!selectedSorteoId) {
      window.alert("Elegí un sorteo específico en el filtro para imprimir por rango.");
      return;
    }
    const d = ordenDesde.trim();
    const h = ordenHasta.trim();
    if (!/^[0-9]+$/.test(d) || !/^[0-9]+$/.test(h)) {
      window.alert("Ingresá un rango numérico válido (N° de orden desde y hasta).");
      return;
    }
    openPrintWindow(
      printUrl(selectedSorteoId, {
        orden_desde: d,
        orden_hasta: h,
        estado: estadoParam ?? "",
      })
    );
  }

  function handleImprimirTodosFiltrados() {
    if (filtraImpresion) {
      window.alert(
        "Con el filtro de Impresión activo, usá «Seleccionar todos» de la tabla e «Imprimir seleccionados» (así no se reimprimen boletas ya impresas)."
      );
      return;
    }
    if (!selectedSorteoId) {
      window.alert("Elegí un sorteo específico en el filtro para imprimir todos los resultados.");
      return;
    }
    if (
      totalCount > CONFIRM_TODOS_THRESHOLD &&
      !window.confirm(
        `Vas a abrir la impresión de todos los cupones filtrados (${totalCount.toLocaleString(
          "es-PY"
        )} órdenes). Puede tardar. ¿Continuar?`
      )
    ) {
      return;
    }
    openPrintWindow(
      printUrl(selectedSorteoId, { estado: estadoParam ?? "", q: qParam ?? "" })
    );
  }

  const selectedCount = selected.size;

  return (
    <div className="space-y-4">
      {/* Barra de impresión por tandas */}
      <div className="rounded-2xl border border-[#4FAEB2]/45 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <button
            type="button"
            onClick={handleImprimirSeleccionados}
            disabled={selectedCount === 0}
            className="rounded-xl bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] disabled:opacity-50 disabled:pointer-events-none"
          >
            Imprimir seleccionados ({selectedCount})
          </button>

          <div className="flex items-end gap-2 border-l border-slate-200 pl-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Orden desde
              </span>
              <input
                inputMode="numeric"
                value={ordenDesde}
                onChange={(e) => setOrdenDesde(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="1"
                className="w-[110px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                Orden hasta
              </span>
              <input
                inputMode="numeric"
                value={ordenHasta}
                onChange={(e) => setOrdenHasta(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="100"
                className="w-[110px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
              />
            </label>
            <button
              type="button"
              onClick={handleImprimirRango}
              disabled={!selectedSorteoId}
              title={!selectedSorteoId ? "Elegí un sorteo específico" : undefined}
              className="rounded-xl border border-[#4FAEB2]/50 bg-white px-4 py-2.5 text-sm font-semibold text-[#3F8E91] shadow-sm transition-colors hover:bg-[#4FAEB2]/5 disabled:opacity-50 disabled:pointer-events-none"
            >
              Imprimir rango
            </button>
          </div>

          <button
            type="button"
            onClick={handleImprimirTodosFiltrados}
            disabled={!selectedSorteoId}
            title={!selectedSorteoId ? "Elegí un sorteo específico" : undefined}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91] disabled:opacity-50 disabled:pointer-events-none"
          >
            Imprimir todos los filtrados ({totalCount.toLocaleString("es-PY")})
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          La impresión por tandas abre la pantalla de impresión en una pestaña nueva. No modifica datos
          ni marca cupones como impresos (la marca «Impreso» se registra al confirmar la impresión de cada
          orden). Usá el filtro «Impresión → Pendientes de imprimir» para continuar donde quedaste. El botón «Imprimir» de cada fila sigue funcionando igual.
          {!selectedSorteoId
            ? " Para rango / todos, elegí un sorteo específico en el filtro de arriba."
            : ""}
        </p>
      </div>

      {/* Tabla */}
      <div className="overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm">
        {rows.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">No hay órdenes con cupones</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px]">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80">
                  <th className="px-4 py-3 text-left">
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todos los visibles"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                      }}
                      onChange={toggleAllVisible}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                  </th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Nº orden</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Sorteo</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cliente</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cédula</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Teléfono</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cantidad</th>
                  <th className="px-5 py-3 text-right text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Monto</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Cupones</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Impresión</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Pago</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Fecha</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Boleta</th>
                  <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Chat</th>
                  {esAdmin ? (
                    <th className="px-5 py-3 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Acción</th>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const checked = selected.has(r.entrada_id);
                  return (
                    <tr
                      key={r.entrada_id}
                      className={checked ? "bg-[#4FAEB2]/5" : "hover:bg-slate-50/80"}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar orden ${r.numero_orden}`}
                          checked={checked}
                          onChange={() => toggleOne(r.entrada_id)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                      <td className="px-5 py-3 text-sm font-mono font-semibold text-slate-800">{r.numero_orden}</td>
                      <td className="px-5 py-3 text-sm text-slate-800">{r.sorteo_nombre}</td>
                      <td className="px-5 py-3 text-sm text-slate-800">{r.nombre_participante}</td>
                      <td className="px-5 py-3 text-sm font-mono text-slate-600">{r.documento ?? "—"}</td>
                      <td className="px-5 py-3 text-sm font-mono text-slate-700">{r.whatsapp_numero}</td>
                      <td className="px-5 py-3 text-sm text-slate-800">{r.cantidad_boletos}</td>
                      <td className="px-5 py-3 text-sm text-right tabular-nums text-slate-800">
                        {formatGs(r.monto_total)}
                        {r.promo_nombre ? (
                          <div className="text-[11px] font-normal text-slate-500 mt-0.5">{r.promo_nombre}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-sm font-mono text-slate-800">{r.numeros_cupon.join(", ")}</td>
                      <td className="px-5 py-3 text-sm">
                        <SorteoCuponesImpresionCell
                          sorteoId={r.sorteo_id}
                          entradaId={r.entrada_id}
                          cuponesImpresosAt={r.cupones_impresos_at}
                        />
                      </td>
                      <SorteoCuponesPagoCell entradaId={r.entrada_id} estadoPago={r.estado_pago} />
                      <td className="px-5 py-3 text-sm text-slate-600 whitespace-nowrap">{formatFecha(r.created_at)}</td>
                      <td className="px-5 py-3 text-sm">
                        <button
                          type="button"
                          disabled={busyBoletaId === r.entrada_id}
                          onClick={() => void imprimirBoleta(r.entrada_id)}
                          className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          Imprimir boleta
                        </button>
                      </td>
                      <td className="px-5 py-3 text-sm">
                        {r.chat_conversation_id ? (
                          <Link
                            href={`/dashboard/conversaciones?conversationId=${encodeURIComponent(r.chat_conversation_id)}`}
                            className="text-[#4FAEB2] hover:underline"
                          >
                            Abrir
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      {esAdmin ? (
                        <SorteoCuponesCancelarCell
                          entradaId={r.entrada_id}
                          numeroOrden={r.numero_orden}
                          cupones={r.numeros_cupon}
                        />
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <TicketConfirmacionModal
        open={ventaImprimir !== null}
        onClose={() => setVentaImprimir(null)}
        deliveryId={ventaImprimir?.delivery_id ?? null}
        numeroOrden={ventaImprimir?.numero_orden ?? null}
        telefonoCliente={ventaImprimir?.whatsapp ?? ""}
        nombreCliente={ventaImprimir?.nombre_participante ?? ""}
        cupones={ventaImprimir?.cupones ?? []}
        montoTotal={ventaImprimir?.monto_total ?? 0}
        documentoCliente={ventaImprimir?.documento ?? ""}
        sorteoNombre={ventaImprimir?.sorteo_nombre ?? ""}
        sorteoId={ventaImprimir?.sorteo_id ?? ""}
        ciudad={ventaImprimir?.ciudad ?? ""}
        precioBoleto={ventaImprimir?.precio_boleto ?? null}
      />
    </div>
  );
}
