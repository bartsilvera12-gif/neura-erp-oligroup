import { esRolAdminEmpresa } from "@/lib/modulos/resolve-effective-modules";

export type DashboardViewRow = {
  id: string;
  nombre: string;
  slug: string;
  orden: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySb = any;

const DASH_SLUGS = new Set(["comercial", "financiero", "inventario", "ventas", "sorteos"]);
export type DashboardTabSlug = "comercial" | "financiero" | "inventario" | "ventas" | "sorteos";

export function isDashboardTabSlug(s: string): s is DashboardTabSlug {
  return DASH_SLUGS.has(s);
}

async function allActiveViewIdsFromCatalog(supabase: AnySb): Promise<string[]> {
  const { data, error } = await supabase
    .from("dashboard_views")
    .select("id")
    .eq("activo", true);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((r: { id?: unknown }) => String(r.id ?? ""))
    .filter((x: string) => x.length > 0);
}

async function viewRowsByIds(supabase: AnySb, ids: string[]): Promise<DashboardViewRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("dashboard_views")
    .select("id, nombre, slug, orden")
    .in("id", ids)
    .order("orden", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map(
    (m: { id?: unknown; nombre?: unknown; slug?: unknown; orden?: unknown }) => ({
      id: m.id as string,
      nombre: (m.nombre as string) ?? "",
      slug: (m.slug as string) ?? "",
      orden: Number(m.orden) || 0,
    })
  );
}

/**
 * Vistas de dashboard efectivas (empresa → subconjunto; usuario → intersección; admin → todas las de la empresa).
 * Si `empresa_dashboard_views` está vacío, se asume “todas las del catálogo” (mismo criterio que módulos).
 * Si `usuario_dashboard_views` está vacío, se asume “todas las de la empresa habilitada”.
 */
export async function resolveEffectiveDashboardViews(
  supabase: AnySb,
  usuario: { id: string; empresa_id: string | null; rol: string | null }
): Promise<{
  views: DashboardViewRow[];
  defaultViewId: string | null;
  defaultSlug: string | null;
}> {
  const rol = (usuario.rol ?? "").trim();
  if (rol === "super_admin") {
    const { data, error } = await supabase
      .from("dashboard_views")
      .select("id, nombre, slug, orden")
      .eq("activo", true)
      .order("orden", { ascending: true });
    if (error) throw new Error(error.message);
    const views = (data ?? []).map(
      (m: { id?: unknown; nombre?: unknown; slug?: unknown; orden?: unknown }) => ({
        id: m.id as string,
        nombre: (m.nombre as string) ?? "",
        slug: (m.slug as string) ?? "",
        orden: Number(m.orden) || 0,
      })
    );
    const first = views[0] ?? null;
    return {
      views,
      defaultViewId: first?.id ?? null,
      defaultSlug: first?.slug ?? null,
    };
  }

  if (!usuario.empresa_id) {
    return { views: [], defaultViewId: null, defaultSlug: null };
  }

  const { data: edRows, error: errEd } = await supabase
    .from("empresa_dashboard_views")
    .select("dashboard_view_id")
    .eq("empresa_id", usuario.empresa_id)
    .eq("activo", true);

  if (errEd) throw new Error(errEd.message);
  const rawEmpresaIds: string[] = (edRows ?? []).map((r: { dashboard_view_id?: unknown }) =>
    r.dashboard_view_id != null ? String(r.dashboard_view_id) : ""
  );
  let empresaViewIds: string[] = [...new Set(rawEmpresaIds)].filter((id: string) => id.length > 0);

  if (empresaViewIds.length === 0) {
    empresaViewIds = await allActiveViewIdsFromCatalog(supabase);
  }
  if (empresaViewIds.length === 0) {
    return { views: [], defaultViewId: null, defaultSlug: null };
  }

  if (esRolAdminEmpresa(usuario.rol)) {
    const views = await viewRowsByIds(supabase, empresaViewIds);
    const first = views[0] ?? null;
    return {
      views,
      defaultViewId: first?.id ?? null,
      defaultSlug: first?.slug ?? null,
    };
  }

  const { data: udRows, error: errUd } = await supabase
    .from("usuario_dashboard_views")
    .select("dashboard_view_id, es_default")
    .eq("usuario_id", usuario.id);

  if (errUd) throw new Error(errUd.message);

  const empresaSet = new Set(empresaViewIds);
  let pickedIds: string[];
  let defaultId: string | null = null;

  const um = (udRows ?? []) as { dashboard_view_id?: unknown; es_default?: unknown }[];
  if (um.length === 0) {
    pickedIds = [...empresaViewIds];
  } else {
    const cand = um
      .map((r) => (r.dashboard_view_id != null ? String(r.dashboard_view_id) : ""))
      .filter((id) => id.length > 0 && empresaSet.has(id));
    pickedIds = [...new Set(cand)];
    for (const r of um) {
      if (r.es_default === true && r.dashboard_view_id != null) {
        const id = String(r.dashboard_view_id);
        if (empresaSet.has(id)) defaultId = id;
      }
    }
  }

  if (pickedIds.length === 0) {
    return { views: [], defaultViewId: null, defaultSlug: null };
  }

  const views = await viewRowsByIds(supabase, pickedIds);

  if (!defaultId && views.length === 1) {
    defaultId = views[0].id;
  }

  const defaultSlug =
    views.find((v) => v.id === defaultId)?.slug ??
    (views.length === 1 ? views[0].slug : null) ??
    views[0]?.slug ??
    null;

  return {
    views,
    defaultViewId: defaultId ?? views[0]?.id ?? null,
    defaultSlug,
  };
}

export async function filterDashboardViewIdsForEmpresa(
  supabase: AnySb,
  empresaId: string,
  viewIds: string[]
): Promise<string[]> {
  if (viewIds.length === 0) return [];
  const { data, error } = await supabase
    .from("empresa_dashboard_views")
    .select("dashboard_view_id")
    .eq("empresa_id", empresaId)
    .eq("activo", true)
    .in("dashboard_view_id", viewIds);
  if (error) throw new Error(error.message);
  const ok = new Set(
    (data ?? []).map((r: { dashboard_view_id?: unknown }) =>
      r.dashboard_view_id != null ? String(r.dashboard_view_id) : ""
    )
  );
  return viewIds.filter((id) => ok.has(id));
}
