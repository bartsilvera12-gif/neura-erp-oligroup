"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Row = {
  id: string;
  estado_validacion: string;
  motivo_validacion: string | null;
  fecha: string;
  sorteo_nombre: string | null;
  cliente_nombre: string | null;
  telefono: string | null;
  conversation_id: string | null;
  boletas_ya: number;
  ordenes_ya: string | null;
};

function formatFecha(iso: string): string {
  if (!iso) return "—";
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

/** Texto legible del motivo de la validación. */
function motivoLabel(estado: string, motivo: string | null): string {
  const m = (motivo ?? "").trim();
  if (m === "asesor_aprobo_pendiente_datos") return "Aprobado — faltaban datos";
  if (m === "asesor_aprobo_comprobante") return "Aprobado por asesor";
  if (m === "asesor_aprobo_pendiente_confirmacion_cliente") return "Aprobado — falta confirmación";
  if (estado === "valido") return "Válido (automático)";
  if (m) return m;
  return estado;
}

/** Normaliza a dígitos para wa.me (Paraguay: 09… → 5959…). */
function waDigits(raw: string | null): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("0")) d = "595" + d.slice(1);
  else if (!d.startsWith("595") && d.length >= 7 && d.length <= 10) d = "595" + d;
  return d;
}

export default function ComprobantesSinBoletaPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession("/api/sorteos/comprobantes-sin-boleta", {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: Row[];
        error?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error?.trim() || `No se pudo cargar (${res.status})`);
      }
      setRows(Array.isArray(json.data) ? json.data : []);
    } catch (e) {
      setRows([]);
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const pendientes = rows.filter((r) => r.boletas_ya === 0);

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs text-slate-500">
        <Link href="/sorteos" className="font-medium text-slate-500 transition-colors hover:text-[#4FAEB2]">
          Sorteos
        </Link>
        <span aria-hidden className="text-slate-300">/</span>
        <span className="font-semibold text-slate-700">Comprobantes sin boleta</span>
      </nav>

      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]"
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-600">
            Sorteos · Alerta
          </p>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
          Comprobantes sin boleta
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Pagos <b>aprobados</b> que quedaron <b>sin boleta generada</b>. Suele pasar cuando el
          cliente paga en varias charlas y en alguna faltaban datos. Resolvelos con{" "}
          <Link href="/sorteos/cupones-manuales" className="font-medium text-[#3F8E91] hover:underline">
            Venta manual
          </Link>{" "}
          o avisale al cliente.
        </p>
      </div>

      {/* Resumen */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          {pendientes.length} por resolver
        </span>
        {rows.length - pendientes.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {rows.length - pendientes.length} ya tienen boleta por otra venta
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void cargar()}
          disabled={loading}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:text-[#3F8E91] disabled:opacity-50"
        >
          {loading ? "Actualizando…" : "Actualizar"}
        </button>
      </div>

      {err ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {err}
        </div>
      ) : null}

      {/* Tabla */}
      <div className="overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-500">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#4FAEB2]" />
            Cargando…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-slate-400">
            🎉 No hay comprobantes aprobados sin boleta. ¡Todo en orden!
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Fecha</th>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3">Teléfono</th>
                  <th className="px-4 py-3">Sorteo</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">¿Ya tiene boleta?</th>
                  <th className="px-4 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const wa = waDigits(r.telefono);
                  const yaTiene = r.boletas_ya > 0;
                  return (
                    <tr key={r.id} className="transition-colors hover:bg-amber-50/40">
                      <td className="px-4 py-3 text-xs text-slate-600">{formatFecha(r.fecha)}</td>
                      <td className="px-4 py-3 text-sm text-slate-800">{r.cliente_nombre || "—"}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-600">
                        {r.telefono || "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">{r.sorteo_nombre || "—"}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {motivoLabel(r.estado_validacion, r.motivo_validacion)}
                      </td>
                      <td className="px-4 py-3">
                        {yaTiene ? (
                          <span
                            className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700"
                            title={r.ordenes_ya ? `Órdenes: ${r.ordenes_ya}` : undefined}
                          >
                            Ya tiene {r.boletas_ya}
                            {r.ordenes_ya ? ` · Nº ${r.ordenes_ya}` : ""}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                            Sin boleta
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Link
                            href="/sorteos/cupones-manuales"
                            className="inline-flex items-center rounded-lg border border-[#4FAEB2]/30 bg-[#4FAEB2]/10 px-2.5 py-1 text-[11px] font-semibold text-[#3F8E91] transition-colors hover:bg-[#4FAEB2]/20"
                          >
                            Crear venta
                          </Link>
                          {wa ? (
                            <a
                              href={`https://wa.me/${wa}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
                            >
                              WhatsApp
                            </a>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-snug text-slate-400">
        “Ya tiene boleta” se calcula por el número de teléfono: si figura, probablemente ya se
        resolvió con otra venta (podés ignorarlo). “Sin boleta” es el que hay que resolver.
      </p>
    </div>
  );
}
