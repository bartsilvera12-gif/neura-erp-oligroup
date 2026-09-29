import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { readCodigoVerificador } from "@/lib/sorteos/revendedor-codigo-verificador";

export type SorteoRevendedorRow = {
  id: string;
  empresa_id: string;
  sorteo_id: string;
  nombre: string;
  telefono: string | null;
  codigo_referido: string;
  /** 4 dígitos, en metadata.codigo_verificador. */
  codigo_verificador: string | null;
  activo: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function mapRev(r: Record<string, unknown>): SorteoRevendedorRow {
  return {
    id: r.id as string,
    empresa_id: r.empresa_id as string,
    sorteo_id: r.sorteo_id as string,
    nombre: (r.nombre as string) ?? "",
    telefono: (r.telefono as string) ?? null,
    codigo_referido: (r.codigo_referido as string) ?? "",
    codigo_verificador: readCodigoVerificador(r.metadata),
    activo: r.activo === true,
    metadata:
      typeof r.metadata === "object" && r.metadata !== null && !Array.isArray(r.metadata)
        ? (r.metadata as Record<string, unknown>)
        : {},
    created_at: (r.created_at as string) ?? "",
    updated_at: (r.updated_at as string) ?? "",
  };
}

async function readApiError(res: Response): Promise<string> {
  const t = await res.text().catch(() => "");
  try {
    const j = JSON.parse(t) as { error?: string };
    if (typeof j?.error === "string" && j.error.trim()) return j.error;
  } catch {
    /* ignore */
  }
  return t.trim().slice(0, 400) || `${res.status}`;
}

/**
 * Lee revendedores vía `/api/sorteos/:id/revendedores` para soportar schemas tenant
 * no expuestos en PostgREST (mismo patrón que listado de sorteos).
 */
export async function listRevendedoresBySorteo(sorteoId: string): Promise<SorteoRevendedorRow[]> {
  const res = await fetchWithSupabaseSession(`/api/sorteos/${encodeURIComponent(sorteoId)}/revendedores`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const json = (await res.json()) as { success?: boolean; data?: unknown[] };
  if (!json.success || !Array.isArray(json.data)) return [];
  return json.data.map((x) => mapRev(x as Record<string, unknown>));
}

export type RevendedorInput = {
  nombre: string;
  telefono?: string | null;
  codigo_referido: string;
  codigo_verificador?: string;
  activo?: boolean;
};

export async function createRevendedor(sorteoId: string, input: RevendedorInput): Promise<SorteoRevendedorRow> {
  const res = await fetchWithSupabaseSession(`/api/sorteos/${encodeURIComponent(sorteoId)}/revendedores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nombre: input.nombre.trim(),
      telefono: input.telefono?.trim() || null,
      codigo_referido: input.codigo_referido.trim(),
      ...(input.codigo_verificador !== undefined
        ? { codigo_verificador: input.codigo_verificador.trim() }
        : {}),
      activo: input.activo !== false,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: Record<string, unknown>;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(json.error || `${res.status}`);
  }
  if (!json.success || !json.data) throw new Error(json.error || "Respuesta inválida");
  return mapRev(json.data);
}

export async function updateRevendedor(
  id: string,
  input: RevendedorInput
): Promise<SorteoRevendedorRow> {
  const res = await fetchWithSupabaseSession(`/api/sorteos/revendedores/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nombre: input.nombre.trim(),
      telefono: input.telefono?.trim() || null,
      codigo_referido: input.codigo_referido.trim(),
      ...(input.codigo_verificador !== undefined
        ? { codigo_verificador: input.codigo_verificador.trim() }
        : {}),
      activo: input.activo !== false,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: Record<string, unknown>;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(json.error || `${res.status}`);
  }
  if (!json.success || !json.data) throw new Error(json.error || "Respuesta inválida");
  return mapRev(json.data);
}

export async function setRevendedorActivo(id: string, activo: boolean): Promise<void> {
  const res = await fetchWithSupabaseSession(`/api/sorteos/revendedores/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activo }),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
  if (!res.ok) {
    throw new Error(json.error || `${res.status}`);
  }
}

export type RevendedorStats = {
  clicks: number;
  clicks_redeemed: number;
  sesiones_atribuidas: number;
  ordenes: number;
  monto_total: number;
  cupones: number;
};

export async function getRevendedorStats(revendedorId: string): Promise<RevendedorStats> {
  const res = await fetchWithSupabaseSession(
    `/api/sorteos/revendedores/${encodeURIComponent(revendedorId)}/stats`,
    { cache: "no-store" }
  );
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: RevendedorStats;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(json.error || `${res.status}`);
  }
  if (!json.success || !json.data) {
    throw new Error(json.error || "Respuesta inválida");
  }
  return json.data;
}
