"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type VentaFacturable = {
  id: string;
  numero_orden: number | null;
  nombre_participante: string | null;
  documento: string | null;
  ciudad: string | null;
  monto_total: number | null;
  cantidad_boletos: number | null;
  cliente_id: string | null;
  created_at: string | null;
};

type FacturaRow = {
  id: string;
  numero_factura: string | null;
  fecha: string | null;
  monto: number | null;
  estado: string | null;
};

type EmitirResult = { entrada_id: string; ok: boolean; factura_id?: string; numero_factura?: string; error?: string };

const IVA_OPTS: { value: string; label: string }[] = [
  { value: "iva_10", label: "IVA 10%" },
  { value: "iva_5", label: "IVA 5%" },
  { value: "exenta", label: "Exenta" },
];

function gs(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return "₲ " + new Intl.NumberFormat("es-PY").format(v);
}
function fechaCorta(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-PY");
}

export default function FacturacionPage() {
  const [ventas, setVentas] = useState<VentaFacturable[]>([]);
  const [facturas, setFacturas] = useState<FacturaRow[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [ivaTipo, setIvaTipo] = useState("iva_10");
  const [loading, setLoading] = useState(true);
  const [facturando, setFacturando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [rv, rf] = await Promise.all([
        fetchWithSupabaseSession("/api/sorteos/facturacion/pendientes", { cache: "no-store" }),
        fetchWithSupabaseSession("/api/facturas", { cache: "no-store" }),
      ]);
      const jv = (await rv.json().catch(() => ({}))) as { success?: boolean; data?: VentaFacturable[]; error?: string };
      const jf = (await rf.json().catch(() => ({}))) as { success?: boolean; data?: FacturaRow[]; error?: string };
      if (!rv.ok || !jv.success) throw new Error(jv.error || "No se pudieron cargar las ventas.");
      setVentas(Array.isArray(jv.data) ? jv.data : []);
      setFacturas(rf.ok && jf.success && Array.isArray(jf.data) ? jf.data : []);
      setSel(new Set());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error de red");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalSel = useMemo(
    () => ventas.filter((v) => sel.has(v.id)).reduce((a, v) => a + (Number(v.monto_total) || 0), 0),
    [ventas, sel]
  );
  const allSelected = ventas.length > 0 && sel.size === ventas.length;

  const toggle = (id: string) =>
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(ventas.map((v) => v.id)));

  const facturar = useCallback(async () => {
    if (facturando || sel.size === 0) return;
    const ids = [...sel];
    const ok = window.confirm(
      `¿Emitir factura para ${ids.length} venta(s) por ${gs(totalSel)}, con ${
        IVA_OPTS.find((o) => o.value === ivaTipo)?.label ?? ivaTipo
      }?\n\nSe crea una factura por venta. Después se envía a la SET desde cada factura.`
    );
    if (!ok) return;
    setFacturando(true);
    setNotice(null);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession("/api/sorteos/facturacion/emitir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entrada_ids: ids, iva_tipo: ivaTipo }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { results?: EmitirResult[]; creadas?: number; fallidas?: number };
        error?: string;
      };
      if (!res.ok || !json.success) throw new Error(json.error || "No se pudo facturar.");
      const creadas = json.data?.creadas ?? 0;
      const fallidas = json.data?.fallidas ?? 0;
      const errs = (json.data?.results ?? []).filter((r) => !r.ok).slice(0, 3).map((r) => r.error).filter(Boolean);
      setNotice({
        kind: fallidas === 0 ? "ok" : "err",
        text:
          `Se crearon ${creadas} factura(s)` +
          (fallidas > 0 ? `. ${fallidas} no se pudo(ieron): ${errs.join(" · ")}` : ".") +
          " Ahora enviá cada una a la SET desde su factura.",
      });
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: e instanceof Error ? e.message : "Error de red" });
    } finally {
      setFacturando(false);
    }
  }, [facturando, sel, totalSel, ivaTipo, load]);

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-gray-900">Facturación</h1>
        <p className="text-sm text-gray-500">
          Emití facturas electrónicas (SIFEN) sobre las ventas de sorteo. Elegí las ventas, el IVA, y creá las
          facturas; después cada factura se envía a la SET desde su detalle.
        </p>
      </div>

      {err && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm px-4 py-3">{err}</div>
      )}
      {notice && (
        <div
          className={`rounded-lg text-sm px-4 py-3 border ${
            notice.kind === "ok"
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-amber-50 border-amber-200 text-amber-900"
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Ventas facturables */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Ventas sin facturar</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {loading ? "Cargando…" : `${ventas.length} venta(s) confirmada(s) pendientes de facturar`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
              IVA
              <select
                value={ivaTipo}
                onChange={(e) => setIvaTipo(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 outline-none focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20"
              >
                {IVA_OPTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={facturando || sel.size === 0}
              onClick={() => void facturar()}
              className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#3F8E91] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {facturando ? "Facturando…" : `Facturar seleccionadas (${sel.size})`}
            </button>
          </div>
        </div>

        {sel.size > 0 ? (
          <div className="px-5 py-2 bg-[#4FAEB2]/5 border-b border-slate-100 text-xs text-slate-600">
            Seleccionadas: <b>{sel.size}</b> · Total: <b>{gs(totalSel)}</b>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-100">
                <th className="px-4 py-2.5">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Seleccionar todas" />
                </th>
                <th className="px-3 py-2.5">Orden</th>
                <th className="px-3 py-2.5">Comprador</th>
                <th className="px-3 py-2.5">Cédula</th>
                <th className="px-3 py-2.5 text-right">Monto</th>
                <th className="px-3 py-2.5">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-400 animate-pulse">
                    Cargando…
                  </td>
                </tr>
              ) : ventas.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    No hay ventas pendientes de facturar.
                  </td>
                </tr>
              ) : (
                ventas.map((v) => (
                  <tr key={v.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={sel.has(v.id)}
                        onChange={() => toggle(v.id)}
                        aria-label={`Seleccionar venta ${v.numero_orden ?? ""}`}
                      />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{v.numero_orden ?? "—"}</td>
                    <td className="px-3 py-2.5 text-slate-800">{v.nombre_participante || "—"}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{v.documento || "—"}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-800">{gs(v.monto_total)}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{fechaCorta(v.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Historial de facturas */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Historial de facturas</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Abrí cada factura para enviarla a la SET, ver su estado SIFEN y descargar el documento.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-100">
                <th className="px-4 py-2.5">Número</th>
                <th className="px-3 py-2.5">Fecha</th>
                <th className="px-3 py-2.5 text-right">Monto</th>
                <th className="px-3 py-2.5">Estado</th>
                <th className="px-3 py-2.5 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {facturas.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    Todavía no hay facturas emitidas.
                  </td>
                </tr>
              ) : (
                facturas.map((f) => (
                  <tr key={f.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-700">{f.numero_factura || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{fechaCorta(f.fecha)}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-slate-800">{gs(f.monto)}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        {f.estado || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        href={`/facturas/${f.id}`}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 transition-colors hover:border-[#4FAEB2]/60 hover:text-[#3F8E91]"
                      >
                        Abrir / enviar SET
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
