"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import type {
  EntradaImpresionContext,
  PhysicalCouponPrintRow,
} from "@/lib/sorteos/physical-coupons-print";
import type { SorteoEntradaEstadoPago } from "@/lib/sorteos/types";

type PrintFormat = "thermal_58" | "thermal_80" | "a4" | "oficio";

const PRINT_FORMAT_STORAGE_KEY = "neura:sorteos:physical-coupons:print-format";
const THERMAL_CUT_STORAGE_KEY = "neura:sorteos:physical-coupons:thermal-cut-each";
const DEFAULT_PRINT_FORMAT: PrintFormat = "a4";

const PRINT_FORMAT_OPTIONS: { value: PrintFormat; label: string; help: string }[] = [
  {
    value: "thermal_58",
    label: "Ticket 58mm",
    help: "Formato para impresoras térmicas de 58mm. Los cupones se imprimen uno debajo del otro.",
  },
  {
    value: "thermal_80",
    label: "Ticket 80mm",
    help: "Formato recomendado para ticketeras térmicas de 80mm, como ZKTeco/ZKP8003.",
  },
  { value: "a4", label: "Hoja A4", help: "Formato para hojas A4 con varios cupones por página." },
  {
    value: "oficio",
    label: "Hoja oficio",
    help: "Formato para hoja oficio con varios cupones por página.",
  },
];

type FormatLayout = {
  kind: "thermal" | "sheet";
  cols: number;
  rows: number;
};

const FORMAT_LAYOUTS: Record<PrintFormat, FormatLayout> = {
  thermal_58: { kind: "thermal", cols: 1, rows: 1 },
  thermal_80: { kind: "thermal", cols: 1, rows: 1 },
  a4: { kind: "sheet", cols: 2, rows: 5 },
  oficio: { kind: "sheet", cols: 2, rows: 7 },
};

function isPrintFormat(value: string | null): value is PrintFormat {
  return (
    value === "thermal_58" || value === "thermal_80" || value === "a4" || value === "oficio"
  );
}

const ESTADOS: { value: SorteoEntradaEstadoPago; label: string }[] = [
  { value: "confirmado", label: "Confirmado" },
  { value: "pendiente_revision", label: "Pendiente de revisión" },
  { value: "pendiente", label: "Pendiente" },
  { value: "rechazado", label: "Rechazado" },
];

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCouponInner(row: PhysicalCouponPrintRow): string {
  const nombre = row.nombre_participante ? escapeHtml(row.nombre_participante) : "";
  const docLine = row.documento ? `<p>Doc. ${escapeHtml(row.documento)}</p>` : "";
  const telLine = row.whatsapp ? `<p>Tel. ${escapeHtml(row.whatsapp)}</p>` : "";
  return `
    <div class="coupon-top">
      <p class="coupon-sorteo">${escapeHtml(row.sorteo_nombre)}</p>
      <p class="coupon-numero">${escapeHtml(row.numero_cupon)}</p>
      <p class="coupon-orden">Orden <strong>${escapeHtml(String(row.numero_orden))}</strong></p>
    </div>
    <div class="coupon-bottom">
      ${nombre ? `<p class="coupon-nombre">${nombre}</p>` : `<p class="coupon-nombre muted">—</p>`}
      ${docLine}
      ${telLine}
      <p class="coupon-fecha">${escapeHtml(row.fecha_display)}</p>
    </div>`;
}

/** Estilos base de la tarjeta de cupón, compartidos por todos los formatos. */
const SHARED_COUPON_CARD_CSS = `
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    color: #0f172a;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fff;
  }
  .coupon-card {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    border: 1px dashed #64748b;
    border-radius: 8px;
    padding: 10px;
    text-align: center;
    background: #fff;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .coupon-sorteo { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0; }
  .coupon-numero { font-size: 1.625rem; font-weight: 800; margin: 4px 0; font-variant-numeric: tabular-nums; color: #0f172a; }
  .coupon-orden { font-size: 12px; color: #475569; margin: 0; }
  .coupon-bottom { margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #334155; }
  .coupon-bottom p { margin: 2px 0; word-break: break-word; }
  .coupon-nombre { font-weight: 600; }
  .coupon-nombre.muted { color: #94a3b8; font-weight: 400; }
  .coupon-fecha { margin-top: 4px !important; color: #64748b; }
  .coupon-pad { visibility: hidden; break-inside: avoid; }
  @media print {
    html, body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

function buildSheetBody(rows: PhysicalCouponPrintRow[], layout: FormatLayout): string {
  const perPage = layout.cols * layout.rows;
  const pages = chunk(rows, perPage);
  return pages
    .map((pageRows) => {
      const articles = pageRows
        .map((row) => `<article class="coupon-card">${renderCouponInner(row)}</article>`)
        .join("");
      const padCount = Math.max(0, perPage - pageRows.length);
      const pads = Array.from({ length: padCount })
        .map(() => `<div class="coupon-pad" aria-hidden="true"></div>`)
        .join("");
      return `<section class="coupon-page">${articles}${pads}</section>`;
    })
    .join("");
}

function buildThermalBody(rows: PhysicalCouponPrintRow[], cutEachCoupon: boolean): string {
  const cls = cutEachCoupon ? "coupon-card coupon-card--cut" : "coupon-card";
  const articles = rows
    .map((row) => `<article class="${cls}">${renderCouponInner(row)}</article>`)
    .join("");
  return `<section class="thermal-ticket-list">${articles}</section>`;
}

function buildFormatCss(format: PrintFormat, cutEachCoupon: boolean): string {
  const layout = FORMAT_LAYOUTS[format];

  if (layout.kind === "thermal") {
    const widthMm = format === "thermal_58" ? 58 : 80;
    const marginMm = format === "thermal_58" ? 1.5 : 2;
    const numberSize = format === "thermal_58" ? "26px" : "32px";
    const sorteoSize = format === "thermal_58" ? "12px" : "14px";
    const ordenSize = format === "thermal_58" ? "13px" : "15px";
    const bottomSize = format === "thermal_58" ? "13px" : "15px";
    const gapMm = format === "thermal_58" ? 2 : 3;
    const cardPadding = format === "thermal_58" ? "6px 4px" : "8px 6px";
    const cutCss = cutEachCoupon
      ? `
      .coupon-card--cut {
        break-after: page;
        page-break-after: always;
      }
      .coupon-card--cut:last-child {
        break-after: auto;
        page-break-after: auto;
      }
      `
      : "";
    return `
      @page { size: ${widthMm}mm auto; margin: ${marginMm}mm; }
      ${SHARED_COUPON_CARD_CSS}
      html, body { color: #000 !important; }
      body { width: ${widthMm - marginMm * 2}mm; font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; }
      .thermal-ticket-list {
        display: flex;
        flex-direction: column;
        gap: ${gapMm}mm;
        width: 100%;
      }
      .coupon-card {
        width: 100%;
        padding: ${cardPadding};
        border: 1.5px dashed #000 !important;
        color: #000 !important;
      }
      .coupon-sorteo {
        font-size: ${sorteoSize} !important;
        color: #000 !important;
        font-weight: 700 !important;
      }
      .coupon-numero {
        font-size: ${numberSize} !important;
        color: #000 !important;
        font-weight: 900 !important;
        margin: 4px 0 !important;
        line-height: 1.1 !important;
      }
      .coupon-orden { font-size: ${ordenSize} !important; color: #000 !important; }
      .coupon-bottom {
        margin-top: 6px !important;
        padding-top: 6px !important;
        border-top: 1px solid #000 !important;
        font-size: ${bottomSize} !important;
        color: #000 !important;
      }
      .coupon-bottom p { color: #000 !important; }
      .coupon-nombre { color: #000 !important; font-weight: 700 !important; }
      .coupon-nombre.muted { color: #000 !important; }
      .coupon-fecha { color: #000 !important; }
      ${cutCss}
    `;
  }

  const pageSize = format === "oficio" ? "216mm 330mm" : "A4";
  const maxWidth = format === "oficio" ? "196mm" : "190mm";
  return `
    @page { size: ${pageSize}; margin: 10mm; }
    ${SHARED_COUPON_CARD_CSS}
    .coupon-page {
      display: grid;
      grid-template-columns: repeat(${layout.cols}, minmax(0, 1fr));
      gap: 10px;
      grid-auto-rows: minmax(28mm, auto);
      max-width: ${maxWidth};
      margin: 0 auto;
      break-after: page;
      page-break-after: always;
    }
    .coupon-page:last-child { break-after: auto; page-break-after: auto; }
  `;
}

/**
 * Documento HTML mínimo solo con cupones (sin AppShell). Evita overflow/h-svh del ERP en impresión.
 */
function buildPhysicalCouponsPrintDocument(
  rows: PhysicalCouponPrintRow[],
  documentTitle: string,
  format: PrintFormat,
  cutEachCoupon: boolean
): string {
  const layout = FORMAT_LAYOUTS[format];
  const body =
    layout.kind === "thermal" ? buildThermalBody(rows, cutEachCoupon) : buildSheetBody(rows, layout);
  const css = buildFormatCss(format, cutEachCoupon);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(documentTitle)}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Tarjeta de cupón en pantalla — mismo diseño visual para todos los formatos. */
function CouponCard({ row }: { row: PhysicalCouponPrintRow }) {
  return (
    <article className="flex flex-col justify-between rounded-lg border border-dashed border-slate-400 bg-slate-50/80 p-3 text-center shadow-sm print:bg-white print:shadow-none break-inside-avoid page-break-inside-avoid">
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {row.sorteo_nombre}
        </p>
        <p className="text-2xl font-bold tabular-nums text-slate-900">{row.numero_cupon}</p>
        <p className="text-xs text-slate-600">
          Orden <span className="font-semibold tabular-nums">{row.numero_orden}</span>
        </p>
      </div>
      <div className="mt-2 space-y-0.5 border-t border-slate-200 pt-2 text-[11px] text-slate-700">
        {row.nombre_participante ? (
          <p className="font-semibold break-words" title={row.nombre_participante}>
            {row.nombre_participante}
          </p>
        ) : (
          <p className="text-slate-400">—</p>
        )}
        {row.documento ? <p className="break-words">Doc. {row.documento}</p> : null}
        {row.whatsapp ? <p className="break-words">Tel. {row.whatsapp}</p> : null}
        <p className="text-slate-500">{row.fecha_display}</p>
      </div>
    </article>
  );
}

export default function PhysicalCouponsPrintClient({
  sorteoId,
  sorteoNombre,
  rows,
  error,
  q,
  estado,
  fechaDesde,
  fechaHasta,
  entradaId,
  entradaContext,
  batchMode = false,
  batchEntradaCount = 0,
  cuponDesde = null,
  cuponHasta = null,
}: {
  sorteoId: string;
  sorteoNombre: string;
  rows: PhysicalCouponPrintRow[];
  error: string | null;
  q: string;
  estado: SorteoEntradaEstadoPago;
  fechaDesde: string;
  fechaHasta: string;
  entradaId: string | null;
  entradaContext: EntradaImpresionContext | null;
  batchMode?: boolean;
  batchEntradaCount?: number;
  cuponDesde?: number | null;
  cuponHasta?: number | null;
}) {
  const router = useRouter();

  const [selectedPrintFormat, setSelectedPrintFormat] = useState<PrintFormat>(DEFAULT_PRINT_FORMAT);
  const [formatHydrated, setFormatHydrated] = useState(false);
  const [thermalCutEachCoupon, setThermalCutEachCoupon] = useState<boolean>(false);

  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirmOk, setConfirmOk] = useState(false);

  const modoEntrada = Boolean(entradaId && entradaContext);
  const modoBatch = Boolean(batchMode) && !modoEntrada;
  const yaImpreso = Boolean(entradaContext?.cupones_impresos_at);
  const mostrarConfirmar = modoEntrada && Boolean(entradaId) && !yaImpreso && !confirmOk;

  useEffect(() => {
    document.documentElement.classList.add("physical-coupons-print-page");
    return () => {
      document.documentElement.classList.remove("physical-coupons-print-page");
    };
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PRINT_FORMAT_STORAGE_KEY);
      if (isPrintFormat(stored)) {
        setSelectedPrintFormat(stored);
      }
      const cut = window.localStorage.getItem(THERMAL_CUT_STORAGE_KEY);
      if (cut === "1") setThermalCutEachCoupon(true);
    } catch {
      /* localStorage no disponible */
    }
    setFormatHydrated(true);
  }, []);

  useEffect(() => {
    if (!formatHydrated) return;
    try {
      window.localStorage.setItem(PRINT_FORMAT_STORAGE_KEY, selectedPrintFormat);
    } catch {
      /* noop */
    }
  }, [selectedPrintFormat, formatHydrated]);

  useEffect(() => {
    if (!formatHydrated) return;
    try {
      window.localStorage.setItem(THERMAL_CUT_STORAGE_KEY, thermalCutEachCoupon ? "1" : "0");
    } catch {
      /* noop */
    }
  }, [thermalCutEachCoupon, formatHydrated]);

  const activeFormatHelp = useMemo(
    () =>
      PRINT_FORMAT_OPTIONS.find((o) => o.value === selectedPrintFormat)?.help ?? "",
    [selectedPrintFormat]
  );

  const layout = FORMAT_LAYOUTS[selectedPrintFormat];
  const isThermal = layout.kind === "thermal";
  const thermalWidthMm = selectedPrintFormat === "thermal_58" ? 58 : 80;
  const sheetMaxWidth = selectedPrintFormat === "oficio" ? "196mm" : "190mm";
  const perPage = layout.cols * layout.rows;
  const pages = isThermal ? [rows] : chunk(rows, perPage);

  function handlePrint() {
    if (rows.length === 0) return;
    const title = sorteoNombre.trim() || "Cupones sorteo";
    const html = buildPhysicalCouponsPrintDocument(
      rows,
      title,
      selectedPrintFormat,
      isThermal && thermalCutEachCoupon
    );
    /* Sin noopener en features: si no, algunos navegadores devuelven null y no podemos llamar a print(). */
    const w = window.open("", "_blank");
    if (!w) {
      window.alert(
        "No se pudo abrir la ventana de impresión. Permití ventanas emergentes para este sitio, o usá Ctrl+P en esta página."
      );
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    const runPrint = () => {
      try {
        w.focus();
        w.print();
      } catch {
        /* noop */
      }
    };
    if (w.document.readyState === "complete") {
      window.setTimeout(runPrint, 100);
    } else {
      w.addEventListener("load", () => window.setTimeout(runPrint, 100));
    }
  }

  async function handleConfirmarImpresion() {
    if (!entradaId) return;
    setConfirmPending(true);
    setConfirmErr(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/entradas/${encodeURIComponent(entradaId)}/confirmar-impresion`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sorteo_id: sorteoId }),
        }
      );
      const raw = await res.text();
      if (!res.ok) {
        setConfirmErr(raw || `Error ${res.status}`);
        return;
      }
      setConfirmOk(true);
      router.refresh();
    } catch (e) {
      setConfirmErr(e instanceof Error ? e.message : "Error al confirmar");
    } finally {
      setConfirmPending(false);
    }
  }

  return (
    <>
      <style>{`
        @media print {
          @page { size: A4; margin: 10mm; }
          .no-print { display: none !important; }
          .print-page-break { break-after: page; page-break-after: always; }
          .print-page-break:last-child { break-after: auto; page-break-after: auto; }
          .physical-coupons-print-area article {
            break-inside: avoid;
            page-break-inside: avoid;
          }
        }
      `}</style>

      <div className="space-y-6 max-w-5xl">
        <div className="no-print flex flex-wrap items-center gap-2 text-sm text-slate-500">
          <Link href="/sorteos" className="hover:text-slate-800">
            Sorteos
          </Link>
          <span>/</span>
          <Link href={`/sorteos/${encodeURIComponent(sorteoId)}/editar`} className="hover:text-slate-800">
            Editar sorteo
          </Link>
          <span>/</span>
          <span className="font-medium text-slate-800">Imprimir cupones</span>
        </div>

        <div className="no-print space-y-2">
          <h1 className="text-2xl font-bold text-slate-900">Imprimir cupones para urna</h1>
          <p className="text-slate-600 text-sm">
            Se imprimirá un cupón físico por cada cupón confirmado del sorteo.
          </p>
          {!modoEntrada ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              Solo se incluyen cupones de compras confirmadas, salvo que cambies el filtro de estado de pago.
            </p>
          ) : null}
          <p className="text-xs text-slate-500">
            Fecha en el cupón: se usa la fecha de pago si existe; si no, la fecha de creación de la orden.
          </p>
        </div>

        <div className="no-print rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            <span className="font-semibold text-slate-800">Formato de impresión</span>
            <select
              value={selectedPrintFormat}
              onChange={(e) => {
                const v = e.target.value;
                if (isPrintFormat(v)) setSelectedPrintFormat(v);
              }}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm max-w-xs"
            >
              {PRINT_FORMAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-slate-600">{activeFormatHelp}</p>

          {isThermal ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 space-y-1">
              <label className="flex items-center gap-2 text-sm text-slate-800">
                <input
                  type="checkbox"
                  checked={thermalCutEachCoupon}
                  onChange={(e) => setThermalCutEachCoupon(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span className="font-medium">Cortar cada cupón</span>
              </label>
              <p className="text-xs text-slate-600">
                Depende del driver de la ticketera. El sistema separará cada cupón como una página
                para facilitar el auto-corte.
              </p>
              <p className="text-xs text-slate-500">
                Para que la ticketera corte cada cupón, activá «Cortar cada cupón» y verificá que el
                driver de la impresora tenga habilitado el corte automático al final de cada página.
              </p>
            </div>
          ) : null}

          <p className="text-xs text-slate-500">
            Para ticketera térmica, elegí 58mm u 80mm según el papel de tu impresora. En el diálogo de
            impresión del navegador, seleccioná el mismo tamaño de papel y desactivá encabezados y pies
            de página si aparece la URL o fecha.
          </p>
        </div>

        {modoEntrada && entradaContext ? (
          <div className="no-print rounded-xl border border-[#4FAEB2]/30 bg-[#4FAEB2]/8 px-4 py-3 text-sm text-sky-950">
            <p className="font-semibold">
              Imprimiendo cupones de la orden N°{" "}
              <span className="tabular-nums">{entradaContext.numero_orden}</span>
            </p>
            <p>
              Cliente: <strong>{entradaContext.nombre_participante || "—"}</strong>
            </p>
            <p>
              Cantidad de cupones:{" "}
              <strong className="tabular-nums">{entradaContext.cantidad_cupones}</strong>
            </p>
            {yaImpreso ? (
              <p className="mt-2 text-xs text-emerald-900">
                Impresión ya registrada{" "}
                {entradaContext.cupones_impresos_at
                  ? new Date(entradaContext.cupones_impresos_at).toLocaleString("es-PY")
                  : ""}
                .
              </p>
            ) : null}
          </div>
        ) : null}

        {confirmOk ? (
          <div className="no-print rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
            Impresión confirmada correctamente.
          </div>
        ) : null}

        {confirmErr ? (
          <div className="no-print rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            {confirmErr}
          </div>
        ) : null}

        {modoBatch ? (
          <div className="no-print rounded-xl border border-[#4FAEB2]/30 bg-[#4FAEB2]/8 px-4 py-3 text-sm text-sky-950">
            {batchEntradaCount > 0 ? (
              <p className="font-semibold">
                Impresión por tandas: cupones de{" "}
                <span className="tabular-nums">{batchEntradaCount}</span>{" "}
                {batchEntradaCount === 1 ? "orden seleccionada" : "órdenes seleccionadas"}.
              </p>
            ) : null}
            {cuponDesde != null || cuponHasta != null ? (
              <p className="font-semibold">
                Rango de cupones{" "}
                {cuponDesde != null ? (
                  <span className="tabular-nums">{cuponDesde}</span>
                ) : (
                  "inicio"
                )}{" "}
                –{" "}
                {cuponHasta != null ? (
                  <span className="tabular-nums">{cuponHasta}</span>
                ) : (
                  "fin"
                )}
                .
              </p>
            ) : null}
            <p className="mt-1 text-xs text-sky-900">
              Solo se muestran los cupones de la selección. Esta vista no modifica datos ni marca como impreso.
            </p>
            <Link
              href={`/sorteos/${encodeURIComponent(sorteoId)}/imprimir-cupones`}
              className="mt-2 inline-block text-sm font-medium text-[#4FAEB2] hover:underline"
            >
              Ver todos los cupones del sorteo (sin filtrar por selección)
            </Link>
          </div>
        ) : !modoEntrada ? (
          <form
            method="get"
            className="no-print flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
          >
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              Buscar
              <input
                name="q"
                type="search"
                defaultValue={q}
                placeholder="Nombre, doc., teléfono u orden"
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm min-w-[200px]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              Estado de pago
              <select
                name="estado"
                defaultValue={estado}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              >
                {ESTADOS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              Desde
              <input
                name="fecha_desde"
                type="date"
                defaultValue={fechaDesde}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              Hasta
              <input
                name="fecha_hasta"
                type="date"
                defaultValue={fechaHasta}
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="submit"
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900"
            >
              Aplicar filtros
            </button>
          </form>
        ) : (
          <div className="no-print flex flex-wrap gap-2">
            <Link
              href={`/sorteos/${encodeURIComponent(sorteoId)}/imprimir-cupones`}
              className="text-sm font-medium text-[#4FAEB2] hover:underline"
            >
              Ver todos los cupones del sorteo (sin filtrar por orden)
            </Link>
          </div>
        )}

        <div className="no-print flex flex-wrap items-center gap-3">
          <p className="text-sm font-medium text-slate-800">
            Cupones listos para imprimir: <span className="tabular-nums">{rows.length}</span>
          </p>
          {sorteoNombre ? (
            <span className="text-sm text-slate-500">
              Sorteo: <strong className="font-semibold text-slate-700">{sorteoNombre}</strong>
            </span>
          ) : null}
        </div>

        {error ? (
          <div className="no-print rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            {error}
          </div>
        ) : null}

        <div className="no-print flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <button
            type="button"
            onClick={handlePrint}
            disabled={rows.length === 0}
            className="rounded-lg bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#3F8E91] disabled:opacity-50 disabled:pointer-events-none"
          >
            Imprimir cupones
          </button>
          <p className="text-xs text-slate-500 max-w-xl">
            Se abrirá una ventana solo con los cupones (sin menú del ERP). Si la impresora muestra URL o fecha,
            desactivá encabezados y pies de página en el diálogo de impresión.
          </p>

          {mostrarConfirmar ? (
            <button
              type="button"
              onClick={() => void handleConfirmarImpresion()}
              disabled={confirmPending || rows.length === 0}
              className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {confirmPending ? "Confirmando…" : "Confirmar impresión"}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => router.push(`/sorteos/${encodeURIComponent(sorteoId)}/editar`)}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            Volver al sorteo
          </button>
          <button
            type="button"
            onClick={() => router.push("/sorteos/cupones")}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            Volver a Cupones
          </button>
        </div>

        <div
          className="physical-coupons-print-area print-area rounded-xl border border-slate-200 bg-white p-4 print:border-0 print:p-0"
          data-print-area="physical-coupons"
        >
          {rows.length === 0 && !error ? (
            <p className="no-print text-sm text-slate-500">No hay cupones con los filtros seleccionados.</p>
          ) : null}

          {isThermal ? (
            <div
              className="mx-auto flex flex-col gap-3 bg-white"
              style={{ width: `${thermalWidthMm}mm`, maxWidth: "100%" }}
            >
              {rows.map((row) => (
                <CouponCard key={row.cupon_id} row={row} />
              ))}
            </div>
          ) : (
            pages.map((pageRows, pi) => (
              <div
                key={pi}
                className={`print-page-break mx-auto ${pi > 0 ? "mt-8 print:mt-0" : ""}`}
                style={{ maxWidth: sheetMaxWidth }}
              >
                <div
                  className="grid gap-3 print:gap-2"
                  style={{
                    gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
                    gridAutoRows: "minmax(28mm, auto)",
                  }}
                >
                  {pageRows.map((row) => (
                    <CouponCard key={row.cupon_id} row={row} />
                  ))}
                  {Array.from({ length: Math.max(0, perPage - pageRows.length) }).map((_, i) => (
                    <div
                      key={`pad-${pi}-${i}`}
                      className="rounded-lg border border-transparent print:hidden"
                      aria-hidden
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
