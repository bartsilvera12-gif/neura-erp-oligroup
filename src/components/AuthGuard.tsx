"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { getCurrentUser, getSession } from "@/lib/auth";
import { isBootstrapSuperAdminEmail } from "@/lib/auth/super-admin-bootstrap-email";
import {
  firstAccessibleHref,
  isModuleSlugGranted,
  pathRequiresModuleSlug,
} from "@/lib/modulos/route-slug-map";
import ZentraLoader from "@/components/ZentraLoader";
import { BootProvider, useBoot } from "@/components/BootContext";

const PUBLIC_ROUTES = ["/login"];

/**
 * Prefijos públicos (sin sesión). `/r/` = links de referido y reportes públicos
 * de revendedores (protegidos por token firmado, no por sesión).
 */
const PUBLIC_PREFIXES = ["/r/"];

type ModuleAccess = { superAdmin: boolean; slugs: Set<string> };

function AuthGuardInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { sidebarReady } = useBoot();
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<ModuleAccess | null>(null);

  const isPublic = useMemo(
    () =>
      !!(
        pathname &&
        (PUBLIC_ROUTES.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)))
      ),
    [pathname]
  );

  useEffect(() => {
    if (isPublic) {
      setLoading(false);
      setAccess(null);
      return;
    }

    let cancelled = false;

    async function checkAuthAndModules() {
      setLoading(true);
      const session = await getSession();
      if (cancelled) return;
      if (!session) {
        router.push("/login");
        setLoading(false);
        return;
      }

      const res = await fetchWithSupabaseSession("/api/empresas/module-access", {
        cache: "no-store",
      });
      if (cancelled) return;

      let superAdmin = false;
      let slugs: string[] = [];

      const bootstrapSuper = isBootstrapSuperAdminEmail(session.user.email ?? null);

      if (res.ok) {
        const data = (await res.json()) as { superAdmin?: boolean; slugs?: string[] };
        superAdmin = !!data.superAdmin || bootstrapSuper;
        slugs = Array.isArray(data.slugs) ? data.slugs : [];
      } else {
        superAdmin = bootstrapSuper;
      }

      if (!superAdmin) {
        try {
          const cu = await getCurrentUser();
          if ((cu?.rol ?? "").trim() === "super_admin") superAdmin = true;
        } catch {
          /* sin fila usuarios en cliente */
        }
      }

      setAccess({
        superAdmin,
        slugs: new Set(slugs),
      });
      setLoading(false);
    }

    checkAuthAndModules();
    return () => {
      cancelled = true;
    };
  }, [isPublic, router]);

  useEffect(() => {
    if (loading || isPublic || !access || !pathname) return;

    if (pathname.startsWith("/admin") && !access.superAdmin) {
      router.replace(firstAccessibleHref(access.slugs, { superAdmin: false }));
      return;
    }

    const slug = pathRequiresModuleSlug(pathname);
    if (slug && !access.superAdmin && !isModuleSlugGranted(slug, access.slugs)) {
      const dest = firstAccessibleHref(access.slugs, { superAdmin: access.superAdmin });
      if (dest !== pathname.split("?")[0]) router.replace(dest);
    }
  }, [pathname, access, loading, isPublic, router]);

  /**
   * El loader queda visible mientras se chequea sesión (loading) o mientras el
   * sidebar termina de cargar su menú (sidebarReady). El AppShell se renderiza
   * debajo desde el primer momento para que el Sidebar pueda hacer su fetch.
   */
  const showLoader = !isPublic && (loading || !sidebarReady);

  return (
    <>
      {/* Renderizamos los children inmediatamente para que el Sidebar pueda fetch */}
      {(!loading || isPublic) && children}
      {showLoader ? <ZentraLoader overlay /> : null}
    </>
  );
}

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  return (
    <BootProvider>
      <AuthGuardInner>{children}</AuthGuardInner>
    </BootProvider>
  );
}
