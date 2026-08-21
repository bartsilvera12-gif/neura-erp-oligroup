import "server-only";
import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type RevExportRevendedor = {
  nombre: string;
  codigo: string | null;
  telefono: string | null;
  clicks: number;
  ventas: number;
  boletos: number;
  monto: number;
  conversion: number; // 0..1
};

export type RevExportVenta = {
  vendedor: string;
  codigo: string | null;
  orden: number | null;
  fecha: string; // ISO
  comprador: string;
  compradorTelefono: string;
  compradorDocumento: string;
  cantidad: number;
  monto: number;
  estado: string;
};

export type RevExportPayload = {
  sorteoNombre: string;
  sorteoEstado: string;
  generadoISO: string;
  revendedores: RevExportRevendedor[];
  detalle: RevExportVenta[];
  /** Si el reporte es de un solo vendedor, su nombre (para el título). */
  vendedorUnico?: string | null;
};

function tituloReporte(p: RevExportPayload): string {
  return p.vendedorUnico ? `Reporte de ${p.vendedorUnico}` : "Reporte de Revendedores";
}

const TEAL = rgb(0x0b / 255, 0x3a / 255, 0x3d / 255);
const WHITE = rgb(1, 1, 1);
const DARK = rgb(0.1, 0.12, 0.14);
const GRAY = rgb(0.4, 0.42, 0.45);
const LINE = rgb(0.85, 0.87, 0.89);

function gs(n: number): string {
  return `${Math.round(n).toLocaleString("es-PY")} Gs`;
}
function fecha(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("es-PY", { day: "2-digit", month: "2-digit", year: "2-digit" });
  } catch {
    return iso.slice(0, 10);
  }
}

/* ============================ EXCEL ============================ */

export function buildRevendedoresXlsx(p: RevExportPayload): Buffer {
  const wb = XLSX.utils.book_new();

  // Hoja Resumen
  const resumenHeader = ["Vendedor", "Código", "Teléfono", "Clics", "Ventas", "Boletos", "Monto (Gs)", "Conversión %"];
  const resumenRows = p.revendedores.map((r) => [
    r.nombre,
    r.codigo ?? "",
    r.telefono ?? "",
    r.clicks,
    r.ventas,
    r.boletos,
    Math.round(r.monto),
    r.clicks > 0 ? Math.round(r.conversion * 100) : "",
  ]);
  const wsResumen = XLSX.utils.aoa_to_sheet([
    [`${tituloReporte(p)} — ${p.sorteoNombre}`],
    [`Generado: ${new Date(p.generadoISO).toLocaleString("es-PY")}`],
    [],
    resumenHeader,
    ...resumenRows,
  ]);
  wsResumen["!cols"] = [{ wch: 26 }, { wch: 14 }, { wch: 16 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 16 }, { wch: 13 }];
  XLSX.utils.book_append_sheet(wb, wsResumen, "Resumen");

  // Hoja Detalle (con datos del comprador — solo para el operador)
  const detHeader = [
    "Vendedor", "Cód. vendedor", "Orden", "Fecha", "Comprador", "Teléfono comprador", "Documento", "Cantidad", "Monto (Gs)", "Estado",
  ];
  const detRows = p.detalle.map((d) => [
    d.vendedor,
    d.codigo ?? "",
    d.orden ?? "",
    fecha(d.fecha),
    d.comprador,
    d.compradorTelefono,
    d.compradorDocumento,
    d.cantidad,
    Math.round(d.monto),
    d.estado,
  ]);
  const wsDet = XLSX.utils.aoa_to_sheet([detHeader, ...detRows]);
  wsDet["!cols"] = [{ wch: 24 }, { wch: 14 }, { wch: 8 }, { wch: 10 }, { wch: 26 }, { wch: 18 }, { wch: 14 }, { wch: 9 }, { wch: 14 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsDet, "Detalle compras");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/* ============================ PDF ============================ */

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 40;

export async function buildRevendedoresPdf(p: RevExportPayload): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  const newPage = () => {
    page = pdf.addPage([A4.w, A4.h]);
    y = A4.h - MARGIN;
  };
  const ensure = (need: number) => {
    if (y - need < MARGIN) newPage();
  };
  const clip = (s: string, f: PDFFont, size: number, maxW: number) => {
    let t = String(s ?? "");
    while (t.length > 1 && f.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
    return t;
  };

  // Encabezado con banda de marca
  page.drawRectangle({ x: 0, y: A4.h - 70, width: A4.w, height: 70, color: TEAL });
  page.drawText(tituloReporte(p), { x: MARGIN, y: A4.h - 38, size: 18, font: bold, color: WHITE });
  page.drawText(clip(p.sorteoNombre, font, 11, A4.w - 2 * MARGIN), { x: MARGIN, y: A4.h - 56, size: 11, font, color: WHITE });
  y = A4.h - 70 - 24;
  page.drawText(`Generado: ${new Date(p.generadoISO).toLocaleString("es-PY")}`, { x: MARGIN, y, size: 8, font, color: GRAY });
  y -= 24;

  // ---- Resumen por vendedor ----
  page.drawText("Resumen por vendedor", { x: MARGIN, y, size: 12, font: bold, color: DARK });
  y -= 16;
  const rCols = [
    { t: "Vendedor", w: 150, align: "l" as const },
    { t: "Código", w: 80, align: "l" as const },
    { t: "Ventas", w: 55, align: "r" as const },
    { t: "Boletos", w: 55, align: "r" as const },
    { t: "Monto", w: 110, align: "r" as const },
    { t: "Conv.", w: 45, align: "r" as const },
  ];
  const drawRow = (cells: string[], cols: typeof rCols, f: PDFFont, size: number, color = DARK) => {
    let x = MARGIN;
    for (let i = 0; i < cols.length; i++) {
      const cw = cols[i].w;
      const txt = clip(cells[i] ?? "", f, size, cw - 6);
      const tw = f.widthOfTextAtSize(txt, size);
      const tx = cols[i].align === "r" ? x + cw - tw - 3 : x + 3;
      page.drawText(txt, { x: tx, y, size, font: f, color });
      x += cw;
    }
  };
  // header
  page.drawRectangle({ x: MARGIN, y: y - 3, width: rCols.reduce((s, c) => s + c.w, 0), height: 15, color: rgb(0.95, 0.96, 0.97) });
  drawRow(rCols.map((c) => c.t), rCols, bold, 8, GRAY);
  y -= 16;
  for (const r of p.revendedores) {
    ensure(14);
    drawRow(
      [r.nombre, r.codigo ?? "", String(r.ventas), String(r.boletos), gs(r.monto), r.clicks > 0 ? `${Math.round(r.conversion * 100)}%` : "-"],
      rCols, font, 8.5
    );
    y -= 13;
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: MARGIN + rCols.reduce((s, c) => s + c.w, 0), y: y + 4 }, thickness: 0.4, color: LINE });
  }
  y -= 14;

  // ---- Detalle de compras (con datos del comprador) ----
  ensure(40);
  page.drawText("Detalle de compras", { x: MARGIN, y, size: 12, font: bold, color: DARK });
  y -= 16;
  const dCols = [
    { t: "Orden", w: 40, align: "l" as const },
    { t: "Fecha", w: 52, align: "l" as const },
    { t: "Vendedor", w: 95, align: "l" as const },
    { t: "Comprador", w: 110, align: "l" as const },
    { t: "Teléfono", w: 85, align: "l" as const },
    { t: "Cant.", w: 32, align: "r" as const },
    { t: "Monto", w: 75, align: "r" as const },
    { t: "Estado", w: 26, align: "l" as const },
  ];
  const dHeader = () => {
    page.drawRectangle({ x: MARGIN, y: y - 3, width: dCols.reduce((s, c) => s + c.w, 0), height: 15, color: rgb(0.95, 0.96, 0.97) });
    drawRow(dCols.map((c) => c.t), dCols, bold, 7.5, GRAY);
    y -= 16;
  };
  dHeader();
  if (p.detalle.length === 0) {
    page.drawText("Sin compras atribuidas a revendedores en este sorteo.", { x: MARGIN, y, size: 9, font, color: GRAY });
    y -= 14;
  }
  for (const d of p.detalle) {
    if (y - 13 < MARGIN) { newPage(); dHeader(); }
    drawRow(
      [
        d.orden != null ? `#${d.orden}` : "",
        fecha(d.fecha),
        d.vendedor,
        d.comprador,
        d.compradorTelefono,
        String(d.cantidad),
        gs(d.monto),
        d.estado === "confirmado" ? "OK" : "Rev.",
      ],
      dCols, font, 7.5
    );
    y -= 13;
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: MARGIN + dCols.reduce((s, c) => s + c.w, 0), y: y + 4 }, thickness: 0.4, color: LINE });
  }

  // Pie con paginación
  const pages = pdf.getPages();
  pages.forEach((pg: PDFPage, i: number) => {
    pg.drawText(`Página ${i + 1} de ${pages.length} · ZENTRA`, { x: MARGIN, y: 20, size: 7, font, color: GRAY });
  });

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
