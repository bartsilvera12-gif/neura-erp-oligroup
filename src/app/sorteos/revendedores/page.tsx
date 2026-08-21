"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type SorteoLite = { id: string; nombre: string; estado: string };

type RevRow = {
  id: string;
  nombre: string;
  codigo_referido: string | null;
  telefono: string | null;
  activo: boolean;
  clicks: number;
  clicks_redeemed: number;
  sesiones: number;
  ventas: number;
  ventas_pendientes: number;
  boletos: number;
  monto: number;
  conversion: number;
  report_slug: string;
};

type Resumen = {
  sorteo_id: string;
  totales: { revendedores: number; ventas: number; boletos: number; monto: number; clicks: number };
  revendedores: RevRow[];
};

function fmtGs(n: number) {
  return `${Math.round(n).toLocaleString("es-PY")} ₲`;
}

export default function RevendedoresModulePage() {
  const [sorteos, setSorteos] = useState<SorteoLite[]>([]);
  const [sorteoId, setSorteoId] = useState<string>("");
  const [data, setData] = useState<Resumen | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Cargar sorteos para el selector; default = activo.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchWithSupabaseSession("/api/sorteos", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: unknown };
        const rows = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
        const list: SorteoLite[] = rows.map((r) => ({
          id: String(r.id),
          nombre: String(r.nombre ?? ""),
          estado: String(r.estado ?? ""),
        }));
        setSorteos(list);
        const activo = list.find((s) => s.estado === "activo") ?? list[0];
        if (activo) setSorteoId(activo.id);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Error cargando sorteos");
      }
    })();
  }, []);

  const load = useCallback(async (sid: string) => {
    if (!sid) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/revendedores/resumen?sorteo_id=${encodeURIComponent(sid)}`,
        { cache: "no-store" }
      );
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: Resumen; error?: string };
      if (!res.ok || !json.success || !json.data) {
        setErr(json.error ?? `Error ${res.status}`);
        setData(null);
        return;
      }
      setData(json.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error de red");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sorteoId) void load(sorteoId);
  }, [sorteoId, load]);

  const reportUrl = useCallback((token: string) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/r/reporte/${token}`;
  }, []);

  const copyLink = useCallback(
    async (rev: RevRow) => {
      const url = reportUrl(rev.report_slug);
      try {
        await navigator.clipboard.writeText(url);
        setCopied(rev.id);
        window.setTimeout(() => setCopied((c) => (c === rev.id ? null : c)), 2500);
      } catch {
        window.prompt("Copiá el link del reporte:", url);
      }
    },
    [reportUrl]
  );

  const [downloading, setDownloading] = useState<null | "xlsx" | "pdf">(null);
  const downloadExport = useCallback(
    async (format: "xlsx" | "pdf") => {
      if (!sorteoId || downloading) return;
      setDownloading(format);
      setErr(null);
      try {
        const res = await fetchWithSupabaseSession(
          `/api/sorteos/revendedores/export?sorteo_id=${encodeURIComponent(sorteoId)}&format=${format}`,
          { cache: "no-store" }
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setErr(j.error ?? `Error ${res.status}`);
          return;
        }
        const blob = await res.blob();
        const cd = res.headers.get("Content-Disposition") ?? "";
        const m = cd.match(/filename="([^"]+)"/);
        const filename = m?.[1] ?? `revendedores.${format}`;
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Error al descargar");
      } finally {
        setDownloading(null);
      }
    },
    [sorteoId, downloading]
  );

  const totales = data?.totales;
  const revs = useMemo(() => data?.revendedores ?? [], [data]);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#4FAEB2]">Sorteos</div>
          <h1 className="text-xl font-bold text-slate-900">Revendedores</h1>
          <p className="text-sm text-slate-500 mt-0.5">Rendimiento por vendedor y link de reporte para compartir.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Sorteo</span>
            <select
              value={sorteoId}
              onChange={(e) => setSorteoId(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm focus:border-[#4FAEB2] focus:outline-none"
            >
              {sorteos.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nombre} {s.estado === "activo" ? "• activo" : `• ${s.estado}`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!sorteoId || downloading !== null}
            onClick={() => void downloadExport("xlsx")}
            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
          >
            {downloading === "xlsx" ? "Generando…" : "Descargar Excel"}
          </button>
          <button
            type="button"
            disabled={!sorteoId || downloading !== null}
            onClick={() => void downloadExport("pdf")}
            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-50"
          >
            {downloading === "pdf" ? "Generando…" : "Descargar PDF"}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Revendedores", value: totales ? String(totales.revendedores) : "…" },
          { label: "Ventas atribuidas", value: totales ? String(totales.ventas) : "…" },
          { label: "Boletos vendidos", value: totales ? String(totales.boletos) : "…" },
          { label: "Monto total", value: totales ? fmtGs(totales.monto) : "…" },
        ].map((k) => (
          <div key={k.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{k.label}</div>
            <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{k.value}</div>
          </div>
        ))}
      </div>

      {err ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      {/* Leaderboard */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-semibold">#</th>
                <th className="px-4 py-3 font-semibold">Vendedor</th>
                <th className="px-4 py-3 font-semibold">Código</th>
                <th className="px-4 py-3 font-semibold text-right">Clics</th>
                <th className="px-4 py-3 font-semibold text-right">Ventas</th>
                <th className="px-4 py-3 font-semibold text-right">Boletos</th>
                <th className="px-4 py-3 font-semibold text-right">Monto</th>
                <th className="px-4 py-3 font-semibold text-right">Conv.</th>
                <th className="px-4 py-3 font-semibold text-right">Reporte</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-400">Cargando…</td>
                </tr>
              ) : revs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                    Este sorteo no tiene revendedores cargados.
                  </td>
                </tr>
              ) : (
                revs.map((rev, i) => (
                  <tr key={rev.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 text-slate-400 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{rev.nombre || "(sin nombre)"}</div>
                      {rev.telefono ? <div className="text-[11px] text-slate-400 font-mono">{rev.telefono}</div> : null}
                      {!rev.activo ? <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">inactivo</span> : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs bg-slate-100 rounded px-1.5 py-0.5 text-slate-700">{rev.codigo_referido ?? "—"}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{rev.clicks}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className="font-semibold text-slate-900">{rev.ventas}</span>
                      {rev.ventas_pendientes > 0 ? <span className="text-[10px] text-amber-600 ml-1">({rev.ventas_pendientes} pend.)</span> : null}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">{rev.boletos}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-900">{fmtGs(rev.monto)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {rev.clicks > 0 ? `${Math.round(rev.conversion * 100)}%` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => void copyLink(rev)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition-colors hover:border-[#4FAEB2]/60 hover:text-[#3F8E91]"
                        >
                          {copied === rev.id ? "¡Copiado!" : "Copiar link"}
                        </button>
                        <a
                          href={reportUrl(rev.report_slug)}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg bg-[#4FAEB2] px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-[#3F8E91]"
                        >
                          Abrir
                        </a>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-4 text-[12px] text-slate-400">
        El link de reporte es público y muestra solo las ventas de ese vendedor (sin datos de los compradores). Compartilo por WhatsApp o donde prefieras.
      </p>
    </div>
  );
}
