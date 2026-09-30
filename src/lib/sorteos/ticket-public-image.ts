import "server-only";
import { createServiceRoleClient } from "@/lib/supabase/service-admin";
import { getChatServiceClientForEmpresa } from "@/lib/supabase/chat-service-role-empresa";
import { createSignedUrlForTicket } from "@/lib/sorteos/sorteo-ticket-storage";

/**
 * URL firmada del PNG, apuntando DIRECTO a Supabase Storage.
 *
 * Se usa para `og:image` y para el `<img>` de la página pública del ticket, en vez de
 * proxear los bytes por `/t/<token>/img`: así la descarga de la imagen no pasa por
 * Cloudflare ni por el server de la app. El crawler de WhatsApp y el navegador del
 * comprador van contra Storage, que es quien tiene el archivo.
 *
 * TTL largo a propósito: el preview lo arma WhatsApp cuando quiere, y el comprador abre
 * el link cuando quiere. Una firma de 10 minutos rompía las dos cosas.
 */
const TTL_SEGUNDOS = 60 * 60 * 24 * 7;

export async function signedTicketImageUrl(deliveryId: string): Promise<string | null> {
  try {
    const catalog = createServiceRoleClient();
    const { data: row } = await catalog
      .from("sorteo_ticket_deliveries")
      .select("storage_path, empresa_id")
      .eq("id", deliveryId)
      .maybeSingle();

    const storagePath = String((row as { storage_path?: string } | null)?.storage_path ?? "").trim();
    const empresaId = String((row as { empresa_id?: string } | null)?.empresa_id ?? "").trim();
    if (!storagePath || !empresaId) return null;

    const sb = await getChatServiceClientForEmpresa(empresaId);
    const signed = await createSignedUrlForTicket(sb, storagePath, TTL_SEGUNDOS);
    return signed.url ?? null;
  } catch {
    return null;
  }
}
