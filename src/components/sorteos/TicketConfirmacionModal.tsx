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
 * El envío sale del WhatsApp del propio vendedor, no del bot: se descarga el PNG y se
 * abre `wa.me/<numero>` con el teléfono cargado en la compra y el mensaje armado; el
 * operador adjunta la imagen desde la galería.
 *
 * Es el camino largo a propósito. WhatsApp no deja adjuntar un archivo desde un link
 * `wa.me`, y las alternativas fallan de maneras distintas según el teléfono: Web Share
 * no permite preseleccionar el contacto, y mandar el link del ticket depende de que el
 * crawler de Meta pueda leer la página para armar el preview. Esto funciona siempre.
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

  /**
   * Flujo de envío, deliberadamente simple porque es el único que funciona igual en todos
   * los teléfonos: descarga el PNG y abre el chat del comprador con el mensaje armado.
   * El operador adjunta desde la galería.
   *
   * No usa Web Share (no deja preseleccionar el contacto) ni manda el link del ticket en el
   * texto (depende de que el crawler de WhatsApp pueda leer la página para armar el preview).
   */
  const enviarPorWhatsApp = useCallback(() => {
    if (envio.estado === "compartiendo") return;
    setEnvio({ estado: "compartiendo" });

    /** Primero la descarga: si se abre wa.me antes, el navegador manda esta pestaña al fondo. */
    if (signedUrl) descargarTicket();
    abrirWaMe();

    setEnvio({
      estado: "ok",
      mensaje: signedUrl
        ? "Ticket descargado y chat abierto. Adjuntalo con 📎 → Galería."
        : `Chat de ${telefonoCliente || "WhatsApp"} abierto con el mensaje y los números.`,
    });
  }, [envio.estado, signedUrl, descargarTicket, abrirWaMe, telefonoCliente]);

  const imprimir = useCallback(() => {
    /**
     * Imprime con un iframe oculto, no con `window.open`: en el celular el popup lo bloquea
     * el navegador la mitad de las veces, y ahí el botón no hacía nada. Con el iframe el
     * diálogo nativo abre siempre, y desde ahí el operador elige su impresora o
     * "Guardar como PDF" — que es como se manda a una impresora por el sistema.
     *
     * Con PNG se imprime la imagen; sin PNG (sorteo en modo solo texto, o generación
     * fallida) se imprime un comprobante con orden, números y total, que es lo que el
     * cliente se lleva del mostrador.
     */
    const totalTxt = new Intl.NumberFormat("es-PY").format(Math.round(montoTotal || 0));
    const cuerpo = signedUrl
      ? `<img src="${signedUrl}" alt="Ticket" />`
      : `<div class="tk">
           <h1>Comprobante de compra</h1>
           ${numeroOrden ? `<p class="orden">Orden Nº ${numeroOrden}</p>` : ""}
           ${nombreCliente ? `<p>${nombreCliente}</p>` : ""}
           ${
             cupones.length
               ? `<p class="lbl">${cupones.length === 1 ? "Número" : "Números"}</p>
                  <p class="nums">${cupones.join(" · ")}</p>`
               : ""
           }
           <p class="total">Total: Gs. ${totalTxt}</p>
         </div>`;

    const doc = `<!doctype html>
<html><head><meta charset="utf-8"><title>Ticket ${numeroOrden ?? ""}</title>
<style>
  @page { margin: 8mm; }
  html, body { margin: 0; padding: 0; background: #fff; font-family: system-ui, sans-serif; }
  img { display: block; max-width: 100%; margin: 0 auto; }
  .tk { padding: 16px; text-align: center; color: #0f172a; }
  .tk h1 { font-size: 16px; margin: 0 0 12px; }
  .orden { font-size: 14px; margin: 0 0 4px; }
  .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #64748b; margin: 16px 0 4px; }
  .nums { font-family: ui-monospace, monospace; font-size: 18px; font-weight: 700; margin: 0; }
  .total { margin-top: 16px; font-size: 15px; font-weight: 700; }
</style>
</head><body>${cuerpo}</body></html>`;

    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.srcdoc = doc;

    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) return;
      const lanzar = () => {
        win.focus();
        win.print();
        /** Se quita después del diálogo; si se saca antes, algunos navegadores cancelan. */
        window.setTimeout(() => iframe.remove(), 60_000);
      };
      const img = iframe.contentDocument?.images?.[0];
      /** Con imagen hay que esperar a que cargue, o se imprime la hoja en blanco. */
      if (img && !img.complete) {
        img.onload = lanzar;
        img.onerror = lanzar;
      } else {
        lanzar();
      }
    };

    document.body.appendChild(iframe);
  }, [signedUrl, numeroOrden, nombreCliente, cupones, montoTotal]);

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
          {!deliveryId ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              Esta venta no generó imagen de ticket (el sorteo está en modo solo texto o no tiene
              imagen configurada). Igual podés imprimir el comprobante y mandar los números por
              WhatsApp.
            </div>
          ) : loadingUrl ? (
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
              La compra no tiene teléfono cargado: WhatsApp va a abrir sin el chat elegido y vas
              a tener que buscar el contacto.
            </div>
          ) : null}
          <p className="mb-2 text-[11px] leading-snug text-slate-500">
            “Enviar por WhatsApp” descarga el ticket y abre el chat del número de la compra con
            el mensaje listo: adjuntá la imagen con 📎 → Galería. “Imprimir / PDF” abre el
            diálogo del sistema, donde elegís tu impresora o “Guardar como PDF”.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            {signedUrl ? (
              <button
                type="button"
                onClick={descargarTicket}
                className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:w-auto"
              >
                ⬇ Descargar
              </button>
            ) : null}
            <button
              type="button"
              onClick={imprimir}
              className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:w-auto"
            >
              🖨 Imprimir / PDF
            </button>
            <button
              type="button"
              onClick={enviarPorWhatsApp}
              disabled={envio.estado === "compartiendo"}
              className="w-full rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1FB955] disabled:opacity-50 sm:w-auto"
            >
              {envio.estado === "compartiendo" ? "Abriendo…" : "📲 Enviar por WhatsApp"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
