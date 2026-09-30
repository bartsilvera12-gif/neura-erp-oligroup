"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type { SorteosVentasDashboard } from "@/lib/sorteos/ventas-dashboard";
import type { SorteoListItem } from "@/components/sorteos/SorteoCuponManualForm";

/**
 * Pestaña "Sorteos" del dashboard: cuánto se vendió a mano (arriba, que es lo que se controla
 * a diario) y cuánto vendió el bot (abajo), sobre el mismo período y el mismo eje.
 *
 * Dos series = paleta categórica de dos hues validada contra el fondo claro del tablero;
 * la identidad nunca queda solo en el color: leyenda, etiquetas directas en las tarjetas y
 * la tabla por operador dicen lo mismo en texto.
 */
const C_MANUAL = "#0E8F86";
const C_BOT = "#3B4E9B";

const PYG = new Intl.NumberFormat("es-PY");
const num = (n: number) => PYG.format(Math.round(n || 0));
const gs = (n: number) => `₲ ${num(n)}`;

function hoyAsuncion(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Asuncion",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function restarDias(ymd: string, dias: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** "2026-09-25" → "25/09", que es como se lee el eje en una serie corta de días. */
function ejeDia(ymd: string): string {
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
}

function Kpi({
  label,
  valor,
  detalle,
  color,
}: {
  label: string;
  valor: string;
  detalle?: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p
        className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-slate-900"
        style={color ? { color } : undefined}
      >
        {valor}
      </p>
      {detalle ? <p className="mt-0.5 text-[11px] text-slate-500">{detalle}</p> : null}
    </div>
  );
}

type TooltipPayloadItem = { name?: string; value?: number; color?: string };

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-slate-700">Día {label}</p>
      {payload.map((p) => (
        <p key={p.name} className="mt-0.5 flex items-center gap-1.5 text-slate-600">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-[2px]"
            style={{ background: p.color }}
          />
          {p.name}: <span className="font-semibold tabular-nums text-slate-900">{num(p.value ?? 0)}</span>
        </p>
      ))}
    </div>
  );
}

export default function SorteosVentasTab() {
  const hoy = useMemo(() => hoyAsuncion(), []);
  const [desde, setDesde] = useState(() => restarDias(hoyAsuncion(), 29));
  const [hasta, setHasta] = useState(hoy);
  const [sorteoId, setSorteoId] = useState("");
  const [sorteos, setSorteos] = useState<SorteoListItem[]>([]);
  const [data, setData] = useState<SorteosVentasDashboard | null>(null);
  const [cargando, setCargando] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithSupabaseSession("/api/sorteos/manual-options", {
          cache: "no-store",
        });
        const json = (await res.json()) as { success?: boolean; data?: SorteoListItem[] };
        if (!cancelled && res.ok && json.success && Array.isArray(json.data)) setSorteos(json.data);
      } catch {
        /* el filtro por sorteo queda en "todos" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    setErr(null);
    try {
      const q = new URLSearchParams({ desde, hasta });
      if (sorteoId) q.set("sorteo_id", sorteoId);
      const res = await fetchWithSupabaseSession(`/api/sorteos/ventas-dashboard?${q}`, {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        success?: boolean;
        data?: SorteosVentasDashboard;
        error?: string;
      };
      if (!res.ok || !json.success || !json.data) {
        setErr(json.error ?? "No se pudieron cargar las ventas.");
        setData(null);
        return;
      }
      setData(json.data);
    } catch {
      setErr("Error de red al cargar las ventas.");
      setData(null);
    } finally {
      setCargando(false);
    }
  }, [desde, hasta, sorteoId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const serie = useMemo(
    () =>
      (data?.porDia ?? []).map((d) => ({
        dia: ejeDia(d.dia),
        Manual: d.manual.boletas,
        Bot: d.bot.boletas,
      })),
    [data]
  );

  const totalBoletas = (data?.manual.boletas ?? 0) + (data?.bot.boletas ?? 0);
  const pctManual = totalBoletas > 0 ? Math.round(((data?.manual.boletas ?? 0) / totalBoletas) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Filtros: una sola fila arriba de todo el tablero */}
      <div className="grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Sorteo
          <select
            value={sorteoId}
            onChange={(e) => setSorteoId(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-800"
          >
            <option value="">Todos</option>
            {sorteos.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Desde
          <input
            type="date"
            value={desde}
            max={hasta}
            onChange={(e) => setDesde(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-normal tracking-normal text-slate-800"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Hasta
          <input
            type="date"
            value={hasta}
            min={desde}
            max={hoy}
            onChange={(e) => setHasta(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-normal tracking-normal text-slate-800"
          />
        </label>
      </div>

      {err ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {err}
        </div>
      ) : null}
      {cargando && !data ? <p className="text-sm text-slate-500">Cargando ventas…</p> : null}

      {data ? (
        <>
          {/* ARRIBA: carga manual — es la que se controla a diario */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 rounded-[3px]"
                  style={{ background: C_MANUAL }}
                />
                Venta manual (ERP)
              </h3>
              <span className="text-xs text-slate-500">
                {pctManual}% de las boletas del período
              </span>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Kpi label="Ventas" valor={num(data.manual.ventas)} />
              <Kpi label="Boletas" valor={num(data.manual.boletas)} color={C_MANUAL} />
              <Kpi label="Recaudado" valor={gs(data.manual.monto)} />
            </div>

            <h4 className="mt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Por vendedor
            </h4>
            {data.operadores.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">
                No hay ventas manuales en el período seleccionado.
              </p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left">
                      <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                        Vendedor
                      </th>
                      <th className="px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                        Ventas
                      </th>
                      <th className="px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                        Boletas
                      </th>
                      <th className="px-2 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                        Recaudado
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.operadores.map((o) => (
                      <tr key={o.usuario_id ?? o.nombre} className="border-b border-slate-50">
                        <td className="px-2 py-2.5 text-slate-800">{o.nombre}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-slate-600">
                          {num(o.ventas)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-semibold tabular-nums text-slate-900">
                          {num(o.boletas)}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-slate-700">
                          {gs(o.monto)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ABAJO: el bot, con las mismas métricas para poder compararlas */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-[3px]"
                style={{ background: C_BOT }}
              />
              Ventas por el bot de WhatsApp
            </h3>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Kpi label="Ventas" valor={num(data.bot.ventas)} />
              <Kpi label="Boletas" valor={num(data.bot.boletas)} color={C_BOT} />
              <Kpi label="Recaudado" valor={gs(data.bot.monto)} />
            </div>
          </section>

          {/* Comparación en el tiempo: un solo eje, dos series */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-slate-800">Boletas por día</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Manual contra bot, en el mismo eje: {num(totalBoletas)} boletas en el período.
            </p>
            {serie.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">Sin ventas en el período seleccionado.</p>
            ) : (
              <div className="mt-3 h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={serie} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
                    <CartesianGrid stroke="#F1F5F9" vertical={false} />
                    <XAxis
                      dataKey="dia"
                      tick={{ fontSize: 11, fill: "#64748B" }}
                      tickLine={false}
                      axisLine={{ stroke: "#E2E8F0" }}
                      interval="preserveStartEnd"
                      minTickGap={12}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#64748B" }}
                      tickLine={false}
                      axisLine={false}
                      width={44}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: "#F8FAFC" }} />
                    <Legend
                      wrapperStyle={{ fontSize: 12, color: "#475569", paddingTop: 8 }}
                      iconType="square"
                    />
                    <Bar dataKey="Manual" fill={C_MANUAL} radius={[4, 4, 0, 0]} maxBarSize={22} />
                    <Bar dataKey="Bot" fill={C_BOT} radius={[4, 4, 0, 0]} maxBarSize={22} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
