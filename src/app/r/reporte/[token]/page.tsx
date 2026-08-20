"use client";

import { use, useEffect, useState } from "react";

type Reporte = {
  ok: boolean;
  error?: string;
  revendedor?: { nombre: string; codigo: string | null; activo: boolean };
  sorteo?: { nombre: string; estado: string };
  metricas?: {
    clicks: number;
    clicks_redeemed: number;
    sesiones: number;
    ventas: number;
    ventas_pendientes: number;
    boletos: number;
    monto: number;
    conversion: number;
  };
  ventas?: Array<{ orden: number | null; fecha: string; cantidad: number; monto: number; estado: string }>;
  generado_at?: string;
};

function fmtGs(n: number) {
  return `${Math.round(n).toLocaleString("es-PY")} ₲`;
}
function fmtFecha(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("es-PY", { day: "2-digit", month: "2-digit", year: "2-digit" });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function ReportePublicoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [rep, setRep] = useState<Reporte | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/r/reporte/${encodeURIComponent(token)}`, { cache: "no-store" });
        const json = (await res.json().catch(() => ({ ok: false, error: "parse" }))) as Reporte;
        setRep(json);
      } catch {
        setRep({ ok: false, error: "network" });
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  if (loading) {
    return <div className="min-h-screen grid place-items-center bg-slate-50 text-slate-400 text-sm">Cargando reporte…</div>;
  }
  if (!rep?.ok || !rep.metricas || !rev(rep)) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 p-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-3xl mb-2">🔒</div>
          <div className="font-semibold text-slate-800">Reporte no disponible</div>
          <div className="text-sm text-slate-500 mt-1">El link no es válido o expiró. Pedí uno nuevo al organizador.</div>
        </div>
      </div>
    );
  }

  const r = rep.revendedor!;
  const s = rep.sorteo!;
  const m = rep.metricas;

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-[#4FAEB2]">{s.nombre}</div>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Reporte de {r.nombre}</h1>
          {r.codigo ? (
            <div className="mt-1.5 inline-block font-mono text-xs bg-white border border-slate-200 rounded-full px-3 py-1 text-slate-600 shadow-sm">
              Código {r.codigo}
            </div>
          ) : null}
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <Kpi label="Ventas" value={String(m.ventas)} sub={m.ventas_pendientes > 0 ? `${m.ventas_pendientes} pendientes` : "confirmadas"} highlight />
          <Kpi label="Boletos vendidos" value={String(m.boletos)} />
          <Kpi label="Monto total" value={fmtGs(m.monto)} />
          <Kpi label="Clics al link" value={String(m.clicks)} sub={m.clicks > 0 ? `${Math.round(m.conversion * 100)}% conversión` : undefined} />
        </div>

        {/* Ventas */}
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">Tus ventas</div>
          {rep.ventas && rep.ventas.length > 0 ? (
            <div className="divide-y divide-slate-100">
              {rep.ventas.map((v, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5">
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      {v.cantidad} {v.cantidad === 1 ? "boleta" : "boletas"}
                      {v.orden ? <span className="text-slate-400 font-normal"> · Orden #{v.orden}</span> : null}
                    </div>
                    <div className="text-[11px] text-slate-400">{fmtFecha(v.fecha)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold text-slate-900 tabular-nums">{fmtGs(v.monto)}</div>
                    <div className={`text-[10px] font-medium ${v.estado === "confirmado" ? "text-emerald-600" : "text-amber-600"}`}>
                      {v.estado === "confirmado" ? "confirmada" : "en revisión"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-slate-400">Todavía no tenés ventas registradas.</div>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-slate-400">
          Actualizado al {rep.generado_at ? new Date(rep.generado_at).toLocaleString("es-PY") : "-"}
        </p>
      </div>
    </div>
  );
}

function rev(rep: Reporte): boolean {
  return Boolean(rep.revendedor && rep.sorteo);
}

function Kpi({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${highlight ? "border-[#4FAEB2]/40 bg-[#4FAEB2]/5" : "border-slate-200 bg-white"}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{value}</div>
      {sub ? <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div> : null}
    </div>
  );
}
