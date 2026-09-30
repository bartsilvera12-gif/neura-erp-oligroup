"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import SorteoCuponManualForm, { useSorteosCuponManual } from "@/components/sorteos/SorteoCuponManualForm";

/** Acceso directo (sidebar) al mismo formulario de "Crear cupón manual". */
export default function SorteosCuponesManualesPageClient() {
  const searchParams = useSearchParams();
  const sorteoFromUrl = searchParams?.get("sorteo_id")?.trim() ?? "";

  const [pickedSorteoId, setSorteoId] = useState<string | null>(null);
  const { sorteos, loadErr, loadingSorteos } = useSorteosCuponManual(true);

  /** Sin elección explícita, se preselecciona el sorteo de la URL (?sorteo_id) si existe. */
  const sorteoId =
    pickedSorteoId ?? (sorteos.some((s) => s.id === sorteoFromUrl) ? sorteoFromUrl : "");

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#4FAEB2]/45 bg-white p-4 shadow-sm sm:p-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Sorteo</span>
          <select
            value={sorteoId}
            onChange={(e) => setSorteoId(e.target.value)}
            disabled={loadingSorteos}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-900 shadow-sm transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20 disabled:opacity-60 sm:max-w-md sm:py-2 sm:text-sm"
          >
            <option value="">{loadingSorteos ? "Cargando sorteos…" : "Seleccionar sorteo"}</option>
            {sorteos.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
                {(s.estado ?? "") !== "activo" ? ` (${s.estado})` : ""}
              </option>
            ))}
          </select>
        </label>
        {loadErr ? (
          <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {loadErr}
          </div>
        ) : null}
        {!loadingSorteos && !loadErr && sorteos.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">No hay sorteos activos.</p>
        ) : null}
      </div>

      {sorteoId ? (
        <div className="w-full rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm sm:max-w-lg">
          <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
            <h2 className="text-base font-semibold text-slate-800 sm:text-lg">Venta presencial (efectivo)</h2>
          </div>
          {/* key: al cambiar de sorteo se reinicia el formulario (nueva clave de idempotencia). */}
          <SorteoCuponManualForm key={sorteoId} sorteos={sorteos} sorteoId={sorteoId} />
        </div>
      ) : null}
    </div>
  );
}
