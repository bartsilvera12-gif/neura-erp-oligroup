"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { getConfig } from "@/lib/config/storage";
import { getUsuarios } from "@/lib/usuarios/storage";
import type { ConfigGlobal } from "@/lib/config/types";
import type { Usuario } from "@/lib/usuarios/types";
import {
  esFacturaAnulada,
  esFacturaCorregidaNc,
  buildMontoNcAprobadaPorFacturaId,
  montoFacturaNetoValorComercial,
  getDashboardData,
  type ProspectoRaw,
  type ClienteRaw,
  type FacturaRaw,
  type PagoRaw,
  type TipificacionRaw,
  type ProductoRaw,
  type VentaRaw,
  type CompraRaw,
  type GastoRaw,
  type SuscripcionDashRow,
  type NotaCreditoDashRow,
} from "@/lib/dashboard/data";
import {
  enRangoCalendario,
  enMesCalendarioActual,
  hoyYmdLocal,
  rangoMesCalendarioLocal,
  toCalendarDateStr,
} from "@/lib/fechas/calendario";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import SorteosVentasTab from "@/components/dashboard/SorteosVentasTab";
import { etiquetaVisibleTipoServicio } from "@/lib/clientes/tipo-servicio-catalogo";
import { useMapNombreTipoServicioCatalogo } from "@/lib/clientes/use-map-nombre-tipo-servicio";
import { getEtapas, getEtapaClasses, normalizeEtapaCodigo, type EtapaCrm } from "@/lib/crm/etapas";
import {
  isDashboardTabSlug,
  type DashboardTabSlug,
} from "@/lib/dashboard/resolve-effective-dashboard-views";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// ── ZENTRA (solo dashboard / esta página) ─────────────────────────────────────
const Z = {
  bg:       "#F8FAFC",
  surface:  "#FFFFFF",
  card:     "#FFFFFF",
  accent:   "#4FAEB2",
  text:     "#0F172A",
  muted:    "#64748B",
  success:  "#10B981",
  error:    "#EF4444",
} as const;

function ZentraMark({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#4FAEB2]/45 bg-[#4FAEB2]/10 shadow-[0_0_0_4px_rgba(79,174,178,0.06)] ${className}`}
    >
      <span className="text-xl font-extrabold leading-none tracking-tight" style={{ color: Z.accent }}>
        Z
      </span>
    </div>
  );
}

// ── Iconografía SVG común del dashboard ───────────────────────────────────────
type IconProps = { className?: string };
const Icon = {
  Comercial: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 3v18h18" />
      <rect x="7" y="13" width="3" height="5" rx="0.5" />
      <rect x="12" y="9" width="3" height="9" rx="0.5" />
      <rect x="17" y="6" width="3" height="12" rx="0.5" />
    </svg>
  ),
  Financiero: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  Inventario: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  ),
  Ventas: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  ),
  Sorteos: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2 9V7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
      <path d="M9 5v14" strokeDasharray="2 3" />
    </svg>
  ),
  Target: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  ),
  Chat: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  CheckCircle: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  TrendUp: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  ),
  TrendDown: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
      <polyline points="17 18 23 18 23 12" />
    </svg>
  ),
  Box: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    </svg>
  ),
  Hash: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  ),
  Alert: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  Diamond: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M6 3h12l4 6-10 12L2 9z" />
      <path d="M11 3 8 9l4 12 4-12-3-6" />
      <path d="M2 9h20" />
    </svg>
  ),
  Calendar: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  Ticket: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 7v2a2 2 0 0 1 0 4v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2a2 2 0 0 1 0-4V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" />
      <line x1="13" y1="5" x2="13" y2="7" />
      <line x1="13" y1="11" x2="13" y2="13" />
      <line x1="13" y1="17" x2="13" y2="19" />
    </svg>
  ),
  Wallet: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M20 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z" />
      <path d="M16 14h.01" />
      <path d="M20 7V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2" />
    </svg>
  ),
  PieIcon: ({ className = "h-4 w-4" }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
      <path d="M22 12A10 10 0 0 0 12 2v10z" />
    </svg>
  ),
};

function labelClienteDimension(raw: string): string {
  const s = raw.trim();
  if (!s) return "Sin clasificar";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/_/g, " ");
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Periodo = "hoy" | "7d" | "30d" | "mes" | "anio";
type TabDash = DashboardTabSlug;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatGs(n: number): string {
  return n.toLocaleString("es-PY");
}

/**
 * Formato completo con separadores de miles. Para KPIs operativas donde el
 * usuario necesita ver el monto real (ej. "Gs. 286.000" en lugar de "286K").
 * Solo abrevia cuando el numero es muy grande (>= 1.000 millones) y mostrarlo
 * completo romperia la tarjeta.
 */
function formatGsFull(n: number): string {
  const num = Number(n);
  if (!Number.isFinite(num)) return "0";
  if (Math.abs(num) >= 1_000_000_000) {
    const b = num / 1_000_000_000;
    return `${b.toFixed(2).replace(".", ",")} MM`;
  }
  return Math.round(num).toLocaleString("es-PY");
}

/** Formato abreviado (mantengo para charts/ejes donde el espacio es limitado). */
function formatGsM(n: number): string {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0) return "0";
  if (num >= 1_000_000_000) {
    const b = num / 1_000_000_000;
    return b % 1 === 0 ? `${b}B` : `${b.toFixed(1)}B`;
  }
  if (num >= 1_000_000) {
    const m = num / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (num >= 1_000) return `${Math.round(num / 1_000)}K`;
  return num.toLocaleString("es-PY");
}

function formatFecha(s: string): string {
  const cal = s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(cal)) {
    const [y, m, d] = cal.split("-");
    return `${d}/${m}/${y}`;
  }
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("es-PY", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function getRango(periodo: Periodo): { desde: Date; hasta: Date } {
  const ahora = new Date();
  switch (periodo) {
    case "mes":
      return rangoMesCalendarioLocal(ahora);
    case "hoy": {
      const desde = new Date(ahora);
      desde.setHours(0, 0, 0, 0);
      const hasta = new Date(ahora);
      hasta.setHours(23, 59, 59, 999);
      return { desde, hasta };
    }
    case "7d": {
      const hasta = new Date(ahora);
      hasta.setHours(23, 59, 59, 999);
      const desde = new Date(ahora);
      desde.setDate(desde.getDate() - 7);
      desde.setHours(0, 0, 0, 0);
      return { desde, hasta };
    }
    case "30d": {
      const hasta = new Date(ahora);
      hasta.setHours(23, 59, 59, 999);
      const desde = new Date(ahora);
      desde.setDate(desde.getDate() - 30);
      desde.setHours(0, 0, 0, 0);
      return { desde, hasta };
    }
    case "anio": {
      const desde = new Date(ahora.getFullYear(), 0, 1, 0, 0, 0, 0);
      const hasta = new Date(ahora.getFullYear(), 11, 31, 23, 59, 59, 999);
      return { desde, hasta };
    }
    default:
      return rangoMesCalendarioLocal(ahora);
  }
}

/** Fecha pura YYYY-MM-DD: comparación calendario (sin UTC). ISO con hora: rango por instante. */
function enRango(fechaStr: string | null | undefined, desde: Date, hasta: Date): boolean {
  const t = String(fechaStr ?? "").trim();
  if (!t) return false;
  const cal = t.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(cal) && t.length <= 10) {
    return enRangoCalendario(cal, desde, hasta);
  }
  const f = new Date(t);
  return !isNaN(f.getTime()) && f >= desde && f <= hasta;
}

/** Cada día calendario entre `desde` y `hasta` (inclusive), en YYYY-MM-DD local. */
function listarDiasCalendarioYmd(desde: Date, hasta: Date): string[] {
  const out: string[] = [];
  const cur = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
  const end = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
  while (cur.getTime() <= end.getTime()) {
    out.push(hoyYmdLocal(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// ── Componentes de gráficos ───────────────────────────────────────────────────

/** Fila de pipeline: etiquetas y colores vienen de `crm_etapas` (getEtapas), no de listas fijas en el dashboard. */
type PipelineBarRowZ = { rowKey: string; label: string; count: number; valor: number; dotClass: string; barClass: string };

function PipelineBar({ data, tone = "light" }: { data: PipelineBarRowZ[]; tone?: "light" | "zentra" }) {
  const maxC = Math.max(...data.map((d) => d.count), 1);
  const z = tone === "zentra";
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.rowKey}>
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className={`h-2 w-2 shrink-0 rounded-full ${d.dotClass}`} />
              <span
                className={`text-xs font-medium truncate ${z ? "" : "text-gray-700"}`}
                style={z ? { color: Z.text } : undefined}
                title={d.label}
              >
                {d.label}
              </span>
            </div>
            <div
              className={`ml-2 flex shrink-0 items-center gap-4 text-xs ${z ? "" : "text-gray-500"}`}
              style={z ? { color: Z.muted } : undefined}
            >
              <span className={`tabular-nums font-semibold ${z ? "" : "text-gray-700"}`} style={z ? { color: Z.text } : undefined}>
                {d.count}
              </span>
              <span className="w-20 text-right tabular-nums">Gs. {formatGsM(d.valor)}</span>
            </div>
          </div>
          <div
            className={`h-5 overflow-hidden rounded-full ${z ? "" : "bg-gray-100"}`}
            style={z ? { backgroundColor: "rgba(15,23,42,0.06)" } : undefined}
          >
            <div
              className={`h-full rounded-full transition-all ${d.barClass}`}
              style={{ width: `${d.count > 0 ? Math.max((d.count / maxC) * 100, 4) : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function HBarChart({
  data,
  color = "bg-blue-400",
  tone = "light",
}: { data: { label: string; value: number }[]; color?: string; tone?: "light" | "zentra" }) {
  const max = Math.max(...data.map(d => d.value), 1);
  const z = tone === "zentra";
  return (
    <div className="space-y-2">
      {data.slice(0, 8).map((d, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className={`w-28 shrink-0 truncate text-xs ${z ? "" : "text-gray-600"}`} style={z ? { color: Z.muted } : undefined} title={d.label}>
            {d.label}
          </span>
          <div className={`h-5 flex-1 overflow-hidden rounded-full ${z ? "" : "bg-gray-100"}`} style={z ? { backgroundColor: "rgba(15,23,42,0.06)" } : undefined}>
            <div
              className={`h-full rounded-full ${color} transition-all`}
              style={{ width: `${d.value > 0 ? Math.max((d.value / max) * 100, 3) : 0}%` }}
            />
          </div>
          <span className={`w-8 shrink-0 text-right text-xs font-semibold tabular-nums ${z ? "" : "text-gray-700"}`} style={z ? { color: Z.text } : undefined}>
            {d.value}
          </span>
        </div>
      ))}
      {data.length === 0 && (
        <p className={`py-4 text-center text-xs ${z ? "" : "text-gray-400"}`} style={z ? { color: Z.muted } : undefined}>
          Sin datos
        </p>
      )}
    </div>
  );
}

function AreaChart({
  data, color = "#6366f1",
}: { data: { label: string; value: number }[]; color?: string }) {
  if (data.length < 2) return <p className="text-xs text-gray-400 py-8 text-center">Sin datos suficientes</p>;
  const W = 480, H = 130, PL = 48, PR = 8, PT = 8, PB = 24;
  const cW = W - PL - PR, cH = H - PT - PB;
  const max = Math.max(...data.map(d => d.value), 1);
  const pts = data.map((d, i) => ({
    x: PL + (i / (data.length - 1)) * cW,
    y: PT + cH - (d.value / max) * cH,
  }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${(PT + cH).toFixed(1)} L${PL},${(PT + cH).toFixed(1)} Z`;
  const yTicks = [0, Math.floor(max / 2), max];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      {yTicks.map((v, i) => {
        const y = PT + cH - (v / max) * cH;
        return (
          <g key={i}>
            <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#f3f4f6" strokeWidth="1" />
            <text x={PL - 4} y={y + 3} textAnchor="end" fontSize="9" fill="#9ca3af">
              {formatGsM(v)}
            </text>
          </g>
        );
      })}
      <path d={area} fill={color} fillOpacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="2.5" fill={color} />)}
      {data.map((d, i) =>
        i % 2 === 0 ? (
          <text key={i} x={pts[i].x} y={H - 4} textAnchor="middle" fontSize="9" fill="#9ca3af">
            {d.label}
          </text>
        ) : null
      )}
    </svg>
  );
}

function DonutChart({
  segments,
  centerLabel = "total",
  formatValue = (v: number) => String(v),
  variant = "light",
  legendDetail = false,
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel?: string;
  formatValue?: (v: number) => string;
  variant?: "light" | "zentra";
  /** Muestra cantidad y % sobre el total en la leyenda */
  legendDetail?: boolean;
}) {
  const total = segments.reduce((s, g) => s + g.value, 0);
  const isZ = variant === "zentra";
  if (total === 0) {
    return (
      <div className="flex items-center gap-6">
        <div
          className={`flex h-32 w-32 shrink-0 items-center justify-center rounded-full ${isZ ? "border border-[#4FAEB2]/45" : "bg-gray-100"}`}
          style={isZ ? { backgroundColor: Z.surface } : undefined}
        >
          <span className={`text-xs ${isZ ? "" : "text-gray-400"}`} style={isZ ? { color: Z.muted } : undefined}>
            Sin datos
          </span>
        </div>
      </div>
    );
  }
  const R = 50, CX = 80, CY = 80, C = 2 * Math.PI * R;
  let cum = 0;
  const fillCenter = isZ ? Z.text : "#1f2937";
  const fillSub = isZ ? Z.muted : "#9ca3af";
  return (
    <div className="flex flex-col items-stretch gap-6 sm:flex-row sm:items-center">
      <svg viewBox="0 0 160 160" className="mx-auto h-36 w-36 shrink-0 sm:mx-0">
        {segments.map((seg, i) => {
          if (seg.value === 0) return null;
          const pct = seg.value / total;
          const dash = pct * C;
          const rot = cum * 360 - 90;
          cum += pct;
          return (
            <circle
              key={i}
              cx={CX}
              cy={CY}
              r={R}
              fill="none"
              stroke={seg.color}
              strokeWidth="22"
              strokeDasharray={`${dash} ${C - dash}`}
              transform={`rotate(${rot} ${CX} ${CY})`}
            />
          );
        })}
        <text x={CX} y={CY + 5} textAnchor="middle" fontSize="17" fontWeight="bold" fill={fillCenter}>
          {formatValue(total)}
        </text>
        <text x={CX} y={CY + 20} textAnchor="middle" fontSize="9" fill={fillSub}>
          {centerLabel}
        </text>
      </svg>
      <div className="min-w-0 flex-1 space-y-2.5">
        {segments.map((seg, i) => {
          const pct = total > 0 ? (seg.value / total) * 100 : 0;
          return (
            <div key={i} className="flex items-center gap-2.5">
              <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: seg.color }} />
              <span
                className={`min-w-0 flex-1 truncate text-xs ${isZ ? "" : "text-gray-600"}`}
                style={isZ ? { color: Z.text } : undefined}
                title={seg.label}
              >
                {seg.label}
              </span>
              {legendDetail ? (
                <span
                  className="shrink-0 text-xs font-semibold tabular-nums"
                  style={{ color: isZ ? Z.muted : "#1f2937" }}
                >
                  {formatValue(seg.value)} · {pct.toFixed(1)}%
                </span>
              ) : (
                <span className={`shrink-0 text-xs font-bold tabular-nums ${isZ ? "" : "text-gray-800"}`} style={isZ ? { color: Z.muted } : undefined}>
                  {formatValue(seg.value)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressBar({
  label,
  value,
  meta,
  format = "number",
  variant = "light",
}: {
  label: string;
  value: number;
  meta: number;
  format?: "number" | "gs" | "pct";
  variant?: "light" | "zentra";
}) {
  const valueN = Number(value);
  const metaN = Number(meta);
  const v = Number.isFinite(valueN) ? valueN : 0;
  const m = Number.isFinite(metaN) && metaN > 0 ? metaN : 0;
  const pct = m > 0 ? Math.min((v / m) * 100, 100) : 0;
  const color =
    variant === "zentra"
      ? pct >= 100
        ? Z.success
        : pct >= 70
          ? "#F59E0B"
          : Z.accent
      : null;
  const barClass =
    variant === "light"
      ? pct >= 100
        ? "bg-green-500"
        : pct >= 70
          ? "bg-amber-400"
          : "bg-blue-500"
      : "";
  const fmt = (n: number) =>
    format === "gs" ? `Gs. ${formatGsM(n)}` : format === "pct" ? `${n.toFixed(1)}%` : String(n);
  const metaLabel =
    m > 0 ? fmt(m) : format === "gs" ? "sin meta" : "—";
  const isZ = variant === "zentra";

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className={`text-xs font-semibold ${isZ ? "" : "text-gray-700"}`} style={isZ ? { color: Z.text } : undefined}>
          {label}
        </span>
        <span className={`text-xs tabular-nums ${isZ ? "" : "text-gray-500"}`} style={isZ ? { color: Z.muted } : undefined}>
          {fmt(v)} <span style={{ color: isZ ? "rgba(15,23,42,0.2)" : "#d1d5db" }}>/</span> {metaLabel}
        </span>
      </div>
      <div className={`h-2 overflow-hidden rounded-full ${isZ ? "" : "bg-gray-100"}`} style={isZ ? { backgroundColor: "rgba(15,23,42,0.06)" } : undefined}>
        <div
          className={`h-full rounded-full transition-all ${barClass}`}
          style={isZ ? { width: `${pct}%`, backgroundColor: color ?? Z.accent } : { width: `${pct}%` }}
        />
      </div>
      <p className={`mt-1 text-xs ${isZ ? "" : "text-gray-400"}`} style={isZ ? { color: Z.muted } : undefined}>
        {pct.toFixed(0)}% de la meta
      </p>
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  color = "text-slate-900",
  icon,
  variation,
  variant = "light",
  accent = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  icon?: React.ReactNode;
  variation?: number;
  variant?: "light" | "zentra";
  /** `featured` aplica gradiente turquesa al chip y barra superior. */
  accent?: "neutral" | "featured" | "warning" | "danger";
}) {
  const chipCls =
    accent === "featured"
      ? "border-[#4FAEB2]/30 bg-[#4FAEB2]/12 text-[#4FAEB2]"
      : accent === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-600"
        : accent === "danger"
          ? "border-rose-200 bg-rose-50 text-rose-600"
          : "border-slate-200 bg-slate-50 text-slate-500";

  const variationCls =
    variation === undefined
      ? ""
      : variation >= 0
        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
        : "border-rose-200 bg-rose-50 text-rose-700";

  const cardCls =
    accent === "featured"
      ? "relative overflow-hidden rounded-2xl border border-[#4FAEB2]/55 bg-gradient-to-br from-white via-white to-[#4FAEB2]/8 p-5 shadow-[0_4px_18px_rgba(79,174,178,0.08)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_28px_rgba(79,174,178,0.14)] sm:p-6"
      : "relative overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:p-6";

  return (
    <motion.div whileHover={{ y: -2 }} className={cardCls}>
      {accent === "featured" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-[#4FAEB2] via-[#4FAEB2]/70 to-[#4FAEB2]/30"
        />
      ) : null}
      <div className="flex items-start justify-between gap-3">
        {icon ? (
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${chipCls}`}>
            {icon}
          </span>
        ) : null}
        {variation !== undefined ? (
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${variationCls}`}>
            {variation >= 0 ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            )}
            {variation >= 0 ? "+" : ""}
            {variation}%
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
        {label}
      </p>
      <p className={`mt-1 text-3xl font-semibold tabular-nums leading-tight tracking-tight ${variant === "zentra" ? color : color}`}>
        {value}
      </p>
      {sub ? (
        <p className="mt-1 text-[11px] text-slate-500">{sub}</p>
      ) : null}
    </motion.div>
  );
}

// ── Dashboard Comercial ───────────────────────────────────────────────────────

/** Valor comercial del cliente en el período: 1) facturas netas (NC aprobadas) en período, 2) suscripción alta/inicio en período. */
function valorComercialClienteEnPeriodo(
  clienteId: string | number,
  facturas: FacturaRaw[],
  ncPorFactura: Map<string, number>,
  suscripciones: SuscripcionDashRow[],
  desde: Date,
  hasta: Date
): { monto: number; fuente: "facturas" | "suscripcion" | "sin_dato" } {
  const id = String(clienteId);
  const sumF = facturas
    .filter((f) => String(f.cliente_id) === id && enRango(f.fecha, desde, hasta))
    .reduce((s, f) => s + montoFacturaNetoValorComercial(f, ncPorFactura), 0);
  if (sumF > 0) return { monto: sumF, fuente: "facturas" };

  let sumS = 0;
  for (const s of suscripciones) {
    if (String(s.cliente_id) !== id) continue;
    if (enRango(s.fecha_inicio, desde, hasta) || enRango(s.created_at, desde, hasta)) {
      sumS += Number(s.precio) || 0;
    }
  }
  if (sumS > 0) return { monto: sumS, fuente: "suscripcion" };
  return { monto: 0, fuente: "sin_dato" };
}

function etiquetaPlanServicioCliente(
  c: ClienteRaw,
  mapNombreTipoServicio: Readonly<Record<string, string>>
) {
  const t = (c.tipo_servicio_cliente ?? "").trim();
  if (t) return etiquetaVisibleTipoServicio(t, mapNombreTipoServicio);
  const co = (c.condicion_pago ?? "").trim();
  if (co) return labelClienteDimension(co);
  return "—";
}

function DashComercial({
  prospectos,
  clientes,
  mapNombreTipoServicio,
  tipificaciones: _tipificaciones,
  usuario,
  periodo,
  config,
  facturas,
  notasCredito,
  suscripciones,
}: {
  prospectos: ProspectoRaw[];
  clientes: ClienteRaw[];
  mapNombreTipoServicio: Readonly<Record<string, string>>;
  tipificaciones: TipificacionRaw[];
  usuario: Usuario | null;
  periodo: Periodo;
  config: ConfigGlobal;
  facturas: FacturaRaw[];
  notasCredito: NotaCreditoDashRow[];
  suscripciones: SuscripcionDashRow[];
}) {
  void _tipificaciones;
  const { desde, hasta } = useMemo(() => getRango(periodo), [periodo]);

  const [etapasCrmCatalog, setEtapasCrmCatalog] = useState<EtapaCrm[]>([]);
  useEffect(() => {
    void getEtapas().then(setEtapasCrmCatalog);
  }, []);

  const ncPorFactura = useMemo(() => buildMontoNcAprobadaPorFacturaId(notasCredito), [notasCredito]);

  const isSupervisor = usuario?.nivel === "supervisor";
  const area = usuario?.area;

  const prospectosFilt = useMemo(
    () =>
      prospectos.filter((p) => {
        if (isSupervisor && area === "ventas" && p.responsable)
          return p.responsable.toUpperCase() === usuario?.nombre.toUpperCase();
        return true;
      }),
    [prospectos, isSupervisor, area, usuario]
  );

  const leadsNuevos = prospectosFilt.filter((p) => enRango(p.fecha_creacion, desde, hasta)).length;
  const enNegociacion = prospectosFilt.filter(
    (p) => normalizeEtapaCodigo(p.etapa) === "NEGOCIACION"
  ).length;
  const clientesGanados = prospectosFilt.filter(
    (p) => normalizeEtapaCodigo(p.etapa) === "GANADO" && enRango(p.fecha_actualizacion, desde, hasta)
  ).length;
  const totalLeadsPeriodo = prospectosFilt.filter((p) => enRango(p.fecha_creacion, desde, hasta)).length;
  const tasaConversion = totalLeadsPeriodo > 0 ? (clientesGanados / totalLeadsPeriodo) * 100 : 0;

  /** Misma fuente que el CRM Funnel: columnas = etapas activas en `crm_etapas` (orden + nombre a mostrar). */
  const pipeline: PipelineBarRowZ[] = useMemo(() => {
    const inFil = (cod: string) =>
      prospectosFilt.filter((p) => normalizeEtapaCodigo(p.etapa) === normalizeEtapaCodigo(cod));
    const actives = [...etapasCrmCatalog]
      .filter((e) => e.activo)
      .sort((a, b) => a.orden - b.orden);
    const fromCatalog: PipelineBarRowZ[] = actives.map((e) => {
      const { dot } = getEtapaClasses(e.color);
      const list = inFil(e.codigo);
      return {
        rowKey: e.id,
        label: e.nombre,
        count: list.length,
        valor: list.reduce((s, p) => s + (p.valor_estimado ?? 0), 0),
        dotClass: dot,
        // Usa el mismo color saturado del dot para la barra (más contraste sobre el track).
        barClass: dot,
      };
    });
    const catalogNorm = new Set(actives.map((e) => normalizeEtapaCodigo(e.codigo)));
    const extraCodes = new Set<string>();
    for (const p of prospectosFilt) {
      const c = normalizeEtapaCodigo(p.etapa);
      if (c && !catalogNorm.has(c)) extraCodes.add(c);
    }
    const fromExtras: PipelineBarRowZ[] = [...extraCodes].sort().map((code) => {
      const list = inFil(code);
      return {
        rowKey: `x-${code}`,
        label: code,
        count: list.length,
        valor: list.reduce((s, p) => s + (p.valor_estimado ?? 0), 0),
        dotClass: "bg-gray-400",
        barClass: "bg-gray-400",
      };
    });
    return [...fromCatalog, ...fromExtras];
  }, [etapasCrmCatalog, prospectosFilt]);

  const topPlanesEnNegociacion = useMemo(() => {
    const enNeg = prospectosFilt.filter((p) => normalizeEtapaCodigo(p.etapa) === "NEGOCIACION");
    const porPlan: Record<string, number> = {};
    for (const p of enNeg) {
      const plan = (p.servicio ?? "").trim() || "Otros";
      porPlan[plan] = (porPlan[plan] ?? 0) + (p.valor_estimado ?? 0);
    }
    return Object.entries(porPlan)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [prospectosFilt]);

  const topPlanesVendidos = useMemo(() => {
    const ganadosPeriodo = prospectosFilt.filter(
      (p) => normalizeEtapaCodigo(p.etapa) === "GANADO" && enRango(p.fecha_actualizacion, desde, hasta)
    );
    const porPlan: Record<string, number> = {};
    for (const p of ganadosPeriodo) {
      const planes = (p.servicio ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const plan of planes.length ? planes : ["Otros"]) {
        const key = plan || "Otros";
        porPlan[key] = (porPlan[key] ?? 0) + 1;
      }
    }
    return Object.entries(porPlan)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  }, [prospectosFilt, desde, hasta]);

  const rendimiento = useMemo(() => {
    const map: Record<string, number> = {};
    prospectosFilt
      .filter(
        (p) => normalizeEtapaCodigo(p.etapa) === "GANADO" && enRango(p.fecha_actualizacion, desde, hasta)
      )
      .forEach((p) => {
        const v = p.responsable ?? "Sin asignar";
        map[v] = (map[v] ?? 0) + 1;
      });
    return Object.entries(map)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [prospectosFilt, desde, hasta]);

  const filasClientesPeriodo = useMemo(() => {
    const nuevos = clientes.filter((c) => enRango(c.created_at, desde, hasta));
    return nuevos
      .map((c) => {
        const { monto, fuente } = valorComercialClienteEnPeriodo(
          c.id,
          facturas,
          ncPorFactura,
          suscripciones,
          desde,
          hasta
        );
        return {
          id: String(c.id),
          nombre: c.empresa ?? c.nombre_contacto,
          fechaAlta: c.created_at,
          planServicio: etiquetaPlanServicioCliente(c, mapNombreTipoServicio),
          monto,
          fuente,
          vendedor: c.vendedor_asignado?.trim() || "—",
        };
      })
      .sort((a, b) => new Date(b.fechaAlta).getTime() - new Date(a.fechaAlta).getTime());
  }, [clientes, facturas, ncPorFactura, suscripciones, desde, hasta, mapNombreTipoServicio]);

  const totalValorClientesNuevos = filasClientesPeriodo.reduce((s, r) => s + r.monto, 0);
  const nClientesNuevos = filasClientesPeriodo.length;
  const ticketPromedio = nClientesNuevos > 0 ? totalValorClientesNuevos / nClientesNuevos : 0;

  const panelClass = "rounded-2xl border border-[#4FAEB2]/45 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-8";
  const panelStyle = { backgroundColor: Z.card } as const;
  const titleClass = "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600";
  const titleStyle = undefined;
  const panelDot = (
    <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
  );
  const panelBar = (
    <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
  );

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard
          icon={<Icon.Target className="h-4 w-4" />}
          label="Leads nuevos"
          value={String(leadsNuevos)}
          color="text-slate-900"
          variation={12}
        />
        <KpiCard
          icon={<Icon.Chat className="h-4 w-4" />}
          label="En negociación"
          value={String(enNegociacion)}
          color="text-amber-600"
          accent="warning"
        />
        <KpiCard
          icon={<Icon.CheckCircle className="h-4 w-4" />}
          label="Clientes ganados (CRM)"
          value={String(clientesGanados)}
          color="text-[#3F8E91]"
          variation={8}
          accent="featured"
        />
        <KpiCard
          icon={<Icon.TrendUp className="h-4 w-4" />}
          label="Tasa de conversión"
          value={`${tasaConversion.toFixed(1)}%`}
          color={tasaConversion >= config.meta_conversion_leads ? "text-emerald-600" : "text-slate-900"}
          variation={tasaConversion >= config.meta_conversion_leads ? 5 : -2}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <motion.div whileHover={{ y: -2 }} className={panelClass} style={panelStyle}>
          <div className="flex items-center gap-2">
            {panelBar}
            <h3 className={titleClass} style={titleStyle}>
              {panelDot}
              Pipeline CRM
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">Distribución de prospectos por etapa</p>
          <div className="mt-5">
            <PipelineBar data={pipeline} tone="zentra" />
          </div>
        </motion.div>
        <motion.div whileHover={{ y: -2 }} className={panelClass} style={panelStyle}>
          <div className="flex items-center gap-2">
            {panelBar}
            <h3 className={titleClass} style={titleStyle}>
              {panelDot}
              Clientes ganados por vendedor
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">Ranking por cierres en el período</p>
          <div className="mt-5">
            <HBarChart data={rendimiento} color="bg-[#4FAEB2]" tone="zentra" />
          </div>
        </motion.div>
      </div>

      <motion.div whileHover={{ y: -2 }} className={panelClass} style={panelStyle}>
        <div className="flex items-center gap-2">
          {panelBar}
          <h3 className={titleClass} style={titleStyle}>
            {panelDot}
            Top planes vendidos · período seleccionado
          </h3>
        </div>
        <div className="mt-5">
          <HBarChart data={topPlanesVendidos} color="bg-[#4FAEB2]" tone="zentra" />
        </div>
      </motion.div>

      <motion.div whileHover={{ y: -2 }} className={panelClass} style={panelStyle}>
        <div className="flex items-center gap-2">
          {panelBar}
          <h3 className={titleClass} style={titleStyle}>
            {panelDot}
            Top planes en negociación
          </h3>
        </div>
        {topPlanesEnNegociacion.length === 0 ? (
          <p className="mt-6 text-center text-sm text-slate-500">
            Sin prospectos en negociación
          </p>
        ) : (
          <div className="mt-6">
            <DonutChart
              variant="zentra"
              legendDetail
              segments={topPlanesEnNegociacion.map((d, i) => ({
                label: d.label,
                value: d.value,
                color: ["#F59E0B", "#F97316", "#FB923C", "#FDBA74", "#FED7AA"][i] ?? "#9ca3af",
              }))}
              centerLabel="monto total"
              formatValue={(v) => formatGsM(v)}
            />
          </div>
        )}
      </motion.div>

      <motion.div
        whileHover={{ y: -3 }}
        className="rounded-2xl border border-[#4FAEB2]/45 bg-white p-6 shadow-[0_4px_24px_rgba(79,174,178,0.08)] sm:p-10"
      >
        <div className="flex flex-col gap-2 border-b border-slate-100 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-1 w-1 rounded-full bg-[#4FAEB2]" />
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
                Cartera · período
              </p>
            </div>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
              Clientes del período
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
              Altas con <strong className="text-slate-700">fecha de creación</strong> en el rango del filtro. Valor: suma de{" "}
              <strong className="text-slate-700">facturas emitidas en el período</strong> por cliente (neto de{" "}
              <strong className="text-slate-700">notas de crédito aprobadas</strong> por SET vinculadas a esas facturas; se excluyen
              anuladas y corregidas por NC); si no hay, suma de{" "}
              <strong className="text-slate-700">precio de suscripción</strong> con alta o inicio en el período.
            </p>
          </div>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-[#4FAEB2]/45 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Clientes nuevos
            </p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-slate-900">
              {nClientesNuevos}
            </p>
          </div>
          <div className="rounded-xl border border-[#4FAEB2]/45 bg-gradient-to-br from-[#4FAEB2]/8 to-[#4FAEB2]/0 px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#4FAEB2]">
              Valor asociado (Gs.)
            </p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-[#3F8E91]">
              {formatGsM(totalValorClientesNuevos)}
            </p>
          </div>
          <div className="rounded-xl border border-[#4FAEB2]/45 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Ticket promedio
            </p>
            <p className="mt-2 text-3xl font-semibold tabular-nums text-slate-900">
              {nClientesNuevos > 0 ? formatGsM(ticketPromedio) : "—"}
            </p>
          </div>
        </div>

        {filasClientesPeriodo.length === 0 ? (
          <p className="mt-8 text-center text-sm" style={{ color: Z.muted }}>
            No hay altas de cliente en este período.
          </p>
        ) : (
          <div
            className="mt-8 max-h-[min(28rem,55vh)] overflow-auto rounded-xl border border-[#4FAEB2]/45"
            style={{ backgroundColor: Z.card }}
          >
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b border-slate-200" style={{ backgroundColor: Z.card }}>
                <tr>
                  {["Cliente", "Alta", "Plan / servicio", "Monto (Gs.)", "Origen valor", "Vendedor"].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wide"
                      style={{ color: Z.muted }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filasClientesPeriodo.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-[#4FAEB2]/5">
                    <td className="max-w-[160px] truncate px-4 py-3 font-medium" style={{ color: Z.text }} title={row.nombre}>
                      {row.nombre}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs" style={{ color: Z.muted }}>
                      {formatFecha(row.fechaAlta)}
                    </td>
                    <td className="max-w-[140px] truncate px-4 py-3 text-xs" style={{ color: Z.muted }} title={row.planServicio}>
                      {row.planServicio}
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-semibold tabular-nums" style={{ color: Z.text }}>
                      {row.monto > 0 ? formatGs(row.monto) : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: Z.muted }}>
                      {row.fuente === "facturas"
                        ? "Facturas período"
                        : row.fuente === "suscripcion"
                          ? "Suscripción"
                          : "Sin factura / susc. en período"}
                    </td>
                    <td className="max-w-[120px] truncate px-4 py-3 text-xs" style={{ color: Z.muted }} title={row.vendedor}>
                      {row.vendedor}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// ── Dashboard Financiero ──────────────────────────────────────────────────────

/**
 * Monto "Gs. N" · `kpi`: mantiene prefijo y número juntos, tamaño con `cqi` (el padre define `container-type`).
 * Sin kpi: tipografía en clamp por viewport, permite salto.
 */
function FinMontoGs({
  monto,
  className = "text-slate-900",
  negativo,
  dense,
  kpi,
}: {
  monto: number;
  className?: string;
  negativo?: boolean;
  dense?: boolean;
  kpi?: boolean;
}) {
  const texto =
    negativo && monto < 0
      ? `− Gs. ${formatGs(Math.abs(monto))}`
      : `Gs. ${formatGs(monto)}`;
  if (kpi) {
    return (
      <p
        className={`min-w-0 w-full text-left font-bold leading-none tabular-nums whitespace-nowrap [font-size:clamp(0.65rem,5.5cqi+0.15rem,1.45rem)] ${className}`}
        title={texto}
      >
        {texto}
      </p>
    );
  }
  return (
    <p
      className={`${dense ? "mt-1" : "mt-3"} min-w-0 w-full max-w-full break-words whitespace-normal text-left font-bold tabular-nums leading-snug text-[clamp(0.8rem,2.4vw,1.65rem)] sm:text-[clamp(0.85rem,2.2vw,1.75rem)] ${className}`}
      title={texto}
    >
      {texto}
    </p>
  );
}

/**
 * Partición del saldo pendiente por modalidad, facturas con emisión en el rango (Σ saldo por `tipo` factura):
 * - Contado: `tipo` factura = contado
 * - Mensual / suscripción: resto (p. ej. crédito / cuotas vinculadas a suscripción en el producto)
 * Cada factura del período entra en exactamente un bucket (sin doble conteo).
 */
function composicionFacturacionPorModalidad(facturasPeriodo: FacturaRaw[]) {
  let contado = 0;
  let mensual = 0;
  for (const f of facturasPeriodo) {
    const m = Number(f.saldo);
    if (!Number.isFinite(m) || m <= 0) continue;
    const t = (f.tipo ?? "").trim().toLowerCase();
    if (t === "contado") contado += m;
    else mensual += m;
  }
  const total = contado + mensual;
  return {
    contado,
    mensual,
    total,
    pctContado: total > 0 ? (contado / total) * 100 : 0,
    pctMensual: total > 0 ? (mensual / total) * 100 : 0,
  };
}

function DashFinanciero({
  facturas, pagos, clientes, ventas, periodo, config, mapNombreTipoServicio,
}: {
  facturas:  FacturaRaw[];
  pagos:     PagoRaw[];
  clientes:  ClienteRaw[];
  ventas:    VentaRaw[];
  periodo:   Periodo;
  config:    ConfigGlobal;
  mapNombreTipoServicio: Readonly<Record<string, string>>;
}) {
  const { desde, hasta } = useMemo(() => getRango(periodo), [periodo]);

  // Bloque principal: métricas del período (misma ventana que el filtro superior: enRango + fechas calendario)
  const facturasValidas = facturas.filter((f) => !esFacturaAnulada(f.estado));
  const facturasPeriodo = facturasValidas.filter((f) => enRango(f.fecha, desde, hasta));
  const sumSaldoPendiente = (arr: FacturaRaw[]) =>
    arr.reduce((acc, x) => {
      const v = Number(x.saldo);
      return acc + (Number.isFinite(v) ? Math.max(0, v) : 0);
    }, 0);
  const sumMonto = <T extends { monto?: unknown }>(arr: T[]) =>
    arr.reduce((acc, x) => {
      const v = Number(x.monto);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0);
  const sumMontoEmisionCohort = (arr: FacturaRaw[]) =>
    arr.reduce((acc, x) => {
      const v = Number(x.monto);
      return acc + (Number.isFinite(v) ? v : 0);
    }, 0);

  /**
   * Cohorte fiscal = facturas (fecha emisión en [desde,hasta], no anuladas; mismo filtro de período que abajo).
   * • facturadoCohort: Σ monto = obligación de cobro al emitir.
   * • carteraPendiente: Σ saldo = cartera viva aún a cobrar (misma unidad, ya netea NC/pagos a esas facturas en BD).
   * • recaudadoCohort = facturado − cartera; cumple: facturado = recaudado + pendiente, % = recaudado / facturado.
   *   No mezclar con “caja en el rango” (KPI Cobrado por día / registro de pagos), que puede afectar otras facturas.
   */
  const facturadoCohortPeriodo = sumMontoEmisionCohort(facturasPeriodo);
  const carteraPendienteCohort = sumSaldoPendiente(facturasPeriodo);
  const recaudadoCohortPeriodo = Math.max(0, facturadoCohortPeriodo - carteraPendienteCohort);
  const pctCobranzaCohort =
    facturadoCohortPeriodo > 0 ? (recaudadoCohortPeriodo / facturadoCohortPeriodo) * 100 : null;

  /** Suma de pagos registrados por factura (todas las fechas; para imputar contado sin filas en `pagos`). */
  const montoPagadoPorFacturaId = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pagos) {
      const fid = String(p.factura_id ?? "");
      if (!fid) continue;
      const v = Number(p.monto);
      m.set(fid, (m.get(fid) ?? 0) + (Number.isFinite(v) ? v : 0));
    }
    return m;
  }, [pagos]);

  const facturaEstadoById = useMemo(
    () => Object.fromEntries(facturas.map((f) => [String(f.id), f.estado])),
    [facturas]
  );

  /** Pagos con fecha en el período cuya factura no está anulada. */
  const pagosPeriodo = useMemo(
    () =>
      pagos.filter((p) => {
        if (!enRango(p.fecha_pago, desde, hasta)) return false;
        const est = facturaEstadoById[String(p.factura_id)];
        return !esFacturaAnulada(est);
      }),
    [pagos, desde, hasta, facturaEstadoById]
  );

  /** Cobrado del período = solo pagos registrados (fecha de pago en rango; factura no anulada). */
  const cobradoRegistradoPeriodo = sumMonto(pagosPeriodo);

  /**
   * Facturas al contado emitidas en el período sin filas en `pagos`: cobro contable/operativo implícito al emitir.
   * Métrica separada de “Cobrado del período” (módulo Pagos / tabla pagos).
   */
  const cobroImplicitoContadoPeriodo = useMemo(() => {
    let s = 0;
    for (const f of facturasPeriodo) {
      if ((f.tipo ?? "").toLowerCase() !== "contado") continue;
      if (esFacturaAnulada(f.estado)) continue;
      if (esFacturaCorregidaNc(f.estado)) continue;
      const fid = String(f.id);
      const yaRegistrado = (montoPagadoPorFacturaId.get(fid) ?? 0) > 0;
      if (yaRegistrado) continue;
      const m = Number(f.monto);
      if (Number.isFinite(m) && m > 0) s += m;
    }
    return s;
  }, [facturasPeriodo, montoPagadoPorFacturaId]);

  /** Serie diaria solo con pagos registrados; días sin movimiento en 0 (continuidad del gráfico). */
  const cobradoPorDiaSerie = useMemo(() => {
    const porDia = new Map<string, { monto: number; count: number }>();
    for (const p of pagosPeriodo) {
      const d = toCalendarDateStr(p.fecha_pago);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const v = Number(p.monto);
      const addM = Number.isFinite(v) ? v : 0;
      const cur = porDia.get(d) ?? { monto: 0, count: 0 };
      cur.monto += addM;
      cur.count += 1;
      porDia.set(d, cur);
    }
    const dias = listarDiasCalendarioYmd(desde, hasta);
    return dias.map((fecha) => {
      const cell = porDia.get(fecha) ?? { monto: 0, count: 0 };
      return {
        fecha,
        monto: cell.monto,
        count: cell.count,
        labelCorta: fecha.slice(8, 10) + "/" + fecha.slice(5, 7),
      };
    });
  }, [pagosPeriodo, desde, hasta]);

  const composicionModalidad = useMemo(
    () => composicionFacturacionPorModalidad(facturasPeriodo),
    [facturasPeriodo]
  );

  /** Prioridad: tipo de servicio → condición de pago → origen */
  const { dimCliente, segmentosClientes } = useMemo(() => {
    const list = clientes;
    const hasServicio = list.some((c) => (c.tipo_servicio_cliente ?? "").trim() !== "");
    const hasCondicion = list.some((c) => (c.condicion_pago ?? "").trim() !== "");
    const dim: "tipo_servicio" | "condicion" | "origen" = hasServicio
      ? "tipo_servicio"
      : hasCondicion
        ? "condicion"
        : "origen";
    const map = new Map<string, number>();
    for (const c of list) {
      let raw = "";
      if (dim === "tipo_servicio") raw = (c.tipo_servicio_cliente ?? "").trim();
      else if (dim === "condicion") raw = (c.condicion_pago ?? "").trim();
      else raw = (c.origen ?? "").trim();
      const key = raw || "__sin__";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    const PALETTE = ["#4FAEB2", "#5FBFC3", "#7DCFD2", "#22C55E", "#A78BFA", "#F59E0B", "#EC4899", "#38BDF8"];
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
    return {
      dimCliente: dim,
      segmentosClientes: entries.map(([k, count], i) => ({
        label:
          k === "__sin__"
            ? "Sin clasificar"
            : dim === "tipo_servicio"
              ? etiquetaVisibleTipoServicio(k, mapNombreTipoServicio)
              : labelClienteDimension(k),
        value: count,
        color: PALETTE[i % PALETTE.length],
      })),
    };
  }, [clientes, mapNombreTipoServicio]);

  /**
   * Deuda por `tipo_servicio_cliente` (catálogo): facturas de la coorte (emisión en rango) con saldo > 0
   * saldo de factura (cartera viva), asignada al segmento del cliente; Sin clasificar si no hay.
   */
  const deudaPorTipoServicio = useMemo(() => {
    const m = new Map<string, number>();
    const byCliente = new Map<string, string>();
    for (const c of clientes) {
      const raw = (c.tipo_servicio_cliente ?? "").trim();
      byCliente.set(String(c.id), raw ? raw.toLowerCase() : "__sin__");
    }
    for (const f of facturasPeriodo) {
      if (esFacturaAnulada(f.estado)) continue;
      const s = Number(f.saldo);
      if (!Number.isFinite(s) || s <= 0) continue;
      const slug = byCliente.get(String(f.cliente_id)) ?? "__sin__";
      m.set(slug, (m.get(slug) ?? 0) + s);
    }
    const pal = ["#4FAEB2", "#5FBFC3", "#7DCFD2", "#22C55E", "#A78BFA", "#F59E0B", "#EC4899", "#38BDF8"];
    const list = [...m.entries()]
      .map(([k, v]) => ({
        key: k,
        value: v,
        label: k === "__sin__" ? "Sin clasificar" : etiquetaVisibleTipoServicio(k, mapNombreTipoServicio),
      }))
      .sort((a, b) => b.value - a.value)
      .map((row, i) => ({ ...row, color: pal[i % pal.length] }));
    return {
      list,
      total: list.reduce((a, b) => a + b.value, 0),
    };
  }, [clientes, facturasPeriodo, mapNombreTipoServicio]);

  const facturaById = useMemo(
    () => new Map(facturas.map((f) => [String(f.id), f] as const)),
    [facturas]
  );

  /**
   * Suma monto de `pagos` con `fecha_pago` en [desde,hasta] (mismo conjunto que “Cobrado por día”;
   * excluye factura anulada) agrupada por el tipo de servicio del **cliente** (slug → catálogo).
   */
  const cobradoPorTipoServicio = useMemo(() => {
    const m = new Map<string, number>();
    const byCliente = new Map<string, string>();
    for (const c of clientes) {
      const raw = (c.tipo_servicio_cliente ?? "").trim();
      byCliente.set(String(c.id), raw ? raw.toLowerCase() : "__sin__");
    }
    for (const p of pagosPeriodo) {
      const factura = facturaById.get(String(p.factura_id));
      if (!factura) continue;
      const pagoMonto = Number(p.monto);
      if (!Number.isFinite(pagoMonto) || pagoMonto <= 0) continue;
      const slug = byCliente.get(String(factura.cliente_id)) ?? "__sin__";
      m.set(slug, (m.get(slug) ?? 0) + pagoMonto);
    }
    const pal = ["#4FAEB2", "#5FBFC3", "#7DCFD2", "#22C55E", "#A78BFA", "#F59E0B", "#EC4899", "#38BDF8"];
    const list = [...m.entries()]
      .map(([k, v]) => ({
        key: k,
        value: v,
        label: k === "__sin__" ? "Sin clasificar" : etiquetaVisibleTipoServicio(k, mapNombreTipoServicio),
      }))
      .sort((a, b) => b.value - a.value)
      .map((row, i) => ({ ...row, color: pal[i % pal.length] }));
    return {
      list,
      total: list.reduce((a, b) => a + b.value, 0),
    };
  }, [clientes, pagosPeriodo, facturaById, mapNombreTipoServicio]);

  const deudaMaxTipo = deudaPorTipoServicio.list.length
    ? Math.max(...deudaPorTipoServicio.list.map((r) => r.value), 0)
    : 1;

  const cobradoMaxTipo = cobradoPorTipoServicio.list.length
    ? Math.max(...cobradoPorTipoServicio.list.map((r) => r.value), 0)
    : 1;

  const finCard =
    "min-w-0 overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white p-6 shadow-sm shadow-slate-200/50 transition-shadow hover:shadow-md sm:p-7";
  /** Caja de consulta (inline-size) para `cqi`; alinea al fondo y estira con la card. */
  const finKpiValueWrap =
    "flex min-h-0 w-full min-w-0 flex-1 [container-type:inline-size] items-end";
  const finAccent = "#4FAEB2";

  const finKpiBase =
    "group relative flex h-full min-h-[10rem] flex-col overflow-hidden rounded-2xl p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:p-6";
  const finKpiLabel =
    "text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500";
  const finKpiSub = "text-[11px] text-slate-500";

  // Gauge data
  const pctCobranzaSafe = pctCobranzaCohort ?? 0;
  const gaugePct = Math.max(0, Math.min(100, pctCobranzaSafe));
  const gaugeRadius = 30;
  const gaugeCirc = 2 * Math.PI * gaugeRadius;
  const gaugeOffset = gaugeCirc - (gaugePct / 100) * gaugeCirc;
  const gaugeColor =
    pctCobranzaCohort == null
      ? "#CBD5E1"
      : gaugePct >= 80
        ? "#10B981"
        : gaugePct >= 50
          ? finAccent
          : gaugePct >= 25
            ? "#F59E0B"
            : "#EF4444";

  return (
    <div className="space-y-6 rounded-2xl border border-[#4FAEB2]/45 bg-gradient-to-b from-slate-50 to-white p-4 sm:space-y-8 sm:p-6 md:p-8">
      <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:gap-5">
        {/* Facturado */}
        <motion.div
          whileHover={{ y: -2 }}
          className={`${finKpiBase} border border-[#4FAEB2]/45 bg-white`}
        >
          <div className="flex items-start justify-between gap-2">
            <p className={finKpiLabel}>Facturado del período</p>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-500">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
                <path d="M8 13h8M8 17h6" />
              </svg>
            </span>
          </div>
          <div className={`mt-auto ${finKpiValueWrap}`}>
            <FinMontoGs kpi monto={facturadoCohortPeriodo} className="text-slate-900" />
          </div>
          <p className={`mt-1 ${finKpiSub}`}>Total emitido</p>
        </motion.div>

        {/* Cobrado — card destacada */}
        <motion.div
          whileHover={{ y: -2 }}
          className={`${finKpiBase} border border-[#4FAEB2]/60 bg-gradient-to-br from-white via-white to-[#4FAEB2]/12 shadow-[0_4px_20px_rgba(79,174,178,0.10)]`}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-[#4FAEB2] via-[#4FAEB2]/70 to-[#4FAEB2]/30"
          />
          <div className="flex items-start justify-between gap-2">
            <p className={finKpiLabel}>Cobrado del período</p>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#4FAEB2]/30 bg-[#4FAEB2]/12 text-[#4FAEB2]">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <path d="m9 11 3 3L22 4" />
              </svg>
            </span>
          </div>
          <div className={`mt-auto ${finKpiValueWrap}`}>
            <FinMontoGs kpi monto={recaudadoCohortPeriodo} className="text-[#3F8E91]" />
          </div>
          <p className={`mt-1 ${finKpiSub}`}>
            <span className="font-medium text-[#3F8E91]">
              {facturadoCohortPeriodo > 0
                ? `${((recaudadoCohortPeriodo / facturadoCohortPeriodo) * 100).toFixed(0)}%`
                : "—"}
            </span>{" "}
            de lo facturado
          </p>
        </motion.div>

        {/* Pendiente */}
        <motion.div
          whileHover={{ y: -2 }}
          className={`${finKpiBase} border border-amber-200 bg-gradient-to-br from-white via-white to-amber-50/40`}
        >
          <div className="flex items-start justify-between gap-2">
            <p className={finKpiLabel}>Pendiente del período</p>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-200 bg-amber-50 text-amber-600">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </span>
          </div>
          <div className={`mt-auto ${finKpiValueWrap}`}>
            <FinMontoGs
              kpi
              monto={carteraPendienteCohort}
              negativo={carteraPendienteCohort < 0}
              className={
                carteraPendienteCohort > 0
                  ? "text-amber-600"
                  : carteraPendienteCohort < 0
                    ? "text-emerald-600"
                    : "text-slate-900"
              }
            />
          </div>
          <p className={`mt-1 ${finKpiSub}`}>Por cobrar</p>
        </motion.div>

        {/* % de cobranza — con gauge */}
        <motion.div
          whileHover={{ y: -2 }}
          className={`${finKpiBase} border border-[#4FAEB2]/45 bg-white`}
        >
          <div className="flex items-start justify-between gap-2">
            <p className={finKpiLabel}>% de cobranza</p>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-500">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <line x1="19" y1="5" x2="5" y2="19" />
                <circle cx="6.5" cy="6.5" r="2.5" />
                <circle cx="17.5" cy="17.5" r="2.5" />
              </svg>
            </span>
          </div>
          <div className="mt-auto flex items-center gap-4">
            <div className="relative h-[72px] w-[72px] shrink-0">
              <svg viewBox="0 0 72 72" className="h-full w-full -rotate-90">
                <circle cx="36" cy="36" r={gaugeRadius} fill="none" stroke="#E2E8F0" strokeWidth="7" />
                <circle
                  cx="36"
                  cy="36"
                  r={gaugeRadius}
                  fill="none"
                  stroke={gaugeColor}
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={gaugeCirc}
                  strokeDashoffset={gaugeOffset}
                  style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.3s ease" }}
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-base font-bold tabular-nums text-slate-900">
                  {pctCobranzaCohort == null ? "—" : `${Math.round(gaugePct)}%`}
                </span>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-slate-600">
                {pctCobranzaCohort == null
                  ? "Sin datos"
                  : gaugePct >= 80
                    ? "Excelente"
                    : gaugePct >= 50
                      ? "Buena"
                      : gaugePct >= 25
                        ? "A mejorar"
                        : "Crítica"}
              </p>
              <p className={`mt-0.5 ${finKpiSub}`}>cobrado / facturado</p>
            </div>
          </div>
        </motion.div>
      </div>

      <div className={finCard}>
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
              <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
                Cobrado por día
              </h3>
            </div>
            <p className="mt-1 pl-3 text-[11px] text-slate-500">Pagos registrados por fecha de pago</p>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 sm:items-end sm:text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Total cobrado</p>
            <FinMontoGs monto={cobradoRegistradoPeriodo} dense className="text-[#3F8E91]" />
          </div>
        </div>
        {cobradoPorDiaSerie.length === 0 ? (
          <p className="mt-6 text-sm text-slate-500">Sin rango de fechas válido.</p>
        ) : (
          <div className="mt-5 h-[300px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cobradoPorDiaSerie} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="fecha"
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: "#cbd5e1" }}
                  tickFormatter={(ymd: string) => {
                    if (!ymd || ymd.length < 10) return ymd;
                    return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
                  }}
                  minTickGap={28}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: "#cbd5e1" }}
                  tickFormatter={(v: number) => formatGsM(Number(v))}
                  width={52}
                />
                <Tooltip
                  cursor={{ stroke: "rgba(79,174,178,0.25)", strokeWidth: 1 }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload as {
                      fecha: string;
                      monto: number;
                      count: number;
                    };
                    return (
                      <div className="rounded-lg border border-[#4FAEB2]/45 bg-white px-3 py-2 text-xs text-slate-800 shadow-lg">
                        <p className="font-medium text-slate-500">{formatFecha(row.fecha)}</p>
                        <p className="mt-1.5 text-sm font-semibold tabular-nums text-slate-900">
                          Gs. {formatGs(row.monto)}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {row.count} pago{row.count === 1 ? "" : "s"}
                        </p>
                      </div>
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="monto"
                  stroke={finAccent}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, fill: finAccent, stroke: "#fff", strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className={finCard}>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
          <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
            Composición del período
          </h3>
        </div>
        <p className="mt-1 pl-3 text-[11px] text-slate-500">Facturación emitida por tipo de factura</p>
        <div className="mt-5 flex h-4 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/70">
          {composicionModalidad.total > 0 ? (
            <>
              <div
                className="h-full bg-[#4FAEB2] transition-[width] duration-300"
                style={{ width: `${composicionModalidad.pctContado}%`, minWidth: composicionModalidad.contado > 0 ? 4 : 0 }}
                title={`Contado ${composicionModalidad.pctContado.toFixed(1)}%`}
              />
              <div
                className="h-full bg-slate-500 transition-[width] duration-300"
                style={{ width: `${composicionModalidad.pctMensual}%`, minWidth: composicionModalidad.mensual > 0 ? 4 : 0 }}
                title={`Mensual / suscripción ${composicionModalidad.pctMensual.toFixed(1)}%`}
              />
            </>
          ) : null}
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-100 bg-slate-50/90 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Contado</p>
            <FinMontoGs monto={composicionModalidad.contado} dense className="text-slate-900" />
            <p className="mt-1 text-sm font-semibold tabular-nums text-slate-500">
              {composicionModalidad.total > 0 ? `${composicionModalidad.pctContado.toFixed(1)}%` : "—"}
            </p>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50/90 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Mensual / suscripción</p>
            <FinMontoGs monto={composicionModalidad.mensual} dense className="text-slate-900" />
            <p className="mt-1 text-sm font-semibold tabular-nums text-slate-500">
              {composicionModalidad.total > 0 ? `${composicionModalidad.pctMensual.toFixed(1)}%` : "—"}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-1 border-t border-slate-100 pt-4 sm:flex-row sm:items-baseline sm:justify-between">
          <span className="text-xs font-semibold text-slate-500">Total emitido</span>
          <div className="min-w-0 sm:text-right">
            <FinMontoGs monto={composicionModalidad.total} dense className="text-slate-900" />
          </div>
        </div>
        <p className="mt-3 text-[10px] leading-snug text-slate-400">
          Emisión en el período, sin anuladas · contado vs resto por tipo · sin pagos ni doble conteo.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <div className={finCard}>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
            <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Deuda por tipo de cliente
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">
            Σ <span className="font-medium text-slate-600">saldo</span> de facturas emitidas en el rango, por{" "}
            <span className="font-medium text-slate-600">clientes.tipo_servicio_cliente</span> (nombre desde catálogo
            CRM).
          </p>
          {deudaPorTipoServicio.list.length === 0 ? (
            <p className="mt-6 text-sm text-slate-500">No hay deuda pendiente (saldo &gt; 0) en el período o sin segmentos con saldo.</p>
          ) : (
            <div className="mt-6 space-y-4">
              {deudaPorTipoServicio.list.map((row) => (
                <div key={row.key}>
                  <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words font-medium text-slate-700" title={row.label}>
                      <span
                        className="mr-2 inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                      />
                      {row.label}
                    </span>
                    <span className="shrink-0 text-right text-sm font-bold tabular-nums text-slate-900">
                      Gs. {formatGs(row.value)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full min-w-0 rounded-full"
                      style={{
                        width: `${deudaMaxTipo > 0 ? (row.value / deudaMaxTipo) * 100 : 0}%`,
                        backgroundColor: row.color,
                      }}
                      title={row.label}
                    />
                  </div>
                </div>
              ))}
              <div className="flex min-w-0 items-baseline justify-between gap-2 border-t border-slate-100 pt-4 text-sm">
                <span className="font-semibold text-slate-600">Total deuda (vista)</span>
                <span className="shrink-0 text-right text-base font-bold tabular-nums text-slate-900">
                  Gs. {formatGs(deudaPorTipoServicio.total)}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className={finCard}>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
            <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Cobrado por tipo de cliente
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">
            Σ <span className="font-medium text-slate-600">monto de pagos</span> con fecha de pago en el rango (misma
            lógica que <span className="font-medium text-slate-600">Cobrado por día</span> / factura no anulada),
            asignado al <span className="font-medium text-slate-600">cliente</span> vía{" "}
            <span className="font-medium text-slate-600">tipo_servicio_cliente</span> (nombre catálogo CRM). No
            incluye contado sin fila de pago.
          </p>
          {cobradoPorTipoServicio.list.length === 0 ? (
            <p className="mt-6 text-sm text-slate-500">No hay pagos en el período con factura vinculada a cliente.</p>
          ) : (
            <div className="mt-6 space-y-4">
              {cobradoPorTipoServicio.list.map((row) => (
                <div key={row.key}>
                  <div className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words font-medium text-slate-700" title={row.label}>
                      <span
                        className="mr-2 inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color }}
                      />
                      {row.label}
                    </span>
                    <span className="shrink-0 text-right text-sm font-bold tabular-nums text-slate-900">
                      Gs. {formatGs(row.value)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full min-w-0 rounded-full"
                      style={{
                        width: `${cobradoMaxTipo > 0 ? (row.value / cobradoMaxTipo) * 100 : 0}%`,
                        backgroundColor: row.color,
                      }}
                      title={row.label}
                    />
                  </div>
                </div>
              ))}
              <div className="flex min-w-0 items-baseline justify-between gap-2 border-t border-slate-100 pt-4 text-sm">
                <span className="font-semibold text-slate-600">Total cobrado (vista)</span>
                <span className="shrink-0 text-right text-base font-bold tabular-nums text-slate-900">
                  Gs. {formatGs(cobradoPorTipoServicio.total)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5 lg:gap-8">
        <motion.div whileHover={{ y: -2 }} className={`${finCard} lg:col-span-3`}>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
            <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Progreso de metas
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">Avance del mes calendario vs. objetivos configurados</p>
          <div className="mt-6 grid grid-cols-1 gap-8 sm:grid-cols-2">
            <ProgressBar
              variant="light"
              label="Facturación mensual"
              value={facturasValidas
                .filter((f) => enMesCalendarioActual(toCalendarDateStr(f.fecha)))
                .reduce((s, f) => {
                  const t = Number(f.monto);
                  return s + (Number.isFinite(t) ? t : 0);
                }, 0)}
              meta={config.meta_facturacion_mensual}
              format="gs"
            />
            <ProgressBar
              variant="light"
              label="Ventas mensuales"
              value={ventas
                .filter((v) => enMesCalendarioActual(toCalendarDateStr(v.fecha)))
                .reduce((s, v) => {
                  const t = Number(v.total);
                  return s + (Number.isFinite(t) ? t : 0);
                }, 0)}
              meta={config.meta_ventas_mensuales}
              format="gs"
            />
          </div>
        </motion.div>
        <motion.div whileHover={{ y: -2 }} className={`${finCard} lg:col-span-2`}>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
            <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Distribución de clientes
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">
            Por{" "}
            {dimCliente === "tipo_servicio"
              ? "tipo de servicio"
              : dimCliente === "condicion"
                ? "condición de pago"
                : "origen"}
            .
          </p>
          <div className="mt-6">
            <DonutChart
              variant="light"
              legendDetail
              segments={segmentosClientes}
              centerLabel="clientes"
              formatValue={(v) => String(v)}
            />
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ── Dashboard Inventario ─────────────────────────────────────────────────────

function DashInventario({
  productos,
  compras,
}: {
  productos: ProductoRaw[];
  compras:   CompraRaw[];
}) {
  const totalProductos = productos.length;
  const totalUnidades  = productos.reduce((s, p) => s + p.stock_actual, 0);
  const bajosStock     = productos.filter(p => p.stock_actual <= p.stock_minimo).length;
  const valorTotal     = productos.reduce((s, p) => s + p.stock_actual * p.costo_promedio, 0);

  const cntSaludable = productos.filter(p => p.stock_actual > p.stock_minimo).length;
  const cntBajo      = productos.filter(p => p.stock_actual > 0 && p.stock_actual <= p.stock_minimo).length;
  const cntCritico   = productos.filter(p => p.stock_actual <= 0).length;

  const proveedorMap = useMemo(() => {
    const map: Record<string, string> = {};
    compras.forEach(c => { if (c.producto_id) map[String(c.producto_id)] = c.proveedor_nombre; });
    return map;
  }, [compras]);

  const criticos = useMemo(() =>
    productos
      .filter(p => p.stock_actual <= p.stock_minimo)
      .sort((a, b) => a.stock_actual - b.stock_actual)
      .slice(0, 10),
    [productos]
  );

  const topPorValor = useMemo(() =>
    [...productos]
      .map(p => ({ ...p, valor: p.stock_actual * p.costo_promedio }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 8),
    [productos]
  );

  const invPanel =
    "rounded-2xl border border-[#4FAEB2]/45 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:shadow-md";
  const invTitle =
    "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600";
  const invBar = (
    <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
  );

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={<Icon.Box className="h-4 w-4" />}
          label="Productos totales"
          value={String(totalProductos)}
          color="text-slate-900"
          variation={4}
        />
        <KpiCard
          icon={<Icon.Hash className="h-4 w-4" />}
          label="Stock total (unidades)"
          value={formatGs(totalUnidades)}
          color="text-slate-900"
        />
        <KpiCard
          icon={<Icon.Alert className="h-4 w-4" />}
          label="Bajo stock mínimo"
          value={String(bajosStock)}
          sub={bajosStock > 0 ? "Requieren reposición" : "Todo en orden"}
          color={bajosStock > 0 ? "text-rose-600" : "text-emerald-600"}
          accent={bajosStock > 0 ? "danger" : "neutral"}
          variation={bajosStock > 0 ? -2 : undefined}
        />
        <KpiCard
          icon={<Icon.Diamond className="h-4 w-4" />}
          label="Valor del inventario"
          value={`Gs. ${formatGsFull(valorTotal)}`}
          color="text-[#3F8E91]"
          accent="featured"
          variation={12}
        />
      </div>

      {/* Donut + Críticos */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <motion.div whileHover={{ y: -2 }} className={invPanel}>
          <div className="flex items-center gap-2">
            {invBar}
            <h3 className={invTitle}>
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Estado del stock
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">Distribución por nivel</p>
          <div className="mt-5">
            <DonutChart
              segments={[
                { label: "Saludable", value: cntSaludable, color: "#10B981" },
                { label: "Bajo", value: cntBajo, color: "#F59E0B" },
                { label: "Crítico", value: cntCritico, color: "#EF4444" },
              ]}
              centerLabel="productos"
              legendDetail
            />
          </div>
        </motion.div>

        <motion.div whileHover={{ y: -2 }} className={`${invPanel} lg:col-span-2`}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {invBar}
              <h3 className={invTitle}>
                <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
                Productos críticos
              </h3>
            </div>
            {criticos.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700">
                {criticos.length} {criticos.length === 1 ? "ítem" : "ítems"}
              </span>
            ) : null}
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">Stock por debajo del mínimo</p>

          {criticos.length === 0 ? (
            <div className="mt-5 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-sm text-emerald-700">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                <Icon.CheckCircle className="h-4 w-4" />
              </span>
              <span className="font-medium">Todos los productos tienen stock suficiente.</span>
            </div>
          ) : (
            <div className="mt-5 overflow-hidden rounded-xl border border-[#4FAEB2]/30">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50/80">
                    <tr>
                      {["Producto", "Stock actual", "Mínimo", "Estado", "Proveedor"].map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {criticos.map((p) => {
                      const critico = p.stock_actual <= 0;
                      return (
                        <tr key={p.id} className="transition-colors hover:bg-[#4FAEB2]/5">
                          <td className="px-3 py-3 text-xs font-medium text-slate-800">{p.nombre}</td>
                          <td className="px-3 py-3">
                            <span
                              className={`text-xs font-semibold tabular-nums ${
                                critico ? "text-rose-600" : "text-amber-600"
                              }`}
                            >
                              {p.stock_actual} {p.unidad_medida}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-xs tabular-nums text-slate-500">
                            {p.stock_minimo} {p.unidad_medida}
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                                critico
                                  ? "border-rose-200 bg-rose-50 text-rose-700"
                                  : "border-amber-200 bg-amber-50 text-amber-700"
                              }`}
                            >
                              <span
                                aria-hidden="true"
                                className={`h-1.5 w-1.5 rounded-full ${critico ? "bg-rose-500" : "bg-amber-500"}`}
                              />
                              {critico ? "Crítico" : "Bajo"}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-xs text-slate-500">
                            {proveedorMap[String(p.id)] ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      {/* Top por valor */}
      <motion.div whileHover={{ y: -2 }} className={invPanel}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {invBar}
            <h3 className={invTitle}>
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Top productos por valor de inventario
            </h3>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-[#4FAEB2]/30 bg-[#4FAEB2]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[#3F8E91]">
            Top {topPorValor.length}
          </span>
        </div>
        <p className="mt-1 pl-3 text-[11px] text-slate-500">Stock × costo promedio</p>

        {topPorValor.length === 0 ? (
          <p className="mt-5 py-6 text-center text-sm text-slate-400">Sin productos registrados.</p>
        ) : (
          <div className="mt-5 overflow-hidden rounded-xl border border-[#4FAEB2]/30">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50/80">
                  <tr>
                    {["Producto", "SKU", "Stock", "Costo promedio", "Valor inventario"].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {topPorValor.map((p) => (
                    <tr key={p.id} className="transition-colors hover:bg-[#4FAEB2]/5">
                      <td className="px-3 py-3 text-xs font-medium text-slate-800">{p.nombre}</td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-500">{p.sku}</td>
                      <td className="px-3 py-3 text-xs tabular-nums text-slate-700">{p.stock_actual}</td>
                      <td className="px-3 py-3 text-xs tabular-nums text-slate-500">
                        Gs. {formatGs(p.costo_promedio)}
                      </td>
                      <td className="px-3 py-3 text-xs font-semibold tabular-nums text-[#3F8E91]">
                        Gs. {formatGs(p.valor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// ── Dashboard Ventas ──────────────────────────────────────────────────────────

function DashVentas({
  ventas,
  productos,
  periodo,
}: {
  ventas:    VentaRaw[];
  productos: ProductoRaw[];
  periodo:   Periodo;
}) {
  const { desde, hasta } = useMemo(() => getRango(periodo), [periodo]);

  const ventasFilt = useMemo(() =>
    ventas.filter(v => enRango(v.fecha, desde, hasta)),
    [ventas, desde, hasta]
  );

  const ventasHoy = useMemo(() => {
    const { desde: d, hasta: h } = getRango("hoy");
    return ventas.filter(v => enRango(v.fecha, d, h));
  }, [ventas]);

  const ventasMes = useMemo(() => {
    const { desde: d, hasta: h } = getRango("mes");
    return ventas.filter(v => enRango(v.fecha, d, h));
  }, [ventas]);

  const totalHoy   = ventasHoy.reduce((s, v) => s + v.total, 0);
  const totalMes   = ventasMes.reduce((s, v) => s + v.total, 0);
  const ticketProm = ventasFilt.length > 0 ? ventasFilt.reduce((s, v) => s + v.total, 0) / ventasFilt.length : 0;
  const unidades   = ventasFilt.flatMap(v => v.lineas ?? []).reduce((s, l) => s + (l?.cantidad ?? 0), 0);

  const prodMap = useMemo(() =>
    Object.fromEntries(productos.map(p => [p.id, p])),
    [productos]
  );

  const gananciaHoy = useMemo(() =>
    ventasHoy.flatMap(v => v.lineas ?? []).reduce((s, l) => {
      if (!l) return s;
      const costo = prodMap[l.producto_id]?.costo_promedio ?? 0;
      return s + (l.precio_venta - costo) * l.cantidad;
    }, 0),
    [ventasHoy, prodMap]
  );

  const totalHoyBruto = ventasHoy.flatMap(v => v.lineas ?? [])
    .reduce((s, l) => s + (l ? l.precio_venta * l.cantidad : 0), 0);

  const margenProm = totalHoyBruto > 0 ? (gananciaHoy / totalHoyBruto) * 100 : 0;

  const topProductos = useMemo(() => {
    const map: Record<string, number> = {};
    ventasFilt.flatMap(v => v.lineas ?? []).filter(Boolean).forEach(l => {
      map[l.producto_nombre] = (map[l.producto_nombre] ?? 0) + l.cantidad;
    });
    return Object.entries(map)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [ventasFilt]);

  const ventasPorHora = useMemo(() => {
    const horas = Array.from({ length: 24 }, (_, h) => ({
      label: `${String(h).padStart(2, "0")}h`,
      value: 0,
    }));
    ventasHoy.forEach(v => {
      const h = new Date(v.fecha).getHours();
      if (h >= 0 && h < 24) horas[h].value += v.total;
    });
    const ahora = new Date().getHours();
    return horas.slice(0, ahora + 1);
  }, [ventasHoy]);

  const desglose = useMemo(() => {
    const tipos = ["CONTADO", "CREDITO"] as const;
    return tipos.map(tipo => {
      const lst = ventasFilt.filter(v => v.tipo_venta === tipo);
      const total = lst.reduce((s, v) => s + v.total, 0);
      const unid  = lst.flatMap(v => v.lineas ?? []).reduce((s, l) => s + (l?.cantidad ?? 0), 0);
      return { tipo, ventas: lst.length, total, ticket: lst.length ? total / lst.length : 0, unid };
    });
  }, [ventasFilt]);

  const vtaPanel =
    "rounded-2xl border border-[#4FAEB2]/45 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:shadow-md";
  const vtaTitle =
    "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600";
  const vtaBar = (
    <span aria-hidden="true" className="block h-5 w-1 rounded-full bg-[#4FAEB2]" />
  );

  return (
    <div className="space-y-6">
      {/* KPIs principales */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={<Icon.Calendar className="h-4 w-4" />}
          label="Ventas del día"
          value={`Gs. ${formatGsFull(totalHoy)}`}
          sub={`${ventasHoy.length} transacciones`}
          color="text-slate-900"
        />
        <KpiCard
          icon={<Icon.Calendar className="h-4 w-4" />}
          label="Ventas del mes"
          value={`Gs. ${formatGsFull(totalMes)}`}
          sub={`${ventasMes.length} transacciones`}
          color="text-[#3F8E91]"
          accent="featured"
        />
        <KpiCard
          icon={<Icon.Ticket className="h-4 w-4" />}
          label="Ticket promedio"
          value={`Gs. ${formatGsFull(ticketProm)}`}
          sub={`Periodo: ${periodo}`}
          color="text-slate-900"
        />
        <KpiCard
          icon={<Icon.Box className="h-4 w-4" />}
          label="Unidades vendidas"
          value={formatGs(unidades)}
          sub="En el periodo"
          color="text-slate-900"
        />
      </div>

      {/* KPIs rentabilidad */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <motion.div whileHover={{ y: -2 }} className={vtaPanel}>
          <div className="flex items-start justify-between gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
                gananciaHoy >= 0
                  ? "border-emerald-200 bg-emerald-50 text-emerald-600"
                  : "border-rose-200 bg-rose-50 text-rose-600"
              }`}
            >
              <Icon.Wallet className="h-4 w-4" />
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                gananciaHoy >= 0
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-rose-200 bg-rose-50 text-rose-700"
              }`}
            >
              {gananciaHoy >= 0 ? "Positivo" : "Negativo"}
            </span>
          </div>
          <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            Ganancia del día
          </p>
          <p
            className={`mt-1 text-3xl font-semibold tabular-nums tracking-tight ${
              gananciaHoy >= 0 ? "text-emerald-600" : "text-rose-600"
            }`}
          >
            Gs. {formatGsFull(gananciaHoy)}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">precio venta − costo promedio × cant.</p>
        </motion.div>

        <motion.div whileHover={{ y: -2 }} className={vtaPanel}>
          <div className="flex items-start justify-between gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
                margenProm >= 20
                  ? "border-emerald-200 bg-emerald-50 text-emerald-600"
                  : margenProm >= 10
                    ? "border-amber-200 bg-amber-50 text-amber-600"
                    : "border-rose-200 bg-rose-50 text-rose-600"
              }`}
            >
              <Icon.TrendUp className="h-4 w-4" />
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                margenProm >= 20
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : margenProm >= 10
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-rose-200 bg-rose-50 text-rose-700"
              }`}
            >
              {margenProm >= 20 ? "Excelente" : margenProm >= 10 ? "Aceptable" : "Bajo"}
            </span>
          </div>
          <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            Margen promedio (hoy)
          </p>
          <p
            className={`mt-1 text-3xl font-semibold tabular-nums tracking-tight ${
              margenProm >= 20 ? "text-emerald-600" : margenProm >= 10 ? "text-amber-600" : "text-rose-600"
            }`}
          >
            {margenProm.toFixed(1)}%
          </p>
          <p className="mt-1 text-[11px] text-slate-500">ganancia / precio venta</p>
        </motion.div>
      </div>

      {/* Productos más vendidos + Ventas por hora */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <motion.div whileHover={{ y: -2 }} className={vtaPanel}>
          <div className="flex items-center gap-2">
            {vtaBar}
            <h3 className={vtaTitle}>
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Productos más vendidos
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">Ranking de unidades</p>
          <div className="mt-5">
            {topProductos.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">Sin ventas en el periodo.</p>
            ) : (
              <HBarChart data={topProductos} color="bg-[#4FAEB2]" />
            )}
          </div>
        </motion.div>

        <motion.div whileHover={{ y: -2 }} className={vtaPanel}>
          <div className="flex items-center gap-2">
            {vtaBar}
            <h3 className={vtaTitle}>
              <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
              Ventas por hora — hoy
            </h3>
          </div>
          <p className="mt-1 pl-3 text-[11px] text-slate-500">Curva intradía acumulada</p>
          <div className="mt-5">
            {ventasPorHora.every((h) => h.value === 0) ? (
              <p className="py-8 text-center text-sm text-slate-400">Sin ventas registradas hoy.</p>
            ) : (
              <AreaChart data={ventasPorHora} color="#4FAEB2" />
            )}
          </div>
        </motion.div>
      </div>

      {/* Desglose por tipo */}
      <motion.div whileHover={{ y: -2 }} className={vtaPanel}>
        <div className="flex items-center gap-2">
          {vtaBar}
          <h3 className={vtaTitle}>
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
            Desglose por tipo de venta
          </h3>
        </div>
        <p className="mt-1 pl-3 text-[11px] text-slate-500">Contado vs. crédito en el período</p>

        {ventasFilt.length === 0 ? (
          <p className="mt-6 py-6 text-center text-sm text-slate-400">Sin ventas en el periodo seleccionado.</p>
        ) : (
          <div className="mt-5 overflow-hidden rounded-xl border border-[#4FAEB2]/30">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50/80">
                  <tr>
                    {["Tipo", "Cantidad", "Total", "Ticket promedio", "Unidades"].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {desglose.map((r) => (
                    <tr key={r.tipo} className="transition-colors hover:bg-[#4FAEB2]/5">
                      <td className="px-3 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                            r.tipo === "CONTADO"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-[#4FAEB2]/30 bg-[#4FAEB2]/10 text-[#3F8E91]"
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`h-1.5 w-1.5 rounded-full ${r.tipo === "CONTADO" ? "bg-emerald-500" : "bg-[#4FAEB2]"}`}
                          />
                          {r.tipo}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs tabular-nums text-slate-700">{r.ventas}</td>
                      <td className="px-3 py-3 text-xs font-semibold tabular-nums text-slate-900">
                        Gs. {formatGs(r.total)}
                      </td>
                      <td className="px-3 py-3 text-xs tabular-nums text-slate-500">
                        Gs. {formatGs(Math.round(r.ticket))}
                      </td>
                      <td className="px-3 py-3 text-xs tabular-nums text-slate-500">{r.unid}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// ── Página principal ──────────────────────────────────────────────────────────

const PERIODO_OPTS: { id: Periodo; label: string }[] = [
  { id: "hoy",  label: "Hoy"       },
  { id: "7d",   label: "7 días"    },
  { id: "30d",  label: "30 días"   },
  { id: "mes",  label: "Mes actual"},
  { id: "anio", label: "Año"       },
];

const TAB_VALID: TabDash[] = ["comercial", "financiero", "inventario", "ventas", "sorteos"];

type DashScope =
  | { kind: "pending" }
  | { kind: "legacy" }
  | { kind: "empty" }
  | { kind: "scoped"; tabs: TabDash[]; defaultTab: TabDash };

function getInitialTab(): TabDash {
  if (typeof window === "undefined") return "comercial";
  const params = new URLSearchParams(window.location.search);
  const t = params.get("tab");
  return t && isDashboardTabSlug(t) ? t : "comercial";
}

export default function DashboardPage() {
  const [dashScope, setDashScope] = useState<DashScope>({ kind: "pending" });
  const [tab,      setTab]      = useState<TabDash>(getInitialTab);
  const [periodo,  setPeriodo]  = useState<Periodo>("mes");
  const [config,   setConfig]   = useState<ConfigGlobal | null>(null);
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [usuarioId, setUsuarioId] = useState<number | null>(null);

  const [prospectos,     setProspectos]     = useState<ProspectoRaw[]>([]);
  const [clientes,       setClientes]       = useState<ClienteRaw[]>([]);
  const [facturas,       setFacturas]       = useState<FacturaRaw[]>([]);
  const [notasCredito,   setNotasCredito]   = useState<NotaCreditoDashRow[]>([]);
  const [suscripciones,  setSuscripciones]  = useState<SuscripcionDashRow[]>([]);
  const [pagos,          setPagos]          = useState<PagoRaw[]>([]);
  const [tipificaciones, setTipificaciones] = useState<TipificacionRaw[]>([]);
  const [productos,      setProductos]      = useState<ProductoRaw[]>([]);
  const [ventas,         setVentas]         = useState<VentaRaw[]>([]);
  const [compras,        setCompras]        = useState<CompraRaw[]>([]);
  const [gastos,         setGastos]         = useState<GastoRaw[]>([]);
  // Sincronizar tab con URL al cargar (popstate / refresh)
  useEffect(() => {
    const syncFromUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const t = params.get("tab");
      if (t && isDashboardTabSlug(t)) setTab(t);
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchWithSupabaseSession("/api/empresas/mis-dashboard-views", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          if (!cancelled) setDashScope({ kind: "legacy" });
          return;
        }
        const j = (await r.json()) as {
          views?: { slug: string }[];
          defaultSlug?: string | null;
        };
        const slugs = (j.views ?? [])
          .map((v) => v.slug)
          .filter((s): s is TabDash => isDashboardTabSlug(s));
        if (slugs.length === 0) {
          if (!cancelled) setDashScope({ kind: "empty" });
          return;
        }
        const defRaw = j.defaultSlug ?? null;
        const defaultTab =
          defRaw && isDashboardTabSlug(defRaw) && slugs.includes(defRaw) ? defRaw : slugs[0];
        if (!cancelled) setDashScope({ kind: "scoped", tabs: slugs, defaultTab });
      })
      .catch(() => {
        if (!cancelled) setDashScope({ kind: "legacy" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (dashScope.kind !== "scoped") return;
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    const next =
      t && isDashboardTabSlug(t) && dashScope.tabs.includes(t) ? t : dashScope.defaultTab;
    setTab(next);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `?tab=${next}`);
    }
  }, [dashScope]);

  useEffect(() => {
    setConfig(getConfig());
    const us = getUsuarios();
    setUsuarios(us);

    // Cargar sesión activa o default al primer admin
    const saved = localStorage.getItem("neura_dash_usuario");
    const savedId = saved ? parseInt(saved, 10) : null;
    const defaultUser = us.find(u => u.nivel === "administrador") ?? us[0] ?? null;
    setUsuarioId(savedId ?? defaultUser?.id ?? null);

    // Datos de módulos desde Supabase
    getDashboardData()
      .then((data) => {
        setProspectos(data.prospectos);
        setClientes(data.clientes);
        setFacturas(data.facturas);
        setNotasCredito(data.notas_credito ?? []);
        setSuscripciones(data.suscripciones);
        setPagos(data.pagos);
        setTipificaciones(data.tipificaciones);
        setProductos(data.productos);
        setVentas(data.ventas);
        setCompras(data.compras);
        setGastos(data.gastos);
      })
      .catch(() => {
        setProspectos([]);
        setClientes([]);
        setFacturas([]);
        setNotasCredito([]);
        setSuscripciones([]);
        setPagos([]);
        setTipificaciones([]);
        setProductos([]);
        setVentas([]);
        setCompras([]);
        setGastos([]);
      });
  }, []);

  function handleUsuarioChange(id: number) {
    setUsuarioId(id);
    localStorage.setItem("neura_dash_usuario", String(id));
  }

  const usuarioActivo = usuarios.find(u => u.id === usuarioId) ?? null;
  const mapNombreTipoServicio = useMapNombreTipoServicioCatalogo(clientes);
  const nivel = usuarioActivo?.nivel ?? "administrador";

  const effectiveTabs: TabDash[] = dashScope.kind === "scoped" ? dashScope.tabs : TAB_VALID;
  const showTabNav = !(dashScope.kind === "scoped" && effectiveTabs.length === 1);

  const TAB_META: Record<TabDash, { label: string; Icon: (props: IconProps) => React.ReactElement }> = {
    comercial: { label: "Comercial", Icon: Icon.Comercial },
    financiero: { label: "Financiero", Icon: Icon.Financiero },
    inventario: { label: "Inventario", Icon: Icon.Inventario },
    ventas: { label: "Ventas", Icon: Icon.Ventas },
    sorteos: { label: "Sorteos", Icon: Icon.Sorteos },
  };

  if (!config) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center py-24 text-sm text-slate-500">
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#4FAEB2]" />
          Cargando dashboard…
        </div>
      </div>
    );
  }

  // Control de acceso
  if (nivel === "usuario") {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <span className="text-4xl">🔒</span>
        <h2 className="text-lg font-bold text-gray-800">Acceso restringido</h2>
        <p className="text-sm text-gray-500 text-center max-w-sm">
          El dashboard solo está disponible para usuarios con nivel <strong>Supervisor</strong> o <strong>Administrador</strong>.
        </p>
        <div className="flex items-center gap-2 text-sm text-gray-500 mt-2">
          Cambiar a:
          {usuarios.filter(u => u.nivel !== "usuario").map(u => (
            <button key={u.id} onClick={() => handleUsuarioChange(u.id)}
              className="px-3 py-1.5 rounded-lg bg-[#0EA5E9] hover:bg-[#0284C7] text-white text-xs font-medium transition-colors">
              {u.nombre}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (dashScope.kind === "empty") {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6 md:px-8">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-4">
            <ZentraMark />
            <div>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
                />
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
                  Zentra
                </p>
              </div>
              <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
                Dashboard
              </h1>
              <p className="mt-1.5 max-w-md text-sm leading-relaxed text-slate-500">
                No hay vistas del tablero disponibles para tu usuario.
              </p>
            </div>
          </div>
        </header>
        <div className="rounded-2xl border border-[#4FAEB2]/45 bg-white px-5 py-10 text-center text-sm shadow-sm">
          <p className="font-semibold text-slate-900">Sin vistas asignadas</p>
          <p className="mx-auto mt-2 max-w-md text-slate-500">
            Tu empresa aún no habilitó pestañas para vos, o tu perfil no tiene vistas del dashboard. Pedí a un
            administrador que revise <span className="font-semibold text-slate-700">Usuarios</span> y las vistas habilitadas para la
            empresa.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 px-4 py-6 sm:px-6 md:px-8" style={{ color: Z.muted }}>
      <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-4">
          <ZentraMark />
          <div>
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#4FAEB2] shadow-[0_0_0_3px_rgba(79,174,178,0.18)]"
              />
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
                Zentra
              </p>
            </div>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
              Dashboard
            </h1>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-slate-500">
              Neura ERP · Vista {nivel === "supervisor" ? "de tu área" : "global"} · período alineado al filtro
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {usuarios.length > 0 && (
            <div className="flex flex-col gap-1.5 sm:items-end">
              <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                Viendo como
              </span>
              <select
                value={usuarioId ?? ""}
                onChange={(e) => handleUsuarioChange(parseInt(e.target.value, 10))}
                className="rounded-xl border border-[#4FAEB2]/45 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20"
              >
                {usuarios.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nombre} ({u.nivel})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-wrap gap-1 rounded-xl border border-[#4FAEB2]/45 bg-white p-1 shadow-sm">
            {PERIODO_OPTS.map((p) => {
              const active = periodo === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPeriodo(p.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                    active
                      ? "bg-[#4FAEB2] text-white shadow-sm shadow-[#4FAEB2]/30"
                      : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {showTabNav ? (
        <nav className="flex w-full flex-wrap gap-1 rounded-2xl border border-[#4FAEB2]/45 bg-white p-1.5 shadow-sm sm:w-fit">
          {effectiveTabs.map((tid) => {
            const meta = TAB_META[tid];
            const TabIcon = meta.Icon;
            const active = tab === tid;
            return (
              <button
                key={tid}
                type="button"
                onClick={() => {
                  setTab(tid);
                  if (typeof window !== "undefined") {
                    window.history.replaceState(null, "", `?tab=${tid}`);
                  }
                }}
                className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all ${
                  active
                    ? "bg-[#4FAEB2] text-white shadow-md shadow-[#4FAEB2]/30"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                }`}
              >
                <TabIcon className="h-4 w-4 shrink-0" />
                {meta.label}
              </button>
            );
          })}
        </nav>
      ) : null}

      {/* Contenido */}
      {tab === "comercial" && (
        <DashComercial
          prospectos={prospectos}
          clientes={clientes}
          mapNombreTipoServicio={mapNombreTipoServicio}
          tipificaciones={tipificaciones}
          usuario={usuarioActivo}
          periodo={periodo}
          config={config}
          facturas={facturas}
          notasCredito={notasCredito}
          suscripciones={suscripciones}
        />
      )}

      {tab === "financiero" && (
        <DashFinanciero
          facturas={facturas}
          pagos={pagos}
          clientes={clientes}
          ventas={ventas}
          periodo={periodo}
          config={config}
          mapNombreTipoServicio={mapNombreTipoServicio}
        />
      )}

      {tab === "inventario" && (
        <DashInventario
          productos={productos}
          compras={compras}
        />
      )}

      {tab === "ventas" && (
        <DashVentas
          ventas={ventas}
          productos={productos}
          periodo={periodo}
        />
      )}

      {/* Sorteos trae su propia data (rango de fechas propio), no usa `periodo` ni getDashboardData. */}
      {tab === "sorteos" && <SorteosVentasTab />}

    </div>
  );
}
