import "server-only";

import { createHash } from "node:crypto";
import QRCode from "qrcode";
import {
  mergeCustomTemplateFields,
  type SorteoTicketImageConfig,
} from "@/lib/sorteos/sorteo-ticket-types";
import { svgTextAsPath } from "@/lib/sorteos/sorteo-ticket-text-path";

export type SorteoTicketRenderInput = {
  empresaNombre: string;
  sorteoNombre: string;
  clienteNombre?: string;
  documento?: string;
  telefono?: string;
  numeroOrden: string;
  cupones: string[];
  /** Ciudad/localidad del participante (modo cupon_oligroup) */
  ciudad?: string;
  /** Precio del boleto en Gs. (modo cupon_oligroup) */
  precioGs?: number | string;
  /** ISO o texto localizable */
  fechaHora: string;
  config: SorteoTicketImageConfig;
  /** bytes PNG/JPEG/WebP o null */
  logoBytes: Buffer | null;
  logoMime: string | null;
  backgroundBytes: Buffer | null;
  backgroundMime: string | null;
  /** Plantilla completa (custom_template) */
  templateBytes?: Buffer | null;
  templateMime?: string | null;
};

/** Canvas modo automático — comprobante vertical premium */
const WA = 1080;
const HA = 1350;
const PAD = 48;
const CARD_RX = 28;

function initials(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return "?";
  if (p.length === 1) return p[0]!.slice(0, 2).toUpperCase();
  return (p[0]![0]! + p[p.length - 1]![0]!).toUpperCase();
}

function dataUrlFromBuffer(buf: Buffer, mime: string): string {
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

/**
 * Muchos cupones: grilla de 3–4 columnas dentro de `avail` px de alto (sin pisar la fecha).
 * Si aun así no entran, se muestran los que caben y una línea "+N más".
 */
function cuponesGridSvg(
  cupones: string[],
  yStart: number,
  avail: number,
  primary: string,
  accent: string
): string {
  const n = cupones.length;
  /** Aire bajo el título "CUPONES" para que la primera fila no lo toque. */
  yStart += 12;
  avail -= 12;
  const cols = n <= 12 ? 3 : 4;
  let fs = cols === 3 ? 36 : 32;
  let rowH = fs + 16;
  const rowsNeeded = Math.ceil(n / cols);
  if ((rowsNeeded - 1) * rowH > avail) {
    rowH = Math.max(30, Math.floor(avail / Math.max(1, rowsNeeded - 1)));
    fs = Math.max(20, rowH - 12);
  }
  const maxRows = Math.floor(avail / rowH) + 1;
  const showAll = rowsNeeded <= maxRows;
  const maxShow = showAll ? n : cols * Math.max(1, maxRows - 1);
  const cellW = (WA - 2 * PAD) / cols;
  const out: string[] = [];
  for (let i = 0; i < Math.min(n, maxShow); i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push(
      svgTextAsPath({
        text: cupones[i]!,
        x: PAD + col * cellW + cellW / 2,
        y: yStart + row * rowH,
        fontSize: fs,
        weight: 700,
        fill: primary,
        textAnchor: "middle",
      })
    );
  }
  if (!showAll) {
    out.push(
      svgTextAsPath({
        text: `+${n - maxShow} más`,
        x: WA / 2,
        y: yStart + Math.ceil(maxShow / cols) * rowH,
        fontSize: 22,
        weight: 600,
        fill: accent,
        textAnchor: "middle",
      })
    );
  }
  return out.filter(Boolean).join("\n");
}

/** Cupón(es): tipografía grande, centrado en bloque (paths: librsvg ignora &lt;text&gt;+fuentes) */
function cuponesAutoSvg(
  cupones: string[],
  yStart: number,
  yEnd: number,
  primary: string,
  accent: string
): string {
  const cx = WA / 2;
  if (cupones.length === 0) {
    return svgTextAsPath({
      text: "—",
      x: cx,
      y: yStart,
      fontSize: 36,
      weight: 600,
      fill: accent,
      textAnchor: "middle",
    });
  }
  if (cupones.length === 1) {
    return svgTextAsPath({
      text: cupones[0]!,
      x: cx,
      y: yStart + 80,
      fontSize: 72,
      weight: 800,
      fill: primary,
      textAnchor: "middle",
    });
  }
  const lines: string[] = [];
  const fs = cupones.length <= 4 ? 56 : cupones.length <= 9 ? 40 : 32;
  const step = fs + 14;
  /** Primera línea base bajo el título "CUPONES": las letras grandes necesitan más aire. */
  let y = yStart + Math.max(0, fs - 24);
  /** Si en una columna no entran antes de la fecha del pie, se pasan a grilla. */
  const avail = Math.max(120, yEnd - yStart);
  if (y - yStart + (cupones.length - 1) * step > avail) {
    return cuponesGridSvg(cupones, yStart, avail, primary, accent);
  }
  for (const c of cupones.slice(0, 24)) {
    lines.push(
      svgTextAsPath({
        text: c,
        x: cx,
        y,
        fontSize: fs,
        weight: 700,
        fill: primary,
        textAnchor: "middle",
      })
    );
    y += step;
  }
  if (cupones.length > 24) {
    lines.push(
      svgTextAsPath({
        text: `+${cupones.length - 24} más`,
        x: cx,
        y: y + 20,
        fontSize: 22,
        weight: 600,
        fill: accent,
        textAnchor: "middle",
      })
    );
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * Modo automático: layout vertical 1080×1350.
 *
 * BANDS verticales (sin solapamiento):
 *   [   0 … 320 ]  header  → logo (240×240) + "EMPRESA" pequeño + título grande
 *   [ 340 … card ]  card de datos → labels + values bien espaciados
 *   [ post-card  ]  "CUPONES" label + número(s) grande(s)
 *   [ HA-100 …  ]  footer  → fecha + leyenda legal opcional
 *
 * El bug histórico: `cardTop = yHeader + 28` ubicaba la card ARRIBA del título.
 * Ahora hay 3 bandas con margenes calculados y la card empieza después del título.
 */
export function buildSorteoTicketSvg(input: SorteoTicketRenderInput): string {
  const cfg = input.config;
  const bg = (cfg.backgroundColor ?? "#f8fafc").trim();
  const primary = (cfg.primaryColor ?? "#0f172a").trim();
  const secondary = (cfg.secondaryColor ?? "#64748b").trim();
  const accent = (cfg.primaryColor ?? "#4FAEB2").trim();
  const title = (cfg.title ?? "Comprobante de participación").trim();
  const footer = (cfg.legalFooter ?? "").trim();

  const showLogo = cfg.showLogo !== false;
  const showNombre = cfg.showClienteNombre !== false;
  const showDoc = cfg.showDocumento !== false;
  const showTel = cfg.showTelefono !== false;
  const showOrd = cfg.showNumeroOrden !== false;
  const showCup = cfg.showCupones !== false;
  const showSorteoNom = cfg.showSorteoNombre !== false;

  // ============= BANDS =============
  // Logo: cuadrado de 220px centrado, desde y=PAD
  const LOGO_SIZE = 220;
  const logoY = PAD;
  const logoBottom = showLogo ? logoY + LOGO_SIZE : PAD;
  // "EMPRESA" sub-tag, espacio chico tras el logo
  const empresaTextY = logoBottom + 44;
  // Título principal, debajo del empresa-tag
  const titleY = empresaTextY + 56;
  // Card de datos, DESPUÉS del título con margen claro
  const CARD_TOP_MARGIN = 56;
  const cardTop = titleY + CARD_TOP_MARGIN;
  const cardW = WA - PAD * 2;
  const cardX = PAD;
  const CARD_INNER_PADX = 56;
  const ROW_HEIGHT = 92;
  const ROW_LABEL_TO_VALUE_GAP = 36;
  const CARD_TOP_INNER_PAD = 56;
  const CARD_BOTTOM_INNER_PAD = 40;

  let headerLogo = "";
  if (showLogo) {
    const logoX = (WA - LOGO_SIZE) / 2;
    if (input.logoBytes && input.logoMime) {
      const href = dataUrlFromBuffer(input.logoBytes, input.logoMime);
      headerLogo = `<image href="${href}" x="${logoX}" y="${logoY}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" preserveAspectRatio="xMidYMid meet"/>`;
    } else {
      const ini = initials(input.clienteNombre || input.empresaNombre);
      headerLogo = `<rect x="${logoX}" y="${logoY}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" rx="28" fill="#e2e8f0"/>
        ${svgTextAsPath({
          text: ini,
          x: WA / 2,
          y: logoY + LOGO_SIZE / 2 + 24,
          fontSize: 72,
          weight: 800,
          fill: "#475569",
          textAnchor: "middle",
        })}`;
    }
  }

  let bgPattern = "";
  if (input.backgroundBytes && input.backgroundMime) {
    const href = dataUrlFromBuffer(input.backgroundBytes, input.backgroundMime);
    bgPattern = `<image href="${href}" x="0" y="0" width="${WA}" height="${HA}" preserveAspectRatio="xMidYMid slice" opacity="0.10"/>`;
  }

  const rows: { label: string; value: string }[] = [];
  if (showNombre && input.clienteNombre?.trim()) {
    rows.push({ label: "Participante", value: input.clienteNombre.trim() });
  }
  if (showDoc && input.documento?.trim()) {
    rows.push({ label: "Documento", value: input.documento.trim() });
  }
  if (showTel && input.telefono?.trim()) {
    rows.push({ label: "Teléfono", value: input.telefono.trim() });
  }
  if (showOrd && String(input.numeroOrden ?? "").trim()) {
    rows.push({ label: "Nº de orden", value: String(input.numeroOrden).trim() });
  }
  if (showSorteoNom && input.sorteoNombre?.trim()) {
    rows.push({ label: "Sorteo", value: input.sorteoNombre.trim() });
  }

  // Card height: padding superior + rows + padding inferior
  const cardContentH = rows.length * ROW_HEIGHT;
  const cardH = CARD_TOP_INNER_PAD + cardContentH + CARD_BOTTOM_INNER_PAD;

  // Render filas dentro de la card
  let rowY = cardTop + CARD_TOP_INNER_PAD + 24; // baseline de la primera label
  const rowSvg = rows
    .map((r) => {
      const labelPath = svgTextAsPath({
        text: r.label.toUpperCase(),
        x: cardX + CARD_INNER_PADX,
        y: rowY,
        fontSize: 22,
        weight: 600,
        fill: secondary,
        textAnchor: "start",
      });
      const valuePath = svgTextAsPath({
        text: r.value,
        x: cardX + CARD_INNER_PADX,
        y: rowY + ROW_LABEL_TO_VALUE_GAP,
        fontSize: 32,
        weight: 700,
        fill: primary,
        textAnchor: "start",
      });
      const block = `${labelPath}\n${valuePath}`;
      rowY += ROW_HEIGHT;
      return block;
    })
    .join("\n");

  // CUPONES debajo de la card
  const CUP_TOP_MARGIN = 72;
  const cupHeaderY = cardTop + cardH + CUP_TOP_MARGIN;
  const cupones = showCup ? input.cupones.filter((c) => String(c).trim()) : [];
  const cupSvg =
    cupones.length > 0
      ? `${svgTextAsPath({
          text: "CUPONES",
          x: WA / 2,
          y: cupHeaderY,
          fontSize: 26,
          weight: 700,
          fill: accent,
          textAnchor: "middle",
        })}
${cuponesAutoSvg(
  cupones,
  cupHeaderY + 40,
  /** Última línea base permitida: por encima de la fecha (y del pie legal si hay). */
  HA - PAD - (footer ? 56 : 28) - 56,
  primary,
  secondary
)}`
      : "";

  // Línea decorativa bajo el título (separador visual)
  const dividerY = titleY + 24;
  const dividerW = 120;
  const divider = `<rect x="${(WA - dividerW) / 2}" y="${dividerY}" width="${dividerW}" height="4" rx="2" fill="${accent}" opacity="0.85"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WA}" height="${HA}" viewBox="0 0 ${WA} ${HA}">
  <defs>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="22" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="${WA}" height="${HA}" fill="${bg}"/>
  ${bgPattern}
  ${headerLogo}
  ${svgTextAsPath({
    text: (input.empresaNombre || "").toUpperCase(),
    x: WA / 2,
    y: empresaTextY,
    fontSize: 22,
    weight: 600,
    fill: secondary,
    textAnchor: "middle",
  })}
  ${svgTextAsPath({
    text: title,
    x: WA / 2,
    y: titleY,
    fontSize: 42,
    weight: 800,
    fill: primary,
    textAnchor: "middle",
  })}
  ${divider}
  <rect x="${cardX}" y="${cardTop}" width="${cardW}" height="${cardH}" rx="${CARD_RX}" fill="#ffffff" filter="url(#cardShadow)"/>
  ${rowSvg}
  ${cupSvg}
  ${svgTextAsPath({
    text: input.fechaHora,
    x: WA / 2,
    y: HA - PAD - (footer ? 56 : 28),
    fontSize: 22,
    weight: 400,
    fill: secondary,
    textAnchor: "middle",
  })}
  ${
    footer
      ? svgTextAsPath({
          text: footer,
          x: WA / 2,
          y: HA - PAD - 12,
          fontSize: 18,
          weight: 400,
          fill: secondary,
          textAnchor: "middle",
        })
      : ""
  }
</svg>`;
}

function fillAttr(color: string): string {
  const t = color.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(t) || /^#[0-9A-Fa-f]{3}$/.test(t)) return t;
  return "#111827";
}

/**
 * Plantilla personalizada: datos del cliente bajo el logo y centrados como el cupón; tamaño del cupón sin tocar.
 * Colores desde mergeCustomTemplateFields. 1–6 cupones: centrados; más de 6: grilla.
 */
function buildCustomTemplateOverlaySvg(
  w: number,
  h: number,
  input: SorteoTicketRenderInput,
  layout: ReturnType<typeof mergeCustomTemplateFields>
): string {
  const padX = Math.max(40, Math.min(layout.cliente_nombre?.x ?? 72, w * 0.2));
  const bottomPad = Math.max(36, Math.round(h * 0.028));
  /**
   * Inicio del bloque de datos (coord. Y antes del primer baseline).
   * El logo va **dentro del PNG**: sin segmentación no hay bbox; un ratio bajo
   * solapa el texto con el arte. ~39% del alto suele quedar debajo de logos grandes tipo story.
   */
  const metaTop = Math.round(h * 0.39);

  const colName = fillAttr(layout.cliente_nombre.color);
  const colDoc = fillAttr(layout.cliente_documento.color);
  const colTel = fillAttr(layout.telefono.color);
  const colOrd = fillAttr(layout.numero_orden.color);
  const colSort = fillAttr(layout.sorteo_nombre.color);
  const colCup = fillAttr(layout.cupones.color);

  const cupones = input.cupones ?? [];
  const metaGap = 14;
  const blockGap = 22;

  type MetaRow = { text: string; fs: number; color: string; weight: number };
  const buildMetaRows = (metaScale: number): MetaRow[] => {
    const r = (n: number) => Math.max(16, Math.round(n * metaScale));
    const rows: MetaRow[] = [];
    const cn = input.clienteNombre?.trim();
    if (cn) {
      rows.push({
        text: cn,
        fs: r(Math.max(layout.cliente_nombre.fontSize, 34)),
        color: colName,
        weight: 700,
      });
    }
    const doc = input.documento?.trim();
    if (doc) {
      rows.push({
        text: `Documento: ${doc}`,
        fs: r(Math.max(layout.cliente_documento.fontSize, 28)),
        color: colDoc,
        weight: 600,
      });
    }
    const tel = input.telefono?.trim();
    if (tel) {
      rows.push({
        text: `Teléfono: ${tel}`,
        fs: r(Math.max(layout.telefono.fontSize, 28)),
        color: colTel,
        weight: 600,
      });
    }
    const ord = String(input.numeroOrden ?? "").trim();
    if (ord) {
      rows.push({
        text: `Nº orden: ${ord}`,
        fs: r(Math.max(layout.numero_orden.fontSize, 34)),
        color: colOrd,
        weight: 700,
      });
    }
    const sn = input.sorteoNombre?.trim();
    if (sn) {
      rows.push({
        text: `Sorteo: ${sn}`,
        fs: r(Math.max(layout.sorteo_nombre.fontSize, 28)),
        color: colSort,
        weight: 600,
      });
    }
    return rows;
  };

  /** Altura del layout de cupones (el tamaño del número **no** usa metaScale). */
  const simulateLastCupBaseline = (yAfterMeta: number): number => {
    let y = yAfterMeta;
    if (cupones.length === 0) return y;
    if (cupones.length <= 6) {
      const fs = Math.min(
        84,
        Math.max(52, Math.round(layout.cupones.fontSize + (6 - Math.min(cupones.length, 6)) * 3))
      );
      const step = Math.round(fs * 1.2);
      for (let i = 0; i < cupones.length; i++) {
        y += step;
      }
      return y;
    }
    const cols = 3;
    const fs = 22;
    const rowH = 34;
    const maxShow = 24;
    const list = cupones.slice(0, maxShow);
    const gy = y + fs + 4;
    let maxY = gy;
    for (let i = 0; i < list.length; i++) {
      const row = Math.floor(i / cols);
      const yCell = gy + row * rowH;
      if (yCell > maxY) maxY = yCell;
    }
    if (cupones.length > maxShow) {
      maxY += Math.ceil(list.length / cols) * rowH + 8;
      maxY += 22;
    }
    return maxY;
  };

  let metaScale = 1.06;
  let metaRows = buildMetaRows(metaScale);
  for (let iter = 0; iter < 22; iter++) {
    metaRows = buildMetaRows(metaScale);
    let ySim = metaTop;
    for (const row of metaRows) {
      ySim += row.fs + metaGap;
    }
    ySim += blockGap - metaGap;
    const lastY = simulateLastCupBaseline(ySim);
    if (lastY <= h - bottomPad || metaScale <= 0.56) {
      break;
    }
    metaScale *= 0.93;
  }

  const cx = w / 2;
  const pieces: string[] = [];
  let y = metaTop;
  for (const row of metaRows) {
    y += row.fs;
    pieces.push(
      svgTextAsPath({
        text: row.text,
        x: cx,
        y,
        fontSize: row.fs,
        weight: row.weight,
        fill: fillAttr(row.color),
        textAnchor: "middle",
      })
    );
    y += metaGap;
  }
  y += blockGap - metaGap;

  if (cupones.length === 0) {
    /* Sin cupones resueltos: no dibujar placeholder */
  } else if (cupones.length <= 6) {
    const fs = Math.min(
      84,
      Math.max(52, Math.round(layout.cupones.fontSize + (6 - Math.min(cupones.length, 6)) * 3))
    );
    const step = Math.round(fs * 1.2);
    for (let i = 0; i < cupones.length; i++) {
      y += step;
      pieces.push(
        svgTextAsPath({
          text: cupones[i]!,
          x: cx,
          y,
          fontSize: fs,
          weight: 800,
          fill: colCup,
          textAnchor: "middle",
        })
      );
    }
  } else {
    const cols = 3;
    const cellW = (w - 2 * padX) / cols;
    const fs = 22;
    const rowH = 34;
    const maxShow = 24;
    const list = cupones.slice(0, maxShow);
    let gy = y + fs + 4;
    for (let i = 0; i < list.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const xCell = padX + col * cellW + cellW / 2;
      const yCell = gy + row * rowH;
      pieces.push(
        svgTextAsPath({
          text: list[i]!,
          x: xCell,
          y: yCell,
          fontSize: fs,
          weight: 700,
          fill: colCup,
          textAnchor: "middle",
        })
      );
    }
    if (cupones.length > maxShow) {
      gy += Math.ceil(list.length / cols) * rowH + 8;
      pieces.push(
        svgTextAsPath({
          text: `+${cupones.length - maxShow} más`,
          x: cx,
          y: gy,
          fontSize: 18,
          weight: 600,
          fill: colCup,
          textAnchor: "middle",
        })
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${pieces.filter(Boolean).join("\n")}
</svg>`;
}

async function renderCustomTemplateTicketPng(input: SorteoTicketRenderInput): Promise<Buffer> {
  const buf = input.templateBytes!;
  const sharpMod = (await import("sharp")).default;
  const meta = await sharpMod(buf).metadata();
  const w = meta.width && meta.width > 0 ? meta.width : input.config.custom_template_width ?? 1080;
  const h = meta.height && meta.height > 0 ? meta.height : input.config.custom_template_height ?? 1350;

  const fields = mergeCustomTemplateFields(input.config);
  const overlaySvg = buildCustomTemplateOverlaySvg(w, h, input, fields);
  const overlayPng = await sharpMod(Buffer.from(overlaySvg, "utf8")).png().toBuffer();

  const baseRgb = await sharpMod(buf)
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();

  return sharpMod(baseRgb)
    .composite([{ input: overlayPng, left: 0, top: 0, blend: "over" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function renderSorteoTicketPng(svg: string): Promise<{ png: Buffer; hash: string }> {
  const sharpMod = (await import("sharp")).default;
  const png = await sharpMod(Buffer.from(svg, "utf8")).png({ compressionLevel: 9 }).toBuffer();
  const hash = createHash("sha256").update(png).digest("hex");
  return { png, hash };
}

/** Fecha d/m/aa; si `raw` no parsea como Date, se devuelve el texto crudo. */
function formatFechaDmyShort(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const dd = d.getDate();
    const mm = d.getMonth() + 1;
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  }
  return s;
}

/** Miles con separador '.' (10000 -> "10.000"). */
function formatThousandsDot(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n));
  return sign + String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Precio en Gs formateado, o "" si falta/está vacío (línea se omite). */
function formatPrecioGs(precio: number | string | undefined): string {
  if (precio === undefined) return "";
  const raw = String(precio).trim();
  if (!raw) return "";
  const n = Number(raw);
  if (Number.isFinite(n)) return formatThousandsDot(n);
  return raw;
}

/**
 * Modo cupón OLI GROUP: comprobante vertical 1080×1350 con logo, QR, trébol y datos.
 * Todo el texto va como `<path>` (el renderer PNG/librsvg no tiene fuentes del sistema).
 */
export async function buildOligroupCuponSvg(input: SorteoTicketRenderInput): Promise<string> {
  // ===== Lienzo =====
  const W = 1080;
  const H = 1350;
  const BG = "#fefefe";
  const INK = "#111827";
  const LEFT_X = 72;

  // ===== Logo =====
  const LOGO_X = 60;
  const LOGO_Y = 70;
  const LOGO_W = 430;
  const LOGO_H = 320;

  // ===== QR =====
  const QR_X = 690;
  const QR_Y = 95;
  const QR_SIZE = 300;

  // ===== Trébol (4 hojas) =====
  const CLOVER_CX = 540;
  const CLOVER_CY = 498;
  const CLOVER_R = 17;
  const CLOVER_OFF = 14;

  // ===== Baselines de texto =====
  const Y_META = 740;
  const Y_EDICION = 820;
  const Y_NRO = 930;
  const Y_FECHA = 1040;
  const Y_PRECIO = 1090;
  const Y_GRACIAS = 1240;

  const doc = (input.documento ?? "").trim();
  const ciudad = (input.ciudad ?? "").trim();
  const tel = (input.telefono ?? "").trim();
  const sorteoNombre = (input.sorteoNombre ?? "").trim();
  const nro = String(input.cupones[0] ?? input.numeroOrden ?? "").trim();

  // Logo embebido (si hay bytes)
  let logoSvg = "";
  if (input.logoBytes && input.logoMime) {
    const href = dataUrlFromBuffer(input.logoBytes, input.logoMime);
    logoSvg = `<image href="${href}" x="${LOGO_X}" y="${LOGO_Y}" width="${LOGO_W}" height="${LOGO_H}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  // QR → data URL PNG embebido
  const qrText = input.config.qr_url?.trim() || "https://wa.me/595973733044";
  const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 1, width: QR_SIZE });
  const qrSvg = `<image href="${qrDataUrl}" x="${QR_X}" y="${QR_Y}" width="${QR_SIZE}" height="${QR_SIZE}"/>`;

  // Trébol negro de 4 hojas + tallo pequeño
  const stemTop = CLOVER_CY + CLOVER_OFF + CLOVER_R;
  const cloverSvg = `<circle cx="${CLOVER_CX}" cy="${CLOVER_CY - CLOVER_OFF}" r="${CLOVER_R}" fill="${INK}"/>
  <circle cx="${CLOVER_CX}" cy="${CLOVER_CY + CLOVER_OFF}" r="${CLOVER_R}" fill="${INK}"/>
  <circle cx="${CLOVER_CX - CLOVER_OFF}" cy="${CLOVER_CY}" r="${CLOVER_R}" fill="${INK}"/>
  <circle cx="${CLOVER_CX + CLOVER_OFF}" cy="${CLOVER_CY}" r="${CLOVER_R}" fill="${INK}"/>
  <path d="M${CLOVER_CX} ${stemTop} Q ${CLOVER_CX + 6} ${stemTop + 12} ${CLOVER_CX} ${stemTop + 22}" stroke="${INK}" stroke-width="5" fill="none"/>`;

  // Fecha d/m/aa y precio Gs
  const fecha = formatFechaDmyShort(input.fechaHora);
  const precio = formatPrecioGs(input.precioGs);

  const texts: string[] = [];
  texts.push(
    svgTextAsPath({
      text: `CI: ${doc}  |  CIUDAD: ${ciudad}  |  Cel: ${tel}`,
      x: LEFT_X,
      y: Y_META,
      fontSize: 33,
      weight: 400,
      fill: INK,
    })
  );
  texts.push(
    svgTextAsPath({
      text: `EDICIÓN: ${sorteoNombre.toUpperCase()}`,
      x: LEFT_X,
      y: Y_EDICION,
      fontSize: 34,
      weight: 600,
      fill: INK,
    })
  );
  texts.push(
    svgTextAsPath({
      text: `NRO: ${nro}`,
      x: LEFT_X,
      y: Y_NRO,
      fontSize: 92,
      weight: 800,
      fill: INK,
    })
  );
  texts.push(
    svgTextAsPath({
      text: `FECHA: ${fecha}`,
      x: LEFT_X,
      y: Y_FECHA,
      fontSize: 30,
      weight: 400,
      fill: INK,
    })
  );
  if (precio) {
    texts.push(
      svgTextAsPath({
        text: `${precio} Gs.`,
        x: LEFT_X,
        y: Y_PRECIO,
        fontSize: 30,
        weight: 400,
        fill: INK,
      })
    );
  }
  texts.push(
    svgTextAsPath({
      text: "¡Gracias por tu compra!",
      x: W / 2,
      y: Y_GRACIAS,
      fontSize: 34,
      weight: 600,
      fill: INK,
      textAnchor: "middle",
    })
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  ${logoSvg}
  ${qrSvg}
  ${cloverSvg}
  ${texts.filter(Boolean).join("\n  ")}
</svg>`;
}

/**
 * Punto único: plantilla personalizada (imagen + texto) o automático (SVG premium).
 */
export async function renderTicketPngUnified(input: SorteoTicketRenderInput): Promise<{ png: Buffer; hash: string }> {
  if (input.config.design_mode === "cupon_oligroup") {
    try {
      const svg = await buildOligroupCuponSvg(input);
      return renderSorteoTicketPng(svg);
    } catch (e) {
      console.warn("[sorteo-ticket-render] cupon_oligroup_failed_fallback_auto", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const hasTemplate =
    input.templateBytes && input.templateBytes.length > 0 && input.templateMime;
  if (hasTemplate) {
    try {
      const png = await renderCustomTemplateTicketPng(input);
      const hash = createHash("sha256").update(png).digest("hex");
      return { png, hash };
    } catch (e) {
      console.warn("[sorteo-ticket-render] custom_template_failed_fallback_auto", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const svg = buildSorteoTicketSvg(input);
  return renderSorteoTicketPng(svg);
}
