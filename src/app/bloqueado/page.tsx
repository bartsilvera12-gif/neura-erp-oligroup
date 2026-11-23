import type { Metadata } from "next";
import { BLOQUEO_PAGO_MENSAJE } from "@/lib/bloqueo-pago";

export const metadata: Metadata = { title: "Acceso suspendido" };

/**
 * Pantalla de "Acceso suspendido por falta de pago". El middleware manda acá toda la
 * navegación cuando el sistema de Neura marca este dominio como suspendido, y cuando se
 * rehabilita saca al usuario de esta ruta hacia el inicio. Estática. Marca Zentra.
 */
export default function BloqueadoPage() {
  return (
    <div
      className="flex min-h-dvh w-full flex-col items-center justify-center px-4 py-8"
      style={{ background: "linear-gradient(168deg,#145053 0%,#0B3A3D 46%,#0a3437 100%)" }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/zentra-logo-official.png"
          alt="ZENTRA"
          style={{ height: 50, width: "auto", filter: "drop-shadow(0 2px 10px rgba(0,0,0,.28))" }}
        />

        <div
          className="flex items-center justify-center rounded-full"
          style={{ height: 76, width: 76, border: "2px solid rgba(79,174,178,.55)", background: "rgba(79,174,178,.12)" }}
        >
          <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#7FD4D7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="10.5" width="16" height="10" rx="2.2" />
            <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
          </svg>
        </div>

        <span
          className="rounded-full px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider"
          style={{ color: "#CDEDEE", background: "rgba(79,174,178,.16)", border: "1px solid rgba(79,174,178,.42)" }}
        >
          Servicio suspendido
        </span>

        <h1 className="text-xl font-bold leading-tight" style={{ color: "#F2FAFA" }}>
          Acceso suspendido por falta de pago
        </h1>

        <p className="text-sm leading-relaxed" style={{ color: "#B9CFD1" }}>
          {BLOQUEO_PAGO_MENSAJE}
        </p>

        <a
          href="https://wa.me/595973989068"
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 inline-flex items-center gap-2.5 rounded-xl px-5 py-3 text-sm font-bold no-underline"
          style={{ background: "#4FAEB2", color: "#06211f", boxShadow: "0 12px 28px -10px rgba(79,174,178,.75)" }}
        >
          <svg viewBox="0 0 24 24" width="19" height="19" fill="#06211f" aria-hidden>
            <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.9c0 1.75.46 3.46 1.32 4.97L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.9 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.17c-.25.69-1.45 1.32-1.99 1.37-.53.05-1.02.24-3.45-.72-2.9-1.14-4.73-4.1-4.88-4.29-.14-.19-1.16-1.54-1.16-2.94 0-1.4.73-2.08 1-2.37.24-.26.53-.33.71-.33.18 0 .36 0 .51.01.17.01.39-.06.6.46.25.6.84 2.08.91 2.23.07.15.12.32.02.51-.1.19-.15.31-.29.48-.14.17-.3.38-.43.51-.14.14-.29.29-.12.57.17.28.74 1.22 1.59 1.98 1.09.97 2.01 1.27 2.3 1.42.29.14.46.12.63-.07.17-.19.73-.85.93-1.14.19-.29.38-.24.64-.14.26.1 1.65.78 1.93.92.29.14.48.21.55.33.07.12.07.69-.18 1.38Z" />
          </svg>
          Escribinos por WhatsApp
        </a>
      </div>
    </div>
  );
}
