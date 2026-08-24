import { NextRequest, NextResponse } from "next/server";
import { getAuthWithRol } from "@/lib/middleware/auth";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import type { AppSupabaseClient } from "@/lib/supabase/schema";

const CHAT_MEDIA_BUCKET = "chat-media";

/** Limites de WhatsApp Cloud API por tipo de media. */
const WA_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const WA_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
/** Unicos formatos de video que Meta acepta (codec H.264 + audio AAC). */
const WA_VIDEO_MIMES = ["video/mp4", "video/3gpp"];
const BUCKET_SIZE_LIMIT = "16MB";

async function ensureBucket(supabase: AppSupabaseClient) {
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(error.message);
  const exists = (data ?? []).some((b) => b.name === CHAT_MEDIA_BUCKET);
  if (!exists) {
    const { error: createErr } = await supabase.storage.createBucket(CHAT_MEDIA_BUCKET, {
      public: true,
      fileSizeLimit: BUCKET_SIZE_LIMIT,
    });
    if (createErr && !createErr.message.toLowerCase().includes("already exists")) {
      throw new Error(createErr.message);
    }
    return;
  }
  /*
   * El bucket ya existe. createBucket NO cambia el limite de uno existente y el
   * original se creo con 10MB, por debajo de los 16MB que admite un video de
   * WhatsApp. updateBucket es idempotente, asi que lo alineamos en cada subida.
   */
  const { error: updErr } = await supabase.storage.updateBucket(CHAT_MEDIA_BUCKET, {
    public: true,
    fileSizeLimit: BUCKET_SIZE_LIMIT,
  });
  if (updErr) {
    console.warn("[api/chat/flow-media/upload]", "bucket_limit_no_actualizado", updErr.message);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthWithRol(request);
    if (!auth?.empresa_id) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Archivo requerido" }, { status: 400 });
    }
    const mime = (file.type || "").toLowerCase();
    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");
    if (!isImage && !isVideo) {
      return NextResponse.json(
        { ok: false, error: "Solo se permiten imágenes o videos" },
        { status: 400 }
      );
    }
    if (isVideo && !WA_VIDEO_MIMES.includes(mime)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `WhatsApp solo acepta video MP4 o 3GPP (códec H.264 con audio AAC). Recibido: ${mime || "desconocido"}. ` +
            "Convertí el archivo a .mp4 H.264/AAC y volvé a subirlo.",
        },
        { status: 400 }
      );
    }
    const maxBytes = isVideo ? WA_VIDEO_MAX_BYTES : WA_IMAGE_MAX_BYTES;
    if (file.size > maxBytes) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `Archivo demasiado grande (${(file.size / 1024 / 1024).toFixed(1)} MB). ` +
            `Máximo de WhatsApp para ${isVideo ? "video" : "imagen"}: ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        },
        { status: 400 }
      );
    }
    const ext = file.name.includes(".")
      ? file.name.split(".").pop()
      : isVideo
        ? "mp4"
        : "jpg";
    const path = `${auth.empresa_id}/flow-editor/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const supabase = await getChatServiceClientForEmpresa(auth.empresa_id);
    await ensureBucket(supabase);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const up = await supabase.storage.from(CHAT_MEDIA_BUCKET).upload(path, bytes, {
      contentType: file.type,
      upsert: true,
    });
    if (up.error) {
      return NextResponse.json({ ok: false, error: up.error.message }, { status: 400 });
    }
    const mediaUrl = supabase.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
    return NextResponse.json({ ok: true, media_url: mediaUrl, path });
  } catch (e) {
    console.error("[api/chat/flow-media/upload][POST]", e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}
