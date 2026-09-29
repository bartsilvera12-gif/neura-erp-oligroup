import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Salida standalone para el Dockerfile (node server.js): la imagen solo lleva el
  // subconjunto de node_modules que Next rastreó → mucha menos RAM que `next start`.
  // OJO: con esto, `next start` (nixpacks, AWS) ya no es el camino soportado; esta rama
  // se usa con el Dockerfile. No mergear a main mientras AWS siga en nixpacks.
  output: "standalone",
};

export default nextConfig;
