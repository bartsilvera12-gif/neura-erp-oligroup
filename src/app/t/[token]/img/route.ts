import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";
import { createSignedUrlForTicket } from "@/lib/sorteos/sorteo-ticket-storage";
import { verifyTicketPublicToken } from "@/lib/sorteos/ticket-public-link";

export const dynamic = "force-dynamic";

/**
 * GET /t/:token/img — bytes del PNG del ticket, público y sin sesión.
 *
 * Sirve la imagen en vez de redirigir a la signed URL de Storage por dos motivos: es la URL que
 * va en `og:image` (WhatsApp la descarga para armar el preview, y no siempre sigue redirects a
 * otro host), y mantiene el link del comprador estable aunque la firma de Storage expire.
 *
 * El control de acceso es el token firmado: sin el secret del servidor no se puede forjar.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const deliveryId = verifyTicketPublicToken(token);
    if (!deliveryId) {
      return new NextResponse("Link inválido", { status: 404 });
    }

    const catalog = createServiceRoleClient();
    const { data: row } = await catalog
      .from("sorteo_ticket_deliveries")
      .select("storage_path, empresa_id")
      .eq("id", deliveryId)
      .maybeSingle();

    const storagePath = String((row as { storage_path?: string } | null)?.storage_path ?? "").trim();
    const empresaId = String((row as { empresa_id?: string } | null)?.empresa_id ?? "").trim();
    if (!storagePath || !empresaId) {
      return new NextResponse("Ticket no disponible", { status: 404 });
    }

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const signed = await createSignedUrlForTicket(sb, storagePath, 120);
    if (!signed.url) {
      return new NextResponse("Ticket no disponible", { status: 404 });
    }

    const upstream = await fetch(signed.url, { cache: "no-store" });
    if (!upstream.ok || !upstream.body) {
      return new NextResponse("Ticket no disponible", { status: 404 });
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/png",
        /** Cache corto: el PNG no cambia, pero la firma de Storage sí. */
        "Cache-Control": "public, max-age=300",
        "Content-Disposition": `inline; filename="ticket.png"`,
      },
    });
  } catch {
    return new NextResponse("Error", { status: 500 });
  }
}
