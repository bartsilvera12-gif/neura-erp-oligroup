"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import TicketConfirmacionModal from "@/components/sorteos/TicketConfirmacionModal";

type Venta = {
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
  estado_pago: string;
  created_at: string;
  cupones: string[];
  delivery_id: string | null;
};

const formatGs = (n: number) => `${(n || 0).toLocaleString("es-PY")} ₲`;

function formatFecha(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-PY", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Reimprimir una boleta ya generada (sin crear venta nueva ni números nuevos).
 * Lista las ventas del propio usuario y reabre el ticket OLI para imprimir / enviar.
 */
export default function SorteoReimprimirMisVentas() {
  const [q, setQ] = useState("");
  const [ventas, setVentas] = useState<Venta[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Venta | null>(null);

  const cargar = useCallback(async (term: string) => {
    setLoading(true);
    setErr(null);
    try {
      const url = `/api/sorteos/mis-ventas${term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ""}`;
      const res = await fetchWithSupabaseSession(url, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: Venta[];
        error?: string;
      };
      if (!res.ok || !json.success) {
        setErr(
          res.status === 401
            ? "Tu sesión expiró. Volvé a iniciar sesión."
            : json.error ?? "No se pudieron cargar tus ventas."
        );
        setVentas([]);
        return;
      }
      setVentas(Array.isArray(json.data) ? json.data : []);
    } catch {
      setErr("Error de red al cargar tus ventas.");
      setVentas([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar("");
  }, [cargar]);

  return (
    <div className="space-y-3 p-4 text-sm sm:p-5">
      <p className="text-slate-600 text-xs">
        Reimprimí la boleta de una venta ya hecha. No crea una venta nueva ni cambia los números:
        solo vuelve a abrir el ticket para imprimirlo o enviarlo.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void cargar(q);
        }}
        className="flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por N° de orden, nombre o teléfono"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-base sm:text-sm"
          inputMode="search"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-[#4FAEB2] px-4 py-2.5 font-medium text-white hover:bg-[#3F8E91] disabled:opacity-60"
        >
          Buscar
        </button>
      </form>

      {err ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-xs">{err}</div>
      ) : null}

      {loading ? (
        <p className="text-xs text-slate-500">Cargando tus ventas…</p>
      ) : ventas.length === 0 ? (
        <p className="text-xs text-slate-500">
          {q.trim() ? "No se encontraron ventas con esa búsqueda." : "Todavía no tenés ventas cargadas."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {ventas.map((v) => (
            <li key={v.entrada_id} className="flex items-center justify-between gap-3 px-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800">
                  Orden Nº {v.numero_orden}
                  <span className="ml-2 font-mono text-xs font-normal text-slate-500">
                    {v.cupones.length ? v.cupones.join(", ") : "—"}
                  </span>
                </p>
                <p className="truncate text-xs text-slate-500">
                  {v.nombre_participante || "—"} · {v.sorteo_nombre} · {formatGs(v.monto_total)} ·{" "}
                  {formatFecha(v.created_at)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSel(v)}
                className="shrink-0 rounded-lg border border-[#4FAEB2] bg-[#4FAEB2]/10 px-3 py-2 text-xs font-semibold text-[#3F8E91] hover:bg-[#4FAEB2]/20"
              >
                Reimprimir
              </button>
            </li>
          ))}
        </ul>
      )}

      <TicketConfirmacionModal
        open={sel !== null}
        onClose={() => setSel(null)}
        deliveryId={sel?.delivery_id ?? null}
        numeroOrden={sel?.numero_orden ?? null}
        telefonoCliente={sel?.whatsapp ?? ""}
        nombreCliente={sel?.nombre_participante ?? ""}
        cupones={sel?.cupones ?? []}
        montoTotal={sel?.monto_total ?? 0}
        documentoCliente={sel?.documento ?? ""}
        sorteoNombre={sel?.sorteo_nombre ?? ""}
        sorteoId={sel?.sorteo_id ?? ""}
        ciudad={sel?.ciudad ?? ""}
        precioBoleto={sel?.precio_boleto ?? null}
      />
    </div>
  );
}
