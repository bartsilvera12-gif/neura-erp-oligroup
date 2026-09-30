import Link from "next/link";
import { Suspense } from "react";
import SorteosCuponesManualesPageClient from "@/components/sorteos/SorteosCuponesManualesPageClient";

export default function SorteoCuponesManualesPage() {
  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs text-slate-500">
        <Link href="/sorteos" className="font-medium text-slate-500 transition-colors hover:text-[#4FAEB2]">
          Sorteos
        </Link>
        <span aria-hidden className="text-slate-300">/</span>
        <span className="font-semibold text-slate-700">Cupones manuales</span>
      </nav>

      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Sorteos · Cupones manuales
          </p>
        </div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">Cupones manuales</h1>
        <p className="mt-1 text-sm text-slate-500">
          Registrá manualmente una participación y generá sus cupones.
        </p>
      </div>

      <Suspense fallback={null}>
        <SorteosCuponesManualesPageClient />
      </Suspense>
    </div>
  );
}
