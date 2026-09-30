import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { getChatServiceClientForEmpresa } from "@/app/api/chat/_chat-service-client";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { createSignedUrlForTicket } from "@/lib/sorteos/sorteo-ticket-storage";
import { sendWhatsAppImage } from "@/lib/chat/whatsapp-send-service";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

/**
 * Normaliza a E.164 sin `+` para Meta Graph (`to`). Solo dígitos.
 * Paraguay: `0981...` → `595981...`. Si ya viene con 595, se respeta.
 */
function normalizeToDigits(raw: string): string {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) digits = "595" + digits.slice(1);
  else if (!digits.startsWith("595") && digits.length >= 7 && digits.length <= 10) {
    digits = "595" + digits;
  }
  return digits;
}

/**
 * POST /api/sorteos/tickets/:id/send-to-phone
 *   Body: { telefono: string, caption?: string }
 *
 * Envía la imagen del ticket ya generado (delivery_id) al número indicado usando
 * el canal WhatsApp de la empresa. Caso de uso: venta manual presencial, donde el
 * comprador todavía no existe como contacto del chat, así que no hay conversación
 * ni flujo del bot desde donde disparar el envío.
 *
 * Manda la IMAGEN, no un link: se firma el PNG del bucket privado con TTL corto y
 * se pasa como media a Meta, que la descarga al recibirla.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) {
      return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    }
    const empresaId = ctx.auth.empresa_id;
    const { id: deliveryId } = await params;
    if (!isUuid(deliveryId)) {
      return NextResponse.json(errorResponse("delivery_id inválido"), { status: 400 });
    }

    let body: { telefono?: string; caption?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json(errorResponse("JSON inválido"), { status: 400 });
    }
    const toDigits = normalizeToDigits(body.telefono ?? "");
    if (!toDigits || toDigits.length < 8) {
      return NextResponse.json(errorResponse("Teléfono inválido"), { status: 400 });
    }
    const captionInput = (body.caption ?? "").trim().slice(0, 1024);

    const sb = await getChatServiceClientForEmpresa(empresaId);

    /** Delivery + path del PNG. El filtro por empresa evita mandar el ticket de otro tenant. */
    const { data: delivery } = await sb
      .from("sorteo_ticket_deliveries")
      .select("id, storage_path, entrada_id, empresa_id")
      .eq("id", deliveryId)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (!delivery) {
      return NextResponse.json(errorResponse("Ticket no encontrado"), { status: 404 });
    }
    const storagePath = String((delivery as { storage_path?: string }).storage_path ?? "").trim();
    if (!storagePath) {
      return NextResponse.json(errorResponse("El ticket aún no tiene PNG generado"), { status: 400 });
    }

    /** Signed URL de ~10 min: Meta descarga el media al momento de recibirlo. */
    const signed = await createSignedUrlForTicket(sb, storagePath, 600);
    if (!signed.url) {
      return NextResponse.json(errorResponse(signed.error ?? "No se pudo firmar el ticket"), {
        status: 500,
      });
    }

    /** Canal WhatsApp activo de la empresa (el mismo que usa el bot). */
    const { data: channel } = await sb
      .from("chat_channels")
      .select("id, meta_phone_number_id, whatsapp_access_token")
      .eq("empresa_id", empresaId)
      .eq("type", "whatsapp")
      .limit(1)
      .maybeSingle();
    const phoneNumberId = String(
      (channel as { meta_phone_number_id?: string } | null)?.meta_phone_number_id ?? ""
    ).trim();
    const rowToken = String(
      (channel as { whatsapp_access_token?: string } | null)?.whatsapp_access_token ?? ""
    ).trim();
    const accessToken = rowToken || (process.env.WHATSAPP_TOKEN ?? "").trim();
    if (!phoneNumberId || !accessToken) {
      return NextResponse.json(errorResponse("Canal WhatsApp no configurado"), { status: 500 });
    }

    const send = await sendWhatsAppImage({
      toDigits,
      phoneNumberId,
      accessToken,
      imageUrl: signed.url,
      caption: captionInput || undefined,
    });
    if (!send.ok) {
      return NextResponse.json(errorResponse(send.error ?? "No se pudo enviar la imagen"), {
        status: 400,
      });
    }

    return NextResponse.json(
      successResponse({ ok: true, waMessageId: send.waMessageId ?? null, to: toDigits })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error";
    return NextResponse.json(errorResponse(msg), { status: 500 });
  }
}
