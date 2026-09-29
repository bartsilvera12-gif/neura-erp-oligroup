import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { describeUpstreamError } from "@/lib/api/upstream-error";
import { requireCampanasApiAccess } from "@/lib/campaigns/campaign-auth";
import {
  applyHeaderImageSendConfigUpdate,
  resolveHeaderImageUrlForCampaign,
  templateSnapshotHasHeaderImage,
} from "@/lib/campaigns/campaign-header-image";
import {
  buildMappedVariablesFromRow,
  formatMissingMappingMessage,
  formatMissingValueMessage,
  listSlotsMissingFromMapping,
  listSlotsWithEmptyMappedValues,
  mappingSatisfiedForTemplate,
  normalizeVariableMapping,
  variableMappingCoversTemplate,
} from "@/lib/campaigns/campaign-mapping";
import { extractBodyPlaceholderKeysOrdered } from "@/lib/campaigns/campaign-template-payload";

type RouteCtx = { params: Promise<{ id: string }> };

/** Validar ~12.000 destinatarios tarda más que el default de 15 s de algunos runtimes. */
export const maxDuration = 120;

export async function POST(request: NextRequest, ctx: RouteCtx) {
  const auth = await requireCampanasApiAccess(request);
  if (!auth.ok) {
    return NextResponse.json(errorResponse(auth.message), { status: auth.status });
  }

  const { id: campaignId } = await ctx.params;

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const sb = await getChatServiceClientForEmpresa(auth.empresaId);

    const { data: campaign, error: cErr } = await sb
      .from("chat_campaigns")
      .select("variable_mapping_json, template_components_json, status, send_config_json")
      .eq("id", campaignId)
      .eq("empresa_id", auth.empresaId)
      .maybeSingle();

    if (cErr || !campaign) {
      return NextResponse.json(errorResponse("Campaña no encontrada"), { status: 404 });
    }

    const mapping =
      body.variable_mapping_json && typeof body.variable_mapping_json === "object"
        ? normalizeVariableMapping(body.variable_mapping_json as Record<string, unknown>)
        : normalizeVariableMapping(
            ((campaign as { variable_mapping_json?: unknown }).variable_mapping_json ?? {}) as Record<
              string,
              unknown
            >
          );

    if (Object.keys(mapping).length > 0) {
      await sb
        .from("chat_campaigns")
        .update({
          variable_mapping_json: mapping,
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaignId)
        .eq("empresa_id", auth.empresaId);
    }

    const tplComponents = (campaign as { template_components_json?: unknown }).template_components_json ?? [];
    const requiredSlots = extractBodyPlaceholderKeysOrdered(tplComponents as unknown[]);

    const { data: recipients, error: rErr } = await sb
      .from("chat_campaign_recipients")
      .select("id, row_payload_json, status")
      .eq("campaign_id", campaignId)
      .eq("empresa_id", auth.empresaId);

    if (rErr) {
      return NextResponse.json(errorResponse(rErr.message), { status: 400 });
    }

    let mappingErrors = 0;
    const ts = new Date().toISOString();

    const mappingDefinitionIncomplete =
      requiredSlots.length > 0 &&
      (Object.keys(mapping).length === 0 || !variableMappingCoversTemplate(mapping, tplComponents as unknown[]));

    const missingMappingSlots = listSlotsMissingFromMapping(mapping, tplComponents as unknown[]);
    const mappingDefinitionMessage =
      requiredSlots.length > 0 && Object.keys(mapping).length === 0
        ? "La plantilla tiene variables: definí el mapeo desde cada {{variable}} hacia una columna del Excel."
        : missingMappingSlots.map(formatMissingMappingMessage).join(" ");

    /**
     * Antes esto hacía un UPDATE por destinatario, secuencial: con ~12.000 filas
     * son ~12.000 round-trips y la validación no terminaba nunca.
     *
     * Ahora agrupamos por patch idéntico y mandamos un UPDATE ... IN (...) por
     * grupo. Cuando la plantilla no tiene variables todas las filas comparten el
     * mismo patch, así que es un puñado de queries en vez de miles. Con variables
     * el beneficio depende de cuánto se repitan los valores.
     */
    const updateGroups = new Map<string, { patch: Record<string, unknown>; ids: string[] }>();

    const queueUpdate = (id: string, patch: Record<string, unknown>): void => {
      const key = JSON.stringify(patch);
      const g = updateGroups.get(key);
      if (g) {
        g.ids.push(id);
        return;
      }
      updateGroups.set(key, { patch, ids: [id] });
    };

    for (const rec of recipients ?? []) {
      const row = rec as {
        id: string;
        row_payload_json: Record<string, string>;
        status: string;
      };
      if (row.status === "invalid") continue;

      if (mappingDefinitionIncomplete) {
        mappingErrors += 1;
        queueUpdate(row.id, {
          status: "pending",
          mapped_variables_json: {},
          validation_error: mappingDefinitionMessage || "Mapeo de variables incompleto",
          updated_at: ts,
        });
        continue;
      }

      const payload = (row.row_payload_json ?? {}) as Record<string, string>;
      const mapped = buildMappedVariablesFromRow(payload, mapping);

      const okMap = mappingSatisfiedForTemplate(tplComponents as unknown[], mapped);

      if (!okMap) {
        mappingErrors += 1;
        const emptySlots = listSlotsWithEmptyMappedValues(mapped, tplComponents as unknown[]);
        const errMsg = emptySlots.map(formatMissingValueMessage).join(" ");
        queueUpdate(row.id, {
          status: "pending",
          mapped_variables_json: mapped,
          validation_error: errMsg || "Faltan variables de plantilla",
          updated_at: ts,
        });
        continue;
      }

      queueUpdate(row.id, {
        mapped_variables_json: mapped,
        validation_error: null,
        status: "pending",
        updated_at: ts,
      });
    }

    /**
     * `UPDATE ... IN (...)` manda los ids en la QUERY STRING, no en el body: con
     * 500 UUIDs la URL pasa los 18 KB y Cloudflare/nginx la cortan (se veía como
     * un 520 con una página HTML de error). 100 ids son ~3,7 KB, bien por debajo
     * del límite habitual de 8 KB.
     */
    const UPDATE_CHUNK = 100;
    for (const { patch, ids } of updateGroups.values()) {
      for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
        const chunk = ids.slice(i, i + UPDATE_CHUNK);
        const { error: updErr } = await sb
          .from("chat_campaign_recipients")
          .update(patch)
          .in("id", chunk)
          .eq("empresa_id", auth.empresaId);
        if (updErr) {
          console.error("[campanas][validate] update_chunk_failed", {
            campaign_id: campaignId,
            group_size: ids.length,
            chunk_start: i,
            error: updErr.message,
          });
          return NextResponse.json(
            errorResponse(`No se pudo validar la lista completa. ${describeUpstreamError(updErr.message)}`),
            { status: 400 }
          );
        }
      }
    }

    const headerResolution = resolveHeaderImageUrlForCampaign({
      templateComponentsJson: tplComponents,
      sendConfigJson: (campaign as { send_config_json?: unknown }).send_config_json,
      recipients: (recipients ?? []) as Array<{ status: string; row_payload_json: unknown }>,
    });
    const sendConfigAfterHeader = applyHeaderImageSendConfigUpdate(
      (campaign as { send_config_json?: unknown }).send_config_json,
      headerResolution
    );

    const needsHeader = templateSnapshotHasHeaderImage(tplComponents);
    const headerBlocked = needsHeader && !headerResolution.ok;

    await sb
      .from("chat_campaigns")
      .update({
        status: mappingErrors > 0 || headerBlocked ? "draft" : "ready",
        send_config_json: sendConfigAfterHeader,
        updated_at: ts,
      })
      .eq("id", campaignId)
      .eq("empresa_id", auth.empresaId);

    await sb.from("chat_campaign_events").insert({
      empresa_id: auth.empresaId,
      campaign_id: campaignId,
      recipient_id: null,
      event_type: "import_validated",
      event_payload_json: {
        mapping_errors: mappingErrors,
        header_image_ok: needsHeader ? headerResolution.ok : null,
      },
    });

    const ready = mappingErrors === 0 && !headerBlocked;
    return NextResponse.json(
      successResponse({
        mapping_errors: mappingErrors,
        ready,
        header_image_ok: !needsHeader || headerResolution.ok,
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
