"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Props = {
  entradaId: string;
  numeroOrden: number;
  cupones: string[];
};

/**
 * Columna "Acción" (solo admin): cancelar/eliminar una orden generada por error.
 * Borra la orden y sus boletas y ajusta el contador del sorteo. Pide confirmación.
 */
export default function SorteoCuponesCancelarCell({ entradaId, numeroOrden, cupones }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const closeAll = useCallback(() => {
    if (busy) return;
    setOpen(false);
  }, [busy]);

  const cancelar = useCallback(async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/cupones/${encodeURIComponent(entradaId)}/cancelar`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        setErrorMsg(json.error ?? `Error ${res.status}`);
        return;
      }
      setToast(`Orden Nº ${numeroOrden} cancelada`);
      window.setTimeout(() => setToast(null), 4000);
      setOpen(false);
      router.refresh();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Error de red");
    } finally {
      setBusy(false);
    }
  }, [entradaId, numeroOrden, router]);

  const cuponesTxt = cupones.length ? cupones.join(", ") : "—";

  return (
    <td className="px-5 py-3 text-sm relative">
      {toast ? (
        <div
          className="fixed bottom-4 right-4 z-[100] rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 shadow-lg"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      <button
        type="button"
        className="inline-flex items-center rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-50"
        onClick={() => {
          setErrorMsg(null);
          setOpen(true);
        }}
        disabled={busy}
      >
        Cancelar
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cupon-cancelar-dialog-title"
          onClick={closeAll}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="cupon-cancelar-dialog-title" className="text-base font-semibold text-slate-800">
              ¿Cancelar la orden Nº {numeroOrden}?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Se va a <strong>eliminar definitivamente</strong> esta orden y sus boletas (
              <span className="font-mono">{cuponesTxt}</span>). Se ajustan las boletas vendidas del
              sorteo. Esta acción no se puede deshacer.
            </p>
            {errorMsg ? (
              <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
                {errorMsg}
              </p>
            ) : null}
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                disabled={busy}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                onClick={() => void cancelar()}
              >
                {busy ? "Cancelando…" : "Sí, eliminar"}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                onClick={closeAll}
              >
                No, volver
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </td>
  );
}
