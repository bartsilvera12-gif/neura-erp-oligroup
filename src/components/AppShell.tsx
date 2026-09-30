"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./layout/Sidebar";
import Header from "./layout/Header";
import MobileBottomNav from "./layout/MobileBottomNav";

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  /** Al navegar desde el drawer se cierra solo; si no, la página nueva queda tapada por el overlay. */
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  if (isStandalone) {
    return <>{children}</>;
  }

  return (
    <div id="neura-app-shell" className="flex h-svh min-h-0 overflow-hidden bg-[#F8FAFC]">
      {/*
        En desktop (md+) el sidebar es un flex item normal; en mobile es un drawer
        fixed que entra desde la izquierda. El componente Sidebar no cambia: solo
        su contenedor decide la visibilidad.
      */}
      <div
        className={`fixed inset-y-0 left-0 z-40 transform transition-transform duration-200 md:relative md:z-auto md:translate-x-0 ${
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar />
      </div>

      {/* Backdrop solo mobile, mientras el drawer está abierto. */}
      {mobileNavOpen ? (
        <button
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      ) : null}

      <div id="neura-main-column" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <main
          id="neura-main-content"
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain p-4 pb-24 sm:p-6 md:pb-6"
        >
          {children}
        </main>
      </div>

      <MobileBottomNav onMoreClick={() => setMobileNavOpen(true)} />
    </div>
  );
}
