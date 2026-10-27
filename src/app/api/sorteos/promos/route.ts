import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  buildPromoOptionPayload,
  readPromoFromOption,
  optionHasPromoVentana,
  buildUniqueMetaButtonId,
} from "@/lib/sorteos/promo-option-payload";

export const dynamic = "force-dynamic";

type OptionRow = {
  id: string;
  label: string | null;
  option_value: string | null;
  meta_button_id: string | null;
  next_node_code: string | null;
  sort_order: number | null;
  option_payload: Record<string, unknown> | null;
};

type ComboNode = {
  nodeId: string;
  nodeCode: string;
  flowCode: string;
  options: OptionRow[];
};

type SbClient = Awaited<ReturnType<typeof getChatServiceClientForEmpresa>>;

/** Opción que define un combo (tiene `cantidad` en el payload). */
function optionIsCombo(o: OptionRow): boolean {
  const p = o.option_payload;
  return !!p && typeof p === "object" && p.cantidad != null;
}

/**
 * Resuelve el flujo activo canónico y el nodo de combos (el nodo buttons/list con más opciones
 * que definen cantidad). Devuelve null si no hay flujo activo o no se detecta un nodo de combos.
 */
async function resolveComboNode(
  sb: SbClient,
  empresaId: string
): Promise<ComboNode | null> {
  const { data: flows, error: fErr } = await sb
    .from("chat_flows")
    .select("flow_code")
    .eq("empresa_id", empresaId)
    .eq("activo", true)
    .order("flow_code", { ascending: true });
  if (fErr) throw new Error(fErr.message);

  const flowCodes = ((flows ?? []) as Array<{ flow_code?: unknown }>)
    .map((f) => String(f.flow_code ?? "").trim())
    .filter(Boolean);
  if (flowCodes.length === 0) return null;
  const flowCode = flowCodes[0];

  const { data: nodos, error: nErr } = await sb
    .from("chat_flow_nodes")
    .select("id, node_code")
    .eq("empresa_id", empresaId)
    .eq("flow_code", flowCode)
    .eq("is_active", true)
    .in("node_type", ["buttons", "list"]);
  if (nErr) throw new Error(nErr.message);

  const nodes = ((nodos ?? []) as Array<{ id?: unknown; node_code?: unknown }>)
    .map((n) => ({ id: String(n.id ?? ""), node_code: String(n.node_code ?? "") }))
    .filter((n) => n.id);
  if (nodes.length === 0) return null;

  const { data: opc, error: oErr } = await sb
    .from("chat_flow_options")
    .select("id, node_id, label, option_value, meta_button_id, next_node_code, sort_order, option_payload")
    .in(
      "node_id",
      nodes.map((n) => n.id)
    )
    .order("sort_order", { ascending: true });
  if (oErr) throw new Error(oErr.message);

  const byNode = new Map<string, OptionRow[]>();
  for (const raw of (opc ?? []) as Array<Record<string, unknown>>) {
    const nodeId = String(raw.node_id ?? "");
    if (!nodeId) continue;
    const row: OptionRow = {
      id: String(raw.id ?? ""),
      label: (raw.label as string | null) ?? null,
      option_value: (raw.option_value as string | null) ?? null,
      meta_button_id: (raw.meta_button_id as string | null) ?? null,
      next_node_code: (raw.next_node_code as string | null) ?? null,
      sort_order: (raw.sort_order as number | null) ?? 0,
      option_payload: (raw.option_payload as Record<string, unknown> | null) ?? null,
    };
    const arr = byNode.get(nodeId) ?? [];
    arr.push(row);
    byNode.set(nodeId, arr);
  }

  // Nodo de combos = el que tiene más opciones con cantidad definida.
  let best: ComboNode | null = null;
  let bestCount = -1;
  for (const n of nodes) {
    const options = byNode.get(n.id) ?? [];
    const comboCount = options.filter(optionIsCombo).length;
    if (comboCount > bestCount) {
      bestCount = comboCount;
      best = { nodeId: n.id, nodeCode: n.node_code, flowCode, options };
    }
  }
  if (!best || bestCount <= 0) return null;
  return best;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const sb = await getChatServiceClientForEmpresa(auth.empresa_id);
    const combo = await resolveComboNode(sb, auth.empresa_id);
    if (!combo) {
      return NextResponse.json(
        successResponse({
          flow_code: null,
          node_code: null,
          promos: [],
          normales_count: 0,
          detectado: false,
        })
      );
    }

    const promos = combo.options.filter((o) => optionHasPromoVentana(o.option_payload));
    const normales = combo.options.filter((o) => !optionHasPromoVentana(o.option_payload));

    return NextResponse.json(
      successResponse({
        flow_code: combo.flowCode,
        node_code: combo.nodeCode,
        detectado: true,
        normales_count: normales.length,
        promos: promos.map((o) => readPromoFromOption(o)),
      })
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

type PostBody = {
  optionId?: string;
  label?: string;
  cantidad?: number;
  monto?: number;
  dias?: number[];
  hora_inicio?: string;
  duracion_horas?: number;
  activa?: boolean;
};

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as PostBody;

    const label = (body.label ?? "").trim();
    const cantidad = Math.trunc(Number(body.cantidad));
    const monto = Math.round(Number(body.monto));
    const dias = Array.isArray(body.dias) ? body.dias : [];
    const horaInicio = (body.hora_inicio ?? "").trim();
    const duracionHoras = Number(body.duracion_horas);
    const activa = body.activa !== false;

    if (!label) return NextResponse.json(errorResponse("Falta el texto del botón"), { status: 400 });
    if (!Number.isFinite(cantidad) || cantidad < 1)
      return NextResponse.json(errorResponse("La cantidad debe ser mayor a 0"), { status: 400 });
    if (!Number.isFinite(monto) || monto <= 0)
      return NextResponse.json(errorResponse("El monto debe ser mayor a 0"), { status: 400 });
    if (dias.filter((d) => d >= 1 && d <= 7).length === 0)
      return NextResponse.json(errorResponse("Elegí al menos un día"), { status: 400 });
    if (!/^\d{1,2}:\d{2}$/.test(horaInicio))
      return NextResponse.json(errorResponse("Hora de inicio inválida (HH:MM)"), { status: 400 });

    const sb = await getChatServiceClientForEmpresa(auth.empresa_id);
    const combo = await resolveComboNode(sb, auth.empresa_id);
    if (!combo) {
      return NextResponse.json(
        errorResponse(
          "No encontré el paso de combos en el flujo. Creá primero un combo normal (ej. '1 boleta') en el flujo de WhatsApp."
        ),
        { status: 400 }
      );
    }

    const optionId = (body.optionId ?? "").trim();

    if (optionId) {
      // Editar una promo existente (solo si pertenece al nodo de combos detectado).
      const target = combo.options.find((o) => o.id === optionId);
      if (!target) {
        return NextResponse.json(errorResponse("Promo no encontrada"), { status: 404 });
      }
      const payload = buildPromoOptionPayload(
        { cantidad, monto, promoNombre: label, dias, horaInicio, duracionHoras, activa },
        target.option_payload
      );
      const { data, error } = await sb
        .from("chat_flow_options")
        .update({ label, option_payload: payload })
        .eq("id", optionId)
        .select("id, label, option_payload")
        .maybeSingle();
      if (error) return NextResponse.json(errorResponse(error.message), { status: 400 });
      return NextResponse.json(successResponse({ item: data }));
    }

    // Crear una promo nueva: clona el routing de un combo existente.
    const routingSource = combo.options.find((o) => (o.next_node_code ?? "").trim());
    const nextNodeCode = routingSource?.next_node_code?.trim() || null;
    if (!nextNodeCode) {
      return NextResponse.json(
        errorResponse(
          "El paso de combos no tiene 'Siguiente paso' configurado. Configurá una vez el circuito de compra en el flujo y volvé a intentar."
        ),
        { status: 400 }
      );
    }

    const used = new Set(
      combo.options.map((o) => (o.meta_button_id ?? "").trim()).filter(Boolean)
    );
    const metaButtonId = buildUniqueMetaButtonId(label, used);
    const maxSort = combo.options.reduce((m, o) => Math.max(m, o.sort_order ?? 0), 0);
    const payload = buildPromoOptionPayload(
      { cantidad, monto, promoNombre: label, dias, horaInicio, duracionHoras, activa }
    );

    const { data, error } = await sb
      .from("chat_flow_options")
      .insert({
        node_id: combo.nodeId,
        label,
        option_value: metaButtonId,
        meta_button_id: metaButtonId,
        next_node_code: nextNodeCode,
        sort_order: maxSort + 1,
        option_payload: payload,
      })
      .select("id, label, option_payload")
      .single();
    if (error) return NextResponse.json(errorResponse(error.message), { status: 400 });
    return NextResponse.json(successResponse({ item: data }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const optionId = (new URL(request.url).searchParams.get("optionId") ?? "").trim();
    if (!optionId) {
      return NextResponse.json(errorResponse("Falta optionId"), { status: 400 });
    }
    const sb = await getChatServiceClientForEmpresa(auth.empresa_id);
    const combo = await resolveComboNode(sb, auth.empresa_id);
    // Solo se puede borrar una promo que vive en el nodo de combos detectado.
    const target = combo?.options.find((o) => o.id === optionId);
    if (!target) {
      return NextResponse.json(errorResponse("Promo no encontrada"), { status: 404 });
    }
    if (!optionHasPromoVentana(target.option_payload)) {
      return NextResponse.json(
        errorResponse("Esa opción no es una promo con horario; editala desde el flujo."),
        { status: 400 }
      );
    }
    const { error } = await sb.from("chat_flow_options").delete().eq("id", optionId);
    if (error) return NextResponse.json(errorResponse(error.message), { status: 400 });
    return NextResponse.json(successResponse({ ok: true }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
