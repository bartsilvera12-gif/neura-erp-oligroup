import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { verifyTicketPublicToken } from "@/lib/sorteos/ticket-public-link";

export const dynamic = "force-dynamic";

/** Origen absoluto real detrás del proxy (Coolify/Cloudflare), para armar `og:image`. */
async function currentOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

/**
 * Metadatos Open Graph: son los que hacen que WhatsApp muestre el ticket como preview
 * dentro del chat en lugar de un link pelado.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const origin = await currentOrigin();
  const imgUrl = `${origin}/t/${token}/img`;
  return {
    title: "Tu ticket",
    description: "Ticket de tu compra",
    /**
     * `noindex` general no: `facebookexternalhit` lo respeta y deja de armar el preview,
     * que es justamente para lo que existe esta página. Se lo decimos solo a Google, y el
     * resto de los buscadores queda cubierto por el Disallow de /robots.txt.
     */
    robots: { googleBot: { index: false, follow: false } },
    openGraph: {
      title: "Tu ticket",
      description: "Ticket de tu compra",
      type: "article",
      images: imgUrl ? [{ url: imgUrl, width: 1080, height: 1080, alt: "Ticket" }] : [],
    },
    twitter: {
      card: "summary_large_image",
      title: "Tu ticket",
      description: "Ticket de tu compra",
      images: imgUrl ? [imgUrl] : [],
    },
  };
}

/**
 * Página pública del ticket (`/t/<token>`): muestra la imagen y permite descargarla.
 * Sin sesión, porque la abre el comprador desde WhatsApp.
 */
export default async function TicketPublicoPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!verifyTicketPublicToken(token)) {
    notFound();
  }
  const imgSrc = `/t/${token}/img`;

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-slate-100 p-4">
      <h1 className="text-base font-semibold text-slate-700">Tu ticket</h1>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imgSrc}
        alt="Ticket"
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-sm"
      />
      <a
        href={imgSrc}
        download="ticket.png"
        className="rounded-lg bg-[#4FAEB2] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#3F8E91]"
      >
        Descargar imagen
      </a>
    </main>
  );
}
