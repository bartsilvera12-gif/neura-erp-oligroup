"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import SorteoCuponManualForm, { useSorteosCuponManual } from "@/components/sorteos/SorteoCuponManualForm";

export default function SorteosCuponesManualClient() {
  const searchParams = useSearchParams();
  const sorteoFromUrl = searchParams?.get("sorteo_id")?.trim() ?? "";

  const [open, setOpen] = useState(false);
  /** Se incrementa en cada apertura: nueva clave de idempotencia y mensajes limpios. */
  const [openCount, setOpenCount] = useState(0);
  const [pickedSorteoId, setSorteoId] = useState("");
  const { sorteos, loadErr } = useSorteosCuponManual(open);

  /** Preselección: sorteo de la URL si está en la lista; si no, el primero. */
  const defaultSorteoId =
    sorteoFromUrl && sorteos.some((s) => s.id === sorteoFromUrl) ? sorteoFromUrl : sorteos[0]?.id ?? "";
  const sorteoId = pickedSorteoId || defaultSorteoId;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpenCount((n) => n + 1);
          setOpen(true);
        }}
        className="bg-emerald-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-emerald-700 shadow-sm"
      >
        Crear cupón manual
      </button>

      {/* Se mantiene montado para conservar lo tipeado entre aperturas (como antes). */}
      <div
        className={open ? "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" : "hidden"}
      >
        <div
          role="dialog"
          aria-modal="true"
          className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto border border-slate-200"
        >
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 className="text-lg font-semibold text-slate-800">Venta presencial (efectivo)</h2>
            <button
              type="button"
              className="text-slate-500 hover:text-slate-800 text-xl leading-none px-2"
              onClick={() => setOpen(false)}
              aria-label="Cerrar"
            >
              ×
            </button>
          </div>

          <SorteoCuponManualForm
            sorteos={sorteos}
            sorteoId={sorteoId}
            onSorteoIdChange={setSorteoId}
            showSorteoSelect
            loadErr={loadErr}
            resetSignal={openCount}
            onClose={() => setOpen(false)}
          />
        </div>
      </div>
    </>
  );
}
