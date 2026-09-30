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
      .select("storage_path, empresa_id")
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
    const signed = await createSignedUrlForTicket(sb, path, ttl);
    if (!signed.url) {
      return NextResponse.json(errorResponse(signed.error ?? "signed_url"), { status: 500 });
    }
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
      successResponse({ url: signed.url, expires_in: ttl, public_url: publicUrl })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
