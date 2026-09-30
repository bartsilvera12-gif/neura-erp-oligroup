import type { MetadataRoute } from "next";

export const dynamic = "force-static";

/**
 * `/robots.txt` — sin este archivo, la ruta cae en el App Router y el server devuelve la app
 * entera de Next. Los crawlers que no encuentran un robots.txt válido asumen lo más
 * restrictivo, y Meta terminaba tratando el dominio completo como "no scrapear": adiós al
 * preview de los links de ticket que se mandan por WhatsApp.
 *
 * El ERP es privado, así que la regla general es no indexar nada. La excepción son los
 * crawlers de preview de mensajería sobre `/t/` (el ticket del comprador) y `/r/` (los links
 * públicos de revendedores): necesitan leer la página para armar la tarjeta con la imagen.
 *
 * Ojo: robots.txt no es control de acceso — lo que protege esas rutas es el token firmado en
 * la URL. Esto solo le dice a los buscadores qué no listar.
 */
const PUBLICAS = ["/t/", "/r/"];

/** Crawlers que arman la tarjeta de preview al pegar un link en un chat. */
const PREVIEW_BOTS = [
  "facebookexternalhit",
  "facebookcatalog",
  "WhatsApp",
  "Twitterbot",
  "TelegramBot",
  "Slackbot-LinkExpanding",
  "Discordbot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      ...PREVIEW_BOTS.map((userAgent) => ({
        userAgent,
        allow: PUBLICAS,
        disallow: "/",
      })),
      {
        userAgent: "*",
        disallow: "/",
      },
    ],
  };
}
