import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { buildManualPromos, type FlowOptionRow } from "@/lib/sorteos/manual-promos";

export const dynamic = "force-dynamic";

/**
 * GET /api/sorteos/manual-promos — promos de venta que ofrece el bot.
 *
 * Fuente de verdad: las opciones (`chat_flow_options`) de los nodos activos del flujo de
 * WhatsApp de la empresa, que son los botones que ve el cliente en el chat. Así el vendedor
 * presencial cobra exactamente lo mismo que el bot, sin tipear cantidad y monto a mano.
 *
 * Si el flujo no tiene promos cargadas devuelve una lista vacía: la pantalla cae a carga
 * manual de cantidad y monto.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const sb = await getChatServiceClientForEmpresa(empresaId);

    /** Nodos interactivos activos de la empresa: de ahí cuelgan los botones con las promos. */
    const { data: nodos, error: errNodos } = await sb
      .from("chat_flow_nodes")
      .select("id, node_type, is_active")
      .eq("empresa_id", empresaId)
      .eq("is_active", true)
      .in("node_type", ["buttons", "list"]);

    if (errNodos) {
      return NextResponse.json(errorResponse(errNodos.message), { status: 400 });
    }

    const nodeIds = ((nodos ?? []) as Array<{ id?: unknown }>)
      .map((n) => String(n.id ?? ""))
      .filter((id) => id.length > 0);

    if (nodeIds.length === 0) {
      return NextResponse.json(successResponse([]));
    }

    const { data: opciones, error: errOpc } = await sb
      .from("chat_flow_options")
      .select("id, label, option_value, sort_order, option_payload")
      .in("node_id", nodeIds)
      .order("sort_order", { ascending: true });

    if (errOpc) {
      return NextResponse.json(errorResponse(errOpc.message), { status: 400 });
    }

    return NextResponse.json(successResponse(buildManualPromos((opciones ?? []) as FlowOptionRow[])));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
