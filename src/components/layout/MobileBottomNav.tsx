"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ReceiptText, Menu } from "lucide-react";

type Props = {
  onMoreClick: () => void;
};

/**
 * Barra inferior de navegación en mobile. Solo tres accesos — el menú completo
 * vive en el sidebar-drawer que abre "Más". En desktop no se renderiza (`md:hidden`).
 *
 * "Inicio" apunta a `/`: si el usuario no tiene el módulo dashboard, el AuthGuard
 * lo lleva a su primera ruta accesible, así que no hace falta resolver permisos acá.
 */
export default function MobileBottomNav({ onMoreClick }: Props) {
  const pathname = usePathname() ?? "";

  const items: Array<
    { key: string; label: string; icon: React.ComponentType<{ className?: string }> } & (
      | { href: string }
      | { action: () => void }
    )
  > = [
    { key: "home", label: "Inicio", icon: Home, href: "/" },
    { key: "cupon", label: "Cupón manual", icon: ReceiptText, href: "/sorteos/cupones-manuales" },
    { key: "more", label: "Más", icon: Menu, action: onMoreClick },
  ];

  return (
    <nav
      aria-label="Navegación mobile"
      className="fixed bottom-0 left-0 right-0 z-30 flex border-t border-slate-200 bg-white shadow-[0_-4px_16px_-8px_rgba(15,23,42,0.15)] md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {items.map((it) => {
        const Icon = it.icon;
        const active =
          "href" in it &&
          (it.href === "/"
            ? pathname === "/"
            : pathname === it.href || pathname.startsWith(it.href + "/"));
        const base =
          "flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium transition-colors";
        const color = active ? "text-[#4FAEB2]" : "text-slate-500";
        if ("href" in it) {
          return (
            <Link key={it.key} href={it.href} className={`${base} ${color}`}>
              <Icon className="h-5 w-5" />
              <span>{it.label}</span>
            </Link>
          );
        }
        return (
          <button key={it.key} type="button" onClick={it.action} className={`${base} ${color}`}>
            <Icon className="h-5 w-5" />
            <span>{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
