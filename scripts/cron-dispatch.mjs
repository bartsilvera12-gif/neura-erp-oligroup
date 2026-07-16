// Disparador del cron de campañas. Lo ejecuta la Scheduled Task de Coolify
// cada minuto: `node scripts/cron-dispatch.mjs`.
//
// IMPORTANTE (gotchas aprendidos):
//  - El comando de la Scheduled Task tiene límite de 255 chars → por eso va
//    este .mjs y no un one-liner.
//  - El shell de la tarea (sh -c) rompe backticks y ${...} → acá se usa
//    CONCATENACIÓN de strings, sin template literals.
//  - Node 22 en runtime → `fetch` es global, no hace falta librería.
const port = process.env.PORT || 3000;
const secret = process.env.CRON_SECRET || "";
fetch("http://127.0.0.1:" + port + "/api/cron/campanas-dispatch", {
  method: "POST",
  headers: { authorization: "Bearer " + secret },
})
  .then(function (r) {
    return r.text();
  })
  .then(function (t) {
    console.log("[cron-dispatch] " + t);
  })
  .catch(function (e) {
    console.error(String(e));
    process.exit(1);
  });
