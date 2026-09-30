"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

type Envio = { estado: "idle" | "compartiendo" | "ok" | "error"; mensaje?: string };

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
 * Normaliza a dígitos E.164 sin `+`, que es lo que espera `wa.me`.
 * Paraguay: `0981…` → `595981…`. Si ya viene con 595, se respeta.
 */
function normalizeWaDigits(raw: string): string {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) digits = "595" + digits.slice(1);
  else if (!digits.startsWith("595") && digits.length >= 7 && digits.length <= 10) {
    digits = "595" + digits;
  }
  return digits;
}

/**
 * Modal post-venta manual: previsualiza el ticket PNG recién generado y ofrece
 * compartirlo por WhatsApp o imprimirlo.
 *
 * El envío sale del WhatsApp del propio vendedor, no del bot: se comparte el
 * archivo PNG con la Web Share API (la imagen real, no un link) y, donde esa API
 * no está disponible, se cae a `wa.me/<numero>` con el texto y la descarga del
 * PNG para adjuntarlo a mano.
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
  /**
   * El PNG se descarga apenas hay signed URL, antes de que el usuario toque nada.
   * `navigator.share()` tiene que salir dentro del gesto del click: si se hiciera
   * el fetch ahí adentro, iOS descarta la llamada por haber perdido el gesto.
   */
  const [ticketFile, setTicketFile] = useState<File | null>(null);

  const waDigits = useMemo(() => normalizeWaDigits(telefonoCliente), [telefonoCliente]);
  const nombreArchivo = useMemo(
    () => (numeroOrden ? `ticket-orden-${numeroOrden}.png` : "ticket.png"),
    [numeroOrden]
  );

  const mensaje = useMemo(() => {
    const totalGs = new Intl.NumberFormat("es-PY").format(Math.round(montoTotal || 0));
    const cuponesTxt = cupones.length ? cupones.join(" · ") : "";
    return [
      `Hola${nombreCliente ? " " + nombreCliente : ""}!`,
      "Tu compra quedó registrada.",
      numeroOrden ? `Orden Nº ${numeroOrden}` : null,
      cuponesTxt ? `Cupones: ${cuponesTxt}` : null,
      `Total: Gs. ${totalGs}`,
    ]
      .filter(Boolean)
      .join("\n");
  }, [montoTotal, cupones, numeroOrden, nombreCliente]);

  useEffect(() => {
    if (!open) {
      setSignedUrl(null);
      setLoadErr(null);
      setEnvio({ estado: "idle" });
      setTicketFile(null);
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
          return;
        }
        setSignedUrl(url);

        /** Precarga del archivo para compartir. Si falla, queda el fallback wa.me. */
        try {
          const img = await fetch(url, { cache: "no-store" });
          if (!img.ok) return;
          const blob = await img.blob();
          if (cancelled) return;
          setTicketFile(new File([blob], nombreArchivo, { type: blob.type || "image/png" }));
        } catch {
          /* sin archivo: el botón cae a wa.me + descarga */
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
  }, [open, deliveryId, nombreArchivo]);

  /** Escape cierra el modal, como cualquier diálogo del ERP. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /** Descarga el PNG para poder adjuntarlo a mano cuando no hay Web Share. */
  const descargarTicket = useCallback(() => {
    if (!signedUrl) return;
    const dlUrl = `${signedUrl}${signedUrl.includes("?") ? "&" : "?"}download=${encodeURIComponent(
      nombreArchivo
    )}`;
    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = nombreArchivo;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [signedUrl, nombreArchivo]);

  const abrirWaMe = useCallback(() => {
    const base = waDigits ? `https://wa.me/${waDigits}` : "https://wa.me/";
    window.open(`${base}?text=${encodeURIComponent(mensaje)}`, "_blank", "noopener,noreferrer");
  }, [waDigits, mensaje]);

  const compartir = useCallback(async () => {
    if (envio.estado === "compartiendo") return;

    /**
     * Camino principal: compartir el archivo. El selector del sistema abre WhatsApp
     * con la imagen ya adjunta; el vendedor elige el chat del comprador.
     */
    const puedeCompartirArchivo =
      !!ticketFile &&
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      (navigator.canShare?.({ files: [ticketFile] }) ?? false);

    if (puedeCompartirArchivo && ticketFile) {
      setEnvio({ estado: "compartiendo" });
      try {
        await navigator.share({
          files: [ticketFile],
          text: mensaje,
          title: numeroOrden ? `Ticket orden Nº ${numeroOrden}` : "Ticket",
        });
        setEnvio({ estado: "ok", mensaje: "Ticket compartido ✅" });
      } catch (e) {
        /** El usuario canceló el selector: no es un error que mostrar. */
        if (e instanceof DOMException && e.name === "AbortError") {
          setEnvio({ estado: "idle" });
          return;
        }
        setEnvio({
          estado: "error",
          mensaje: "No se pudo compartir el archivo. Probá con “Descargar ticket”.",
        });
      }
      return;
    }

    /**
     * Fallback (escritorio, o navegador sin Web Share de archivos): se abre el chat
     * de WhatsApp del comprador con el texto y se descarga el PNG para adjuntarlo.
     */
    abrirWaMe();
    descargarTicket();
    setEnvio({
      estado: "ok",
      mensaje: "Se abrió WhatsApp con el mensaje y se descargó el ticket: adjuntalo en el chat.",
    });
  }, [envio.estado, ticketFile, mensaje, numeroOrden, abrirWaMe, descargarTicket]);

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
          {!waDigits ? (
            <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              La compra no tiene teléfono cargado: al compartir vas a tener que elegir el contacto.
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={descargarTicket}
              disabled={!signedUrl}
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:w-auto"
            >
              ⬇ Descargar
            </button>
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
              disabled={!signedUrl || envio.estado === "compartiendo"}
              className="w-full rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1FB955] disabled:opacity-50 sm:w-auto"
            >
              {envio.estado === "compartiendo" ? "Compartiendo…" : "📲 Compartir por WhatsApp"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
