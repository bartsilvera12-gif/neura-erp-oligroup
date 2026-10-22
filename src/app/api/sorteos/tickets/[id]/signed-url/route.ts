import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { createSignedUrlForTicket } from "@/lib/sorteos/sorteo-ticket-storage";
import { ticketPublicUrl } from "@/lib/sorteos/ticket-public-link";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const { id } = await params;
    const url = new URL(request.url);
    const ttl = Math.min(Math.max(Number(url.searchParams.get("ttl") ?? "600"), 60), 3600);

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data: row, error } = await sb
      .from("sorteo_ticket_deliveries")
      .select("storage_path, payload_snapshot, empresa_id")
      .eq("id", id)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (error || !row) {
      return NextResponse.json(errorResponse("No encontrado"), { status: 404 });
    }
    const path = (row as { storage_path?: string | null }).storage_path?.trim();
    if (!path) {
      return NextResponse.json(errorResponse("Sin archivo generado"), { status: 400 });
    }

    /**
     * Imágenes por boleta: si la orden tuvo 2+ cupones se guardó `cupon_images`
     * en `payload_snapshot` (una imagen por boleta). Devolvemos TODAS firmadas
     * para que la venta manual pueda enviarlas/descargarlas todas. Fallback: una
     * sola imagen (storage_path) para tickets de 1 boleta o viejos.
     */
    const payloadSnap = (row as { payload_snapshot?: unknown }).payload_snapshot;
    const cuponImages =
      payloadSnap && typeof payloadSnap === "object" && !Array.isArray(payloadSnap)
        ? (payloadSnap as { cupon_images?: unknown }).cupon_images
        : null;
    const imgDefs: { path: string; cupon: string | null }[] = Array.isArray(cuponImages)
      ? cuponImages
          .map((c) =>
            c && typeof c === "object"
              ? {
                  path: String((c as { path?: unknown }).path ?? "").trim(),
                  cupon:
                    (c as { cupon?: unknown }).cupon != null
                      ? String((c as { cupon?: unknown }).cupon)
                      : null,
                }
              : { path: "", cupon: null }
          )
          .filter((i) => i.path)
      : [];
    if (imgDefs.length === 0) imgDefs.push({ path, cupon: null });

    const signedByPath = new Map<string, string>();
    for (const def of imgDefs) {
      if (signedByPath.has(def.path)) continue;
      const s = await createSignedUrlForTicket(sb, def.path, ttl);
      if (s.url) signedByPath.set(def.path, s.url);
    }
    const images = imgDefs
      .filter((def) => signedByPath.has(def.path))
      .map((def) => ({ cupon: def.cupon, url: signedByPath.get(def.path)! }));
    const primaryUrl = signedByPath.get(path) ?? images[0]?.url ?? null;
    if (!primaryUrl) {
      return NextResponse.json(errorResponse("signed_url"), { status: 500 });
    }
    const signed = { url: primaryUrl };
    /**
     * `public_url` es el link corto `/t/<token>` para compartir por WhatsApp: la signed URL de
     * Storage ronda los 500 caracteres y WhatsApp no le arma preview.
     */
    let publicUrl: string | null = null;
    try {
      const origin =
        request.headers.get("x-forwarded-host")
          ? `${request.headers.get("x-forwarded-proto") ?? "https"}://${request.headers.get("x-forwarded-host")}`
          : url.origin;
      publicUrl = ticketPublicUrl(origin, id);
    } catch {
      /* sin secret configurado: se comparte sin link corto */
    }

    return NextResponse.json(
      successResponse({ url: signed.url, expires_in: ttl, public_url: publicUrl, images })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
