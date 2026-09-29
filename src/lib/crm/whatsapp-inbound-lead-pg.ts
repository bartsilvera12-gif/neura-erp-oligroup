/**
 * Alta de lead CRM + enlace a `chat_contacts` vía Postgres (mismo pool que webhooks YCloud).
 * Evita depender de que PostgREST exponga `crm_*` en schemas tenant (`erp_*`).
 *
 * El schema donde se insertan prospectos debe coincidir con la FK real de `chat_contacts.crm_prospecto_id`.
 */
import type { Pool } from "pg";
import { quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { SUPABASE_APP_SCHEMA } from "@/lib/supabase/schema";
import { isSingleClientMode } from "@/lib/instance/single-client";
import {
  ensureDefaultCrmEtapasForCrmSchemaClient,
  resolveCrmProspectosSchemaForTenant,
  whatsappCrmLogs,
} from "@/lib/crm/crm-prospectos-pg";
import { normalizeEtapaCodigo } from "@/lib/crm/etapas";
import { nextNumeroControlFromLast } from "@/lib/crm/numero-control";

const LOG = "[crm][whatsapp-inbound-lead-pg]";

export async function ensureWhatsappInboundCrmLeadPg(input: {
  pool: Pool;
  data_schema: string;
  empresa_id: string;
  contact_id: string;
  conversation_id: string;
  channel_id: string;
  first_message_preview: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const schema = assertAllowedChatDataSchema(input.data_schema);
  const ct = quoteSchemaTable(schema, "chat_contacts");
  const conv = quoteSchemaTable(schema, "chat_conversations");
  const ch = quoteSchemaTable(schema, "chat_channels");
  const ag = quoteSchemaTable(schema, "chat_agents");
  // `usuarios` es catálogo de identidad. En single_client fue copiado al schema
  // operativo del tenant (junto al resto del catálogo), así que vive en `schema`.
  // En multi-tenant legacy vive en `public`. Resolver schema-aware (no hardcodear).
  const usuariosTable = isSingleClientMode()
    ? quoteSchemaTable(schema, "usuarios")
    : "public.usuarios";

  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");

    const cur = await client.query(
      `SELECT id::text, crm_prospecto_id::text, phone_number::text, name::text
       FROM ${ct}
       WHERE id = $1::uuid AND empresa_id = $2::uuid
       FOR SHARE`,
      [input.contact_id, input.empresa_id]
    );
    const row0 = cur.rows[0] as
      | { id: string; crm_prospecto_id: string | null; phone_number: string | null; name: string | null }
      | undefined;
    if (!row0) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Contacto no encontrado (PG)" };
    }
    if (row0.crm_prospecto_id && String(row0.crm_prospecto_id).trim()) {
      console.info(whatsappCrmLogs.FIND, "skip_already_linked", {
        schema,
        empresa_id: input.empresa_id,
        prospecto_id: row0.crm_prospecto_id,
      });
      await client.query("COMMIT");
      return { ok: true };
    }

    const resolved = await resolveCrmProspectosSchemaForTenant(client, schema);
    if (!resolved) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error: `No hay tabla crm_prospectos resoluble para "${schema}" ni plantilla "${SUPABASE_APP_SCHEMA}"`,
      };
    }
    const crmSchema = resolved.crmSchema;

    await ensureDefaultCrmEtapasForCrmSchemaClient(client, crmSchema, input.empresa_id);

    console.info(whatsappCrmLogs.FIND, "crm_schema_resolved", {
      schema_chat: schema,
      crm_schema: crmSchema,
      empresa_id: input.empresa_id,
      resolved_via: resolved.source,
      contact_id: input.contact_id,
    });

    const ce = quoteSchemaTable(crmSchema, "crm_etapas");
    const cp = quoteSchemaTable(crmSchema, "crm_prospectos");
    const cn = quoteSchemaTable(crmSchema, "crm_notas");

    let etapaCodigo = "LEAD";
    try {
      const etRes = await client.query(
        `SELECT codigo::text AS codigo
         FROM ${ce}
         WHERE empresa_id = $1::uuid AND activo = true
         ORDER BY orden ASC NULLS LAST`,
        [input.empresa_id]
      );
      const etRows = (etRes.rows ?? []) as { codigo: string }[];
      const terminal = new Set(["GANADO", "PERDIDO"]);
      etapaCodigo =
        etRows.find((r) => r.codigo && !terminal.has(String(r.codigo).toUpperCase()))?.codigo ??
        etRows[0]?.codigo ??
        "LEAD";
      etapaCodigo = normalizeEtapaCodigo(String(etapaCodigo || "LEAD")) || "LEAD";
      console.info(whatsappCrmLogs.STAGE, "initial_etapa", {
        schema_chat: schema,
        crm_schema: crmSchema,
        empresa_id: input.empresa_id,
        etapa_codigo: etapaCodigo,
        crm_etapas_rows: etRows.length,
      });
      if (etRows.length === 0) {
        console.warn(LOG, "crm_etapas_vacío_usando_LEAD", {
          empresa_id: input.empresa_id,
          chat_schema: schema,
          crm_schema: crmSchema,
        });
      }
    } catch (e) {
      console.warn(LOG, "crm_etapas_omitido", e instanceof Error ? e.message : e);
      etapaCodigo = "LEAD";
      console.info(whatsappCrmLogs.STAGE, "fallback_LEAD", {
        schema_chat: schema,
        crm_schema: crmSchema,
        empresa_id: input.empresa_id,
        etapa_codigo: etapaCodigo,
      });
    }

    let creadoPor = "WhatsApp";
    try {
      const chRes = await client.query(
        `SELECT nombre::text AS nombre, provider::text AS provider, type::text AS type
         FROM ${ch}
         WHERE id = $1::uuid AND empresa_id = $2::uuid
         LIMIT 1`,
        [input.channel_id, input.empresa_id]
      );
      const chRow = chRes.rows[0] as { nombre?: string | null; provider?: string | null; type?: string | null } | undefined;
      const nombre = chRow?.nombre?.trim();
      creadoPor =
        nombre ||
        (String(chRow?.provider ?? "whatsapp").toLowerCase() === "ycloud"
          ? `WhatsApp (${String(chRow?.type ?? "whatsapp")}) · YCloud`
          : `WhatsApp (${String(chRow?.type ?? "whatsapp")})`);
    } catch (e) {
      console.warn(LOG, "canal_nombre_omitido", e instanceof Error ? e.message : e);
    }

    const advRes = await client.query(
      `SELECT trim(coalesce(u.nombre::text, '')) AS full_name,
              u.email::text AS email
       FROM ${conv} c
       LEFT JOIN ${ag} a ON a.id = c.assigned_agent_id AND a.empresa_id = c.empresa_id
       LEFT JOIN ${usuariosTable} u ON u.id = a.usuario_id
       WHERE c.id = $1::uuid AND c.empresa_id = $2::uuid
       LIMIT 1`,
      [input.conversation_id, input.empresa_id]
    );
    const adv = advRes.rows[0] as { full_name?: string | null; email?: string | null } | undefined;
    const responsable =
      (adv?.full_name?.trim() || adv?.email?.trim() || null) as string | null;

    const phone = String(row0.phone_number ?? "").trim();
    const displayName = String(row0.name ?? "").trim() || phone || "Contacto WhatsApp";

    const lastNum = await client.query(
      `SELECT numero_control::text AS numero_control
       FROM ${cp}
       WHERE empresa_id = $1::uuid
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1`,
      [input.empresa_id]
    );
    const numeroControl = nextNumeroControlFromLast(
      (lastNum.rows[0] as { numero_control?: string } | undefined)?.numero_control
    );

    console.info(whatsappCrmLogs.FIND, "insert_prospecto", {
      schema_chat: schema,
      crm_schema: crmSchema,
      empresa_id: input.empresa_id,
      numero_control: numeroControl,
      origen_creacion: "whatsapp",
    });

    const ins = await client.query(
      `INSERT INTO ${cp} (
         empresa_id, numero_control, empresa, contacto, email, telefono,
         servicio, valor_estimado, etapa, proxima_accion, fecha_proxima_accion,
         creado_por, origen_creacion, origen_detalle, responsable
       ) VALUES (
         $1::uuid, $2::text, $3::text, $4::text, NULL, $5::text,
         $6::text, 0, $7::text, NULL, NULL,
         $8::text, 'whatsapp', NULL, $9::text
       )
       RETURNING id::text`,
      [
        input.empresa_id,
        numeroControl,
        "WhatsApp",
        displayName,
        phone || null,
        "Consulta por WhatsApp",
        etapaCodigo,
        creadoPor,
        responsable,
      ]
    );
    const prospectoId = (ins.rows[0] as { id?: string } | undefined)?.id;
    if (!prospectoId) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Insert CRM sin id" };
    }

    console.info(whatsappCrmLogs.FIND, "created", {
      schema_chat: schema,
      crm_schema: crmSchema,
      empresa_id: input.empresa_id,
      prospecto_id: prospectoId,
    });

    const preview = input.first_message_preview?.trim();
    if (preview) {
      await client.query(
        `INSERT INTO ${cn} (empresa_id, prospecto_id, texto)
         VALUES ($1::uuid, $2::uuid, $3::text)`,
        [input.empresa_id, prospectoId, preview]
      );
    }

    await client.query(
      `UPDATE ${ct}
       SET crm_prospecto_id = $1::uuid, updated_at = now()
       WHERE id = $2::uuid AND empresa_id = $3::uuid`,
      [prospectoId, input.contact_id, input.empresa_id]
    );

    console.info(whatsappCrmLogs.LINK, "updated_chat_contact", {
      schema_chat: schema,
      empresa_id: input.empresa_id,
      prospecto_id: prospectoId,
      contact_id: input.contact_id,
    });

    await client.query("COMMIT");
    console.info(LOG, "lead_creado", {
      prospecto_id: prospectoId,
      contact_id: input.contact_id,
      chat_schema: schema,
      crm_schema: crmSchema,
    });
    return { ok: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    console.error(LOG, "error", msg);
    return { ok: false, error: msg };
  } finally {
    client.release();
  }
}
