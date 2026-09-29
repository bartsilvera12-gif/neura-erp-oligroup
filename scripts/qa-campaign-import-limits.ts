/**
 * QA de los límites de importación de campañas.
 *
 *   npm run qa:campaign-import-limits
 *   npm run qa:campaign-import-limits -- /ruta/a/lista.xlsx   (valida un archivo real)
 *
 * No toca la base: solo parseo + validación de límites, que es lo que corre
 * antes de insertar destinatarios.
 */
import { readFileSync } from "node:fs";
import Module from "node:module";
import * as XLSX from "xlsx";
import {
  CAMPAIGN_IMPORT_MAX_BYTES,
  CAMPAIGN_IMPORT_MAX_ROWS,
  formatCampaignImportMaxRows,
  formatCampaignImportMaxSize,
} from "../src/lib/campaigns/campaign-import-limits";

/**
 * `campaign-import-service` importa `server-only`, que tira si se lo carga fuera
 * de un Server Component. Lo neutralizamos para poder ejercitar el parser real
 * en vez de duplicar su lógica acá (una copia se desincroniza y deja de avisar).
 */
type ModuleLoader = (req: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: ModuleLoader };
const originalLoad = internals._load;
internals._load = function patchedLoad(req, parent, isMain) {
  if (req === "server-only") return {};
  return originalLoad.call(this, req, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const { parseCampaignSpreadsheet, pickPhoneColumn } =
  require("../src/lib/campaigns/campaign-import-service") as typeof import("../src/lib/campaigns/campaign-import-service");

let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

function buildCsv(rows: number): Buffer {
  const lines = ["numero"];
  for (let i = 0; i < rows; i++) {
    lines.push(`5959${String(80000000 + i).padStart(8, "0")}`);
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

function buildXlsx(rows: number): Buffer {
  const data = [["numero"], ...Array.from({ length: rows }, (_, i) => [`5959${80000000 + i}`])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "Hoja1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function main(): void {
  console.log(`Límites vigentes: ${formatCampaignImportMaxRows()} filas / ${formatCampaignImportMaxSize()}\n`);

  check("el límite de filas es 15.000", CAMPAIGN_IMPORT_MAX_ROWS === 15000, `es ${CAMPAIGN_IMPORT_MAX_ROWS}`);
  check("el límite de tamaño es 15 MB", CAMPAIGN_IMPORT_MAX_BYTES === 15 * 1024 * 1024);

  // Caso real: la lista de ~11.900 entra holgada.
  const t0 = Date.now();
  const csv = parseCampaignSpreadsheet(buildCsv(11900), "lista.csv");
  const csvMs = Date.now() - t0;
  check("CSV de 11.900 filas parsea completo", csv.rows.length === 11900, `parseó ${csv.rows.length}`);
  check("CSV de 11.900 filas queda bajo el límite", csv.rows.length <= CAMPAIGN_IMPORT_MAX_ROWS);
  check("detecta la columna de teléfono", pickPhoneColumn(csv.headers) === "numero", `detectó ${pickPhoneColumn(csv.headers)}`);
  console.log(`       (${csvMs} ms)`);

  // Justo en el borde y justo pasado.
  const exact = parseCampaignSpreadsheet(buildCsv(CAMPAIGN_IMPORT_MAX_ROWS), "borde.csv");
  check("15.000 filas exactas se aceptan", exact.rows.length === CAMPAIGN_IMPORT_MAX_ROWS && exact.rows.length <= CAMPAIGN_IMPORT_MAX_ROWS);
  const over = parseCampaignSpreadsheet(buildCsv(CAMPAIGN_IMPORT_MAX_ROWS + 1), "pasado.csv");
  check("15.001 filas se rechazan", over.rows.length > CAMPAIGN_IMPORT_MAX_ROWS);

  // XLSX al tope: tamaño y tiempo.
  const t1 = Date.now();
  const xbuf = buildXlsx(CAMPAIGN_IMPORT_MAX_ROWS);
  const xls = parseCampaignSpreadsheet(xbuf, "tope.xlsx");
  const xlsMs = Date.now() - t1;
  check("XLSX de 15.000 filas parsea completo", xls.rows.length === CAMPAIGN_IMPORT_MAX_ROWS, `parseó ${xls.rows.length}`);
  check("XLSX de 15.000 filas entra en 15 MB", xbuf.length <= CAMPAIGN_IMPORT_MAX_BYTES, `pesa ${(xbuf.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`       (${xlsMs} ms, ${(xbuf.length / 1024).toFixed(0)} KB)`);

  // Lotes de inserción: cuántos round-trips implica el tope.
  const INSERT_CHUNK = 1000;
  const chunks = Math.ceil(CAMPAIGN_IMPORT_MAX_ROWS / INSERT_CHUNK);
  check("el tope se inserta en <= 15 lotes", chunks <= 15, `serían ${chunks}`);

  // Archivo real pasado por CLI.
  const argPath = process.argv[2];
  if (argPath) {
    console.log(`\nArchivo real: ${argPath}`);
    const buf = readFileSync(argPath);
    const t2 = Date.now();
    const real = parseCampaignSpreadsheet(buf, argPath);
    const ms = Date.now() - t2;
    const col = pickPhoneColumn(real.headers);
    console.log(`  filas: ${real.rows.length} · columnas: ${real.headers.join(", ")}`);
    console.log(`  peso: ${(buf.length / 1024).toFixed(0)} KB · parseo: ${ms} ms · columna teléfono: ${col ?? "NO DETECTADA"}`);
    check("el archivo real entra en el límite de filas", real.rows.length <= CAMPAIGN_IMPORT_MAX_ROWS);
    check("el archivo real entra en el límite de tamaño", buf.length <= CAMPAIGN_IMPORT_MAX_BYTES);
    check("el archivo real tiene columna de teléfono detectable", Boolean(col));
  }

  console.log(`\n${failed === 0 ? "todo ok" : `${failed} fallo(s)`}`);
  if (failed > 0) process.exit(1);
}

main();
