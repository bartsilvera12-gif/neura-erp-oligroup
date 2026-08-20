"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./layout/Sidebar";
import Header from "./layout/Header";

const STANDALONE_ROUTES = ["/login"];
/**
 * Prefijos que se renderizan SIN el chrome del ERP (sin sidebar/header), a
 * pantalla completa. `/r/` = páginas públicas (referidos + reportes de
 * revendedores) que abren clientes/vendedores sin sesión.
 */
const STANDALONE_PREFIXES = ["/r/"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isStandalone =
    !!pathname &&
    (STANDALONE_ROUTES.includes(pathname) || STANDALONE_PREFIXES.some((p) => pathname.startsWith(p)));

  if (isStandalone) {
    return <>{children}</>;
  }

  return (
    <div id="neura-app-shell" className="flex h-svh min-h-0 overflow-hidden bg-[#F8FAFC]">
      <Sidebar />
      <div id="neura-main-column" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <main id="neura-main-content" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
