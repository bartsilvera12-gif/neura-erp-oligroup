/**
 * Envio directo de un mensaje libre a una lista de numeros, por la API de Meta.
 *
 * Para recuperar gente que escribio y quedo sin respuesta, SIN armar una campania.
 * Solo funciona dentro de la ventana de 24 h de WhatsApp: fuera de ella Meta
 * rechaza el texto libre y hay que usar plantilla. El script lo verifica por
 * numero y saltea a los vencidos en vez de quemar intentos.
 *
 * Uso:
 *   npx tsx scripts/send-recovery-messages.ts --schema=triple7 --file=numeros.txt
 *   npx tsx scripts/send-recovery-messages.ts --schema=triple7 --file=numeros.txt --send
 *
 * Sin `--send` no manda nada: imprime que haria (dry-run por defecto).
 *
 * Conexion: SUPABASE_DB_URL / DIRECT_URL / DATABASE_URL en .env.local.
 */
import { config } from "dotenv";
import path from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";

config({ path: path.resolve(process.cwd(), ".env.local") });

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION ?? "v19.0";
const VENTANA_HORAS = 24;
const PAUSA_MS = 1100; // ~1 msg/s, para no gatillar rate limit de Meta

const MENSAJE = `¡Hola! 👋 Ayer nos escribiste por el sorteo de la S10 4x4 y no llegamos a responderte a tiempo. Mil disculpas 🙏

Tu lugar sigue disponible. Escribí *Participar* y te paso los números al toque 🎟️`;

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const FLAG_SEND = process.argv.includes("--send");

const schema = (arg("schema") ?? "").trim();
const file = (arg("file") ?? "").trim();
const channelArg = (arg("channel") ?? "").trim();

if (!schema || !file) {
  console.error("Uso: npx tsx scripts/send-recovery-messages.ts --schema=<schema> --file=<archivo> [--channel=<uuid>] [--send]");
  process.exit(2);
}
if (!/^[a-z0-9_]+$/i.test(schema)) {
  console.error(`Schema invalido: ${schema}`);
  process.exit(2);
}

const FLAG_PARSE_ONLY = process.argv.includes("--parse-only");

const url =
  process.env.SUPABASE_DB_URL?.trim() ||
  process.env.DIRECT_URL?.trim() ||
  process.env.DATABASE_URL?.trim();
if (!url && !FLAG_PARSE_ONLY) {
  console.error("Falta SUPABASE_DB_URL / DIRECT_URL / DATABASE_URL en .env.local");
  process.exit(2);
}

function soloDigitos(s: string): string {
  return s.replace(/\D/g, "");
}

function leerNumeros(p: string): string[] {
  const txt = readFileSync(p, "utf8").replace(/^﻿/, "");
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const linea of txt.split(/\r?\n/)) {
    const primera = linea.split(",")[0]?.trim() ?? "";
    if (!primera || /^numero$/i.test(primera) || /^#$/.test(primera)) continue;
    const d = soloDigitos(primera);
    if (d.length < 8) continue;
    if (vistos.has(d)) continue;
    vistos.add(d);
    out.push(d);
  }
  return out;
}

type Envio = {
  digits: string;
  conversationId: string | null;
  empresaId: string | null;
  ultimoEntrante: Date | null;
};

async function main(): Promise<void> {
  const numeros = leerNumeros(file);
  if (numeros.length === 0) {
    console.error("El archivo no tiene numeros validos.");
    process.exit(2);
  }
  console.log(`Numeros a procesar: ${numeros.length}`);
  if (FLAG_PARSE_ONLY) {
    for (const d of numeros) console.log(`  +${d}`);
    console.log(`\n--- mensaje que se enviaria ---\n${MENSAJE}\n---`);
    return;
  }
  console.log(FLAG_SEND ? "MODO: ENVIO REAL\n" : "MODO: simulacion (agrega --send para mandar de verdad)\n");

  const client = new pg.Client({
    connectionString: url,
    ssl: url!.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    const canalSql = channelArg
      ? `SELECT id, empresa_id, meta_phone_number_id, whatsapp_access_token
           FROM ${schema}.chat_channels WHERE id = $1::uuid LIMIT 1`
      : `SELECT id, empresa_id, meta_phone_number_id, whatsapp_access_token
           FROM ${schema}.chat_channels
          WHERE activo IS TRUE
            AND meta_phone_number_id IS NOT NULL
            AND whatsapp_access_token IS NOT NULL
          ORDER BY updated_at DESC NULLS LAST LIMIT 1`;
    const canalRes = channelArg ? await client.query(canalSql, [channelArg]) : await client.query(canalSql);
    const canal = canalRes.rows[0];
    if (!canal?.meta_phone_number_id || !canal?.whatsapp_access_token) {
      console.error("No se encontro un canal activo con phone_number_id y token. Pasa --channel=<uuid>.");
      process.exit(1);
    }
    console.log(`Canal: ${canal.id} (phone_number_id ${canal.meta_phone_number_id})\n`);

    // Ventana de 24 h + conversacion, en una sola consulta.
    const infoRes = await client.query(
      `SELECT regexp_replace(ct.phone_number, '\\D', '', 'g') AS digits,
              cv.id AS conversation_id,
              cv.empresa_id,
              MAX(m.created_at) FILTER (WHERE NOT m.from_me) AS ultimo_entrante
         FROM ${schema}.chat_contacts ct
         JOIN ${schema}.chat_conversations cv
           ON cv.contact_id = ct.id AND cv.channel_id = $1::uuid
         LEFT JOIN ${schema}.chat_messages m ON m.conversation_id = cv.id
        WHERE regexp_replace(ct.phone_number, '\\D', '', 'g') = ANY($2::text[])
        GROUP BY 1, 2, 3`,
      [canal.id, numeros]
    );
    const porNumero = new Map<string, Envio>();
    for (const r of infoRes.rows) {
      porNumero.set(r.digits, {
        digits: r.digits,
        conversationId: r.conversation_id,
        empresaId: r.empresa_id,
        ultimoEntrante: r.ultimo_entrante ? new Date(r.ultimo_entrante) : null,
      });
    }

    const ahora = Date.now();
    let enviados = 0, saltados = 0, fallidos = 0;

    for (const d of numeros) {
      const info = porNumero.get(d);
      const ultimo = info?.ultimoEntrante ?? null;
      const horas = ultimo ? (ahora - ultimo.getTime()) / 3_600_000 : Infinity;

      if (!ultimo) {
        console.log(`  SALTEADO  +${d}  sin mensajes entrantes registrados (no hay ventana abierta)`);
        saltados += 1;
        continue;
      }
      if (horas >= VENTANA_HORAS) {
        console.log(`  SALTEADO  +${d}  ventana vencida (escribio hace ${horas.toFixed(1)} h) → solo plantilla`);
        saltados += 1;
        continue;
      }

      const restante = (VENTANA_HORAS - horas).toFixed(1);
      if (!FLAG_SEND) {
        console.log(`  (simulado) +${d}  ventana abierta, quedan ${restante} h`);
        enviados += 1;
        continue;
      }

      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${canal.meta_phone_number_id}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${canal.whatsapp_access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: d,
            type: "text",
            text: { body: MENSAJE },
          }),
        }
      );
      const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        const err = (raw.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
        console.error(`  ERROR     +${d}  ${err}`);
        fallidos += 1;
      } else {
        const waId = (raw.messages as Array<{ id?: string }> | undefined)?.[0]?.id ?? null;
        console.log(`  enviado   +${d}  ${waId ?? "(sin id)"}  (quedaban ${restante} h)`);
        enviados += 1;

        /**
         * Se registra como `system` y no como `human` a proposito: asi la opcion
         * "despertar el bot con cualquier mensaje" sigue tomando la conversacion
         * cuando la persona responda. Con `human` el bot la daria por atendida.
         */
        if (info?.conversationId && info.empresaId) {
          await client.query(
            `INSERT INTO ${schema}.chat_messages
               (empresa_id, conversation_id, wa_message_id, from_me, message_type, content, sender_type, raw_payload, created_at)
             VALUES ($1::uuid, $2::uuid, $3, TRUE, 'text', $4, 'system', '{}'::jsonb, now())
             ON CONFLICT DO NOTHING`,
            [info.empresaId, info.conversationId, waId, MENSAJE]
          );
        }
      }

      await new Promise((r) => setTimeout(r, PAUSA_MS));
    }

    console.log(`\nResumen: ${enviados} ${FLAG_SEND ? "enviados" : "a enviar"} · ${saltados} salteados · ${fallidos} con error`);
    if (!FLAG_SEND) console.log("Nada fue enviado. Agrega --send para mandar de verdad.");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
