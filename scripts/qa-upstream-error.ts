/**
 * QA de `describeUpstreamError`: los errores del backend no deben llegar crudos
 * al cartel de la UI cuando son una página HTML (Cloudflare 520 y similares).
 *
 *   npm run qa:upstream-error
 */
import { describeUpstreamError, looksLikeHtmlErrorPage } from "../src/lib/api/upstream-error";

const CLOUDFLARE_520 =
  '<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->' +
  '<head> <title>neura.com.py | 520: Web server is returning an unknown error</title>' +
  '<span class="code-label">Error code 520</span> There is an unknown connection issue between ' +
  "Cloudflare and the origin web server.".repeat(20);

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

const out = describeUpstreamError(CLOUDFLARE_520);
check("detecta una página HTML", looksLikeHtmlErrorPage(CLOUDFLARE_520));
check("no filtra el HTML al mensaje", !out.includes("<") && !out.includes("DOCTYPE"), `salió: ${out}`);
check("nombra el código 520", out.includes("520"), `salió: ${out}`);
check("el mensaje es corto", out.length <= 300, `largo ${out.length}`);
console.log(`       → "${out}"`);

const pg = 'duplicate key value violates unique constraint "uq_ccba_campaign_button"';
check("un error normal de Postgres pasa tal cual", describeUpstreamError(pg) === pg);

const largo = "x".repeat(500);
check("un error larguísimo se recorta", describeUpstreamError(largo).length <= 301);
check("vacío da un mensaje genérico", describeUpstreamError("").length > 0);
check("null da un mensaje genérico", describeUpstreamError(null).length > 0);
check("no marca como HTML un texto que menciona <html>", !looksLikeHtmlErrorPage("el valor contiene <html-ish> texto"));

console.log(`\n${failed === 0 ? "todo ok" : `${failed} fallo(s)`}`);
if (failed > 0) process.exit(1);
