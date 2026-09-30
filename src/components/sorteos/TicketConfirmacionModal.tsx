"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Envio = { estado: "idle" | "enviando" | "ok" | "error"; mensaje?: string };

type Props = {
  open: boolean;
  onClose: () => void;
  deliveryId: string | null;
  numeroOrden: number | null;
  telefonoCliente: string;
  nombreCliente: string;
  cupones: string[];
  montoTotal: number;
};

/**
 * Modal post-venta manual: previsualiza el ticket PNG recién generado y ofrece
 * enviarlo por WhatsApp al número que se cargó en la compra, o imprimirlo.
 */
export default function TicketConfirmacionModal({
  open,
  onClose,
  deliveryId,
  numeroOrden,
  telefonoCliente,
  nombreCliente,
  cupones,
  montoTotal,
}: Props) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [envio, setEnvio] = useState<Envio>({ estado: "idle" });

  useEffect(() => {
    if (!open) {
      setSignedUrl(null);
      setLoadErr(null);
      setEnvio({ estado: "idle" });
      return;
    }
    if (!deliveryId) return;
    let cancelled = false;
    (async () => {
      setLoadingUrl(true);
      setLoadErr(null);
      try {
        const res = await fetchWithSupabaseSession(
          `/api/sorteos/tickets/${deliveryId}/signed-url`,
          { cache: "no-store" }
        );
        const json = (await res.json()) as {
          success?: boolean;
          data?: { url?: string };
          error?: string;
        };
        if (cancelled) return;
        const url = json.data?.url;
        if (!res.ok || !json.success || !url) {
          setLoadErr(json.error ?? "No se pudo cargar el ticket.");
        } else {
          setSignedUrl(url);
        }
      } catch {
        if (!cancelled) setLoadErr("Error de red al cargar el ticket.");
      } finally {
        if (!cancelled) setLoadingUrl(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, deliveryId]);

  /** Escape cierra el modal, como cualquier diálogo del ERP. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const compartir = useCallback(async () => {
    if (!deliveryId || !telefonoCliente || envio.estado === "enviando") return;
    /**
     * Manda la IMAGEN por el canal WhatsApp de la empresa, no un link: el endpoint
     * valida el delivery, firma el PNG y lo pasa como media a Meta, así el cliente
     * recibe la foto igual que cualquier ticket del bot.
     */
    const totalGs = new Intl.NumberFormat("es-PY").format(Math.round(montoTotal || 0));
    const cuponesTxt = cupones.length ? cupones.join(" · ") : "";
    const caption = [
      `Hola${nombreCliente ? " " + nombreCliente : ""}!`,
      "Tu compra quedó registrada.",
      numeroOrden ? `Orden Nº ${numeroOrden}` : null,
      cuponesTxt ? `Cupones: ${cuponesTxt}` : null,
      `Total: Gs. ${totalGs}`,
    ]
      .filter(Boolean)
      .join("\n");

    setEnvio({ estado: "enviando" });
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/tickets/${deliveryId}/send-to-phone`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ telefono: telefonoCliente, caption }),
        }
      );
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || json.success === false) {
        setEnvio({
          estado: "error",
          mensaje: json.error ?? `No se pudo enviar (HTTP ${res.status})`,
        });
        return;
      }
      setEnvio({ estado: "ok", mensaje: "Ticket enviado por WhatsApp ✅" });
    } catch (e) {
      setEnvio({ estado: "error", mensaje: e instanceof Error ? e.message : "Error de red" });
    }
  }, [deliveryId, telefonoCliente, montoTotal, cupones, numeroOrden, nombreCliente, envio.estado]);

  const imprimir = useCallback(() => {
    if (!signedUrl) return;
    /**
     * Ventana nueva con SOLO la imagen del ticket: dispara print() al cargar y se
     * cierra al terminar, así no sale impreso el resto del ERP.
     */
    const win = window.open("", "_blank", "noopener,noreferrer,width=600,height=800");
    if (!win) return;
    win.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>Ticket ${numeroOrden ?? ""}</title>
<style>
  @page { margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img { display: block; max-width: 100%; margin: 0 auto; }
</style>
</head><body>
  <img src="${signedUrl}" alt="Ticket" onload="setTimeout(function(){ window.print(); }, 250);" />
  <script>
    window.onafterprint = function() { window.close(); };
  </script>
</body></html>`);
    win.document.close();
  }, [signedUrl, numeroOrden]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ticket generado"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-slate-800">✅ Venta registrada</h2>
            {numeroOrden ? <p className="text-xs text-slate-500">Orden Nº {numeroOrden}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {cupones.length > 0 ? (
          <div className="border-b border-slate-100 px-4 py-2 text-xs text-slate-600">
            <span className="font-semibold">{cupones.length === 1 ? "Número" : "Números"}:</span>{" "}
            <span className="font-mono tracking-wide text-slate-800">{cupones.join("  ·  ")}</span>
          </div>
        ) : null}

        <div className="flex-1 overflow-auto bg-slate-50 p-3 sm:p-4">
          {loadingUrl ? (
            <div className="flex h-64 items-center justify-center text-sm text-slate-500">
              Cargando ticket…
            </div>
          ) : loadErr ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {loadErr}
            </div>
          ) : signedUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={signedUrl}
              alt="Ticket generado"
              className="mx-auto max-h-[62vh] w-auto rounded-lg border border-slate-200 bg-white shadow-sm"
            />
          ) : null}
        </div>

        <div className="border-t border-slate-100 p-3 sm:p-4">
          {envio.estado === "ok" ? (
            <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              {envio.mensaje}
            </div>
          ) : envio.estado === "error" ? (
            <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {envio.mensaje}
            </div>
          ) : null}
          {!telefonoCliente ? (
            <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              La compra no tiene teléfono cargado; solo se puede imprimir.
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={imprimir}
              disabled={!signedUrl}
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:w-auto"
            >
              🖨 Imprimir
            </button>
            <button
              type="button"
              onClick={() => void compartir()}
              disabled={
                !deliveryId ||
                !telefonoCliente ||
                envio.estado === "enviando" ||
                envio.estado === "ok"
              }
              className="w-full rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1FB955] disabled:opacity-50 sm:w-auto"
            >
              {envio.estado === "enviando"
                ? "Enviando…"
                : envio.estado === "ok"
                ? "✅ Enviado"
                : "📲 Enviar por WhatsApp"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
