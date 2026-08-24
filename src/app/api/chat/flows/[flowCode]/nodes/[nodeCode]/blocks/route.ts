import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getAuthWithRol } from "@/lib/middleware/auth";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

async function resolveNodeId(
  supabase: AppSupabaseClient,
  empresaId: string,
  flowCode: string,
  nodeCode: string
): Promise<{ id?: string; lookupError?: string }> {
  const { data, error } = await supabase
    .from("chat_flow_nodes")
    .select("id")
    .eq("empresa_id", empresaId)
    .eq("flow_code", flowCode)
    .eq("node_code", nodeCode)
    .maybeSingle();
  if (error) return { lookupError: error.message };
  return { id: data?.id as string | undefined };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ flowCode: string; nodeCode: string }> }
) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const params = await context.params;
    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    const { id: nodeId, lookupError } = await resolveNodeId(
      supabase,
      auth.empresa_id,
      params.flowCode,
      params.nodeCode
    );
    if (lookupError) {
      return NextResponse.json({ ok: false, error: lookupError }, { status: 400 });
    }
    if (!nodeId) return NextResponse.json({ ok: false, error: "Nodo no encontrado" }, { status: 404 });

    const { data, error } = await supabase
      .from("chat_flow_node_blocks")
      .select("id, node_id, block_type, content_text, media_url, sort_order, created_at")
      .eq("empresa_id", auth.empresa_id)
      .eq("node_id", nodeId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, items: data ?? [] });
  } catch (e) {
    console.error("[api/chat/flows/:flowCode/nodes/:nodeCode/blocks][GET]", e);
    const message = e instanceof Error ? e.message : "Error interno";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ flowCode: string; nodeCode: string }> }
) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const params = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      block_type?: string;
      content_text?: string | null;
      media_url?: string | null;
      sort_order?: number;
    };
    const blockType = (body.block_type ?? "").trim();
    if (!["text", "image", "video", "buttons"].includes(blockType)) {
      return NextResponse.json({ ok: false, error: "block_type inválido" }, { status: 400 });
    }
    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    if (blockType === "image" || blockType === "video") {
      const kindLabel = blockType === "video" ? "video" : "imagen";
      const mediaUrl = (body.media_url ?? "").trim();
      if (mediaUrl && !isValidHttpUrl(mediaUrl)) {
        return NextResponse.json({ ok: false, error: `media_url de ${kindLabel} debe ser URL http/https válida` }, { status: 400 });
      }
      const caption = (body.content_text ?? "").trim();
      if (caption.length > 1024) {
        return NextResponse.json({ ok: false, error: "Caption excede 1024 caracteres" }, { status: 400 });
      }
    }
    const { id: nodeId, lookupError } = await resolveNodeId(
      supabase,
      auth.empresa_id,
      params.flowCode,
      params.nodeCode
    );
    if (lookupError) {
      return NextResponse.json({ ok: false, error: lookupError }, { status: 400 });
    }
    if (!nodeId) return NextResponse.json({ ok: false, error: "Nodo no encontrado" }, { status: 404 });

    const { data, error } = await supabase
      .from("chat_flow_node_blocks")
      .insert({
        empresa_id: auth.empresa_id,
        node_id: nodeId,
        block_type: blockType,
        content_text: body.content_text ?? null,
        media_url: body.media_url ?? null,
        sort_order: Number.isFinite(body.sort_order) ? Math.trunc(body.sort_order as number) : 0,
      })
      .select("id, node_id, block_type, content_text, media_url, sort_order, created_at")
      .single();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, item: data });
  } catch (e) {
    console.error("[api/chat/flows/:flowCode/nodes/:nodeCode/blocks][POST]", e);
    const message = e instanceof Error ? e.message : "Error interno";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
