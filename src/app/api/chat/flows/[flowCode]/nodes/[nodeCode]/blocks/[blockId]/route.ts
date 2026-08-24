import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getAuthWithRol } from "@/lib/middleware/auth";

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ flowCode: string; nodeCode: string; blockId: string }> }
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
    const patch: Record<string, unknown> = {};
    if (typeof body.block_type === "string" && ["text", "image", "video", "buttons"].includes(body.block_type)) {
      patch.block_type = body.block_type;
    }
    if ("content_text" in body) patch.content_text = body.content_text ?? null;
    if ("media_url" in body) {
      const mediaUrl = body.media_url?.trim() ?? "";
      patch.media_url = mediaUrl || null;
    }
    if (typeof body.sort_order === "number" && Number.isFinite(body.sort_order)) {
      patch.sort_order = Math.trunc(body.sort_order);
    }

    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    const { data: current, error: cErr } = await supabase
      .from("chat_flow_node_blocks")
      .select("block_type")
      .eq("id", params.blockId)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();
    if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 400 });
    if (!current) return NextResponse.json({ ok: false, error: "Bloque no encontrado" }, { status: 404 });

    const effectiveType =
      (typeof patch.block_type === "string" ? patch.block_type : (current.block_type as string)) || "text";
    if (effectiveType === "image" || effectiveType === "video") {
      const kindLabel = effectiveType === "video" ? "video" : "imagen";
      const mediaUrl = (patch.media_url as string | null | undefined)?.trim() ?? "";
      if (mediaUrl && !isValidHttpUrl(mediaUrl)) {
        return NextResponse.json(
          { ok: false, error: `media_url de ${kindLabel} debe ser URL http/https válida` },
          { status: 400 }
        );
      }
      const caption = (patch.content_text as string | null | undefined)?.trim() ?? "";
      if (caption.length > 1024) {
        return NextResponse.json({ ok: false, error: "Caption excede 1024 caracteres" }, { status: 400 });
      }
    }

    const { data, error } = await supabase
      .from("chat_flow_node_blocks")
      .update(patch)
      .eq("id", params.blockId)
      .eq("empresa_id", auth.empresa_id)
      .select("id, node_id, block_type, content_text, media_url, sort_order, created_at")
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    if (!data) return NextResponse.json({ ok: false, error: "Bloque no encontrado" }, { status: 404 });
    return NextResponse.json({ ok: true, item: data });
  } catch (e) {
    console.error("[api/chat/flows/:flowCode/nodes/:nodeCode/blocks/:blockId][PATCH]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ flowCode: string; nodeCode: string; blockId: string }> }
) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const params = await context.params;
    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    const { error } = await supabase
      .from("chat_flow_node_blocks")
      .delete()
      .eq("id", params.blockId)
      .eq("empresa_id", auth.empresa_id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[api/chat/flows/:flowCode/nodes/:nodeCode/blocks/:blockId][DELETE]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
