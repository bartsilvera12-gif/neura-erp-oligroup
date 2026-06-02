import { NextRequest, NextResponse } from "next/server";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { createSignedUrlForTicket } from "@/lib/sorteos/sorteo-ticket-storage";

/**
 * GET /api/sorteos/tickets/[id]/image
 *
 * Devuelve un 302 redirect a una URL firmada *fresh* del PNG de ticket
 * guardado en el bucket privado `sorteo-tickets-generated`. Pensado para
 * usarse como `src` de un `<img>` en el chat del ERP: cada vez que el
 * navegador renderiza la imagen, este endpoint genera una signed URL nueva
 * (TTL 10 min) y redirige.
 *
 * Validaciones:
 *  - Requiere sesión autenticada del ERP (`getTenantSupabaseFromAuth`).
 *  - El `delivery_id` debe pertenecer a la `empresa_id` del usuario.
 *
 * Por qué no se guarda la signed URL directo en `raw_payload`:
 *  - El bucket es privado y las signed URLs expiran (~10 min). Si las
 *    guardáramos en `raw_payload.image.link`, el chat las mostraría rotas
 *    al rato. Este endpoint regenera el link a demanda sin tocar el envío
 *    original a WhatsApp.
 *
 * NO toca DB. NO envía WhatsApp. Solo lectura + redirect.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const { id } = await params;

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const { data: row, error } = await sb
      .from("sorteo_ticket_deliveries")
      .select("storage_path, empresa_id")
      .eq("id", id)
      .eq("empresa_id", empresaId)
      .maybeSingle();

    if (error || !row) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    const path = (row as { storage_path?: string | null }).storage_path?.trim();
    if (!path) {
      return NextResponse.json({ ok: false, error: "no_file" }, { status: 400 });
    }

    const signed = await createSignedUrlForTicket(sb, path, 600);
    if (!signed.url) {
      return NextResponse.json(
        { ok: false, error: signed.error ?? "signed_url" },
        { status: 500 }
      );
    }

    return NextResponse.redirect(signed.url, { status: 302 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
