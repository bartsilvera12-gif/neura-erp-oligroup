import { notFound } from "next/navigation";
import {
  fetchPhysicalCouponsForPrintServer,
  fetchSorteoNombreForEmpresaServer,
  type EntradaImpresionContext,
} from "@/lib/sorteos/physical-coupons-print";
import type { SorteoEntradaEstadoPago } from "@/lib/sorteos/types";
import PhysicalCouponsPrintClient from "./PhysicalCouponsPrintClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Sp = Record<string, string | string[] | undefined>;

function pickStr(sp: Sp, key: string): string {
  const v = sp[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return "";
}

/** Acepta `entrada_ids=a,b` y/o repetido `entrada_ids=a&entrada_ids=b`. */
function pickIdList(sp: Sp, key: string): string[] {
  const v = sp[key];
  const raw = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return [
    ...new Set(
      raw
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

function pickInt(sp: Sp, key: string): number | null {
  const s = pickStr(sp, key).trim();
  if (!s || !/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseEstado(raw: string): SorteoEntradaEstadoPago {
  const t = raw.trim();
  if (
    t === "confirmado" ||
    t === "pendiente" ||
    t === "pendiente_revision" ||
    t === "rechazado"
  ) {
    return t;
  }
  return "confirmado";
}

export default async function ImprimirCuponesSorteoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Sp>;
}) {
  const { id: sorteoId } = await params;
  const sp = await Promise.resolve(searchParams ?? {});

  const sorteoNombre = await fetchSorteoNombreForEmpresaServer(sorteoId);
  if (!sorteoNombre) {
    notFound();
  }

  const q = pickStr(sp, "q").trim();
  const estado = parseEstado(pickStr(sp, "estado"));
  const fechaDesde = pickStr(sp, "fecha_desde").trim();
  const fechaHasta = pickStr(sp, "fecha_hasta").trim();
  const entradaIdRaw = pickStr(sp, "entrada_id").trim();
  // Tanda: solo se consideran si NO hay un entrada_id singular.
  const entradaIds = entradaIdRaw ? [] : pickIdList(sp, "entrada_ids");
  const cuponDesde = pickInt(sp, "cupon_desde");
  const cuponHasta = pickInt(sp, "cupon_hasta");

  const result = await fetchPhysicalCouponsForPrintServer({
    sorteoId,
    entradaId: entradaIdRaw || null,
    entradaIds: entradaIds.length > 0 ? entradaIds : null,
    estadoPago: estado,
    q: q || null,
    fechaDesde: fechaDesde || null,
    fechaHasta: fechaHasta || null,
    cuponDesde,
    cuponHasta,
  });

  const entradaContext: EntradaImpresionContext | null = result.entrada_context ?? null;
  const batchMode = !entradaIdRaw && (entradaIds.length > 0 || cuponDesde != null || cuponHasta != null);

  return (
    <PhysicalCouponsPrintClient
      sorteoId={sorteoId}
      sorteoNombre={sorteoNombre}
      rows={result.data}
      error={result.error}
      q={q}
      estado={estado}
      fechaDesde={fechaDesde}
      fechaHasta={fechaHasta}
      entradaId={entradaIdRaw || null}
      entradaContext={entradaContext}
      batchMode={batchMode}
      batchEntradaCount={entradaIds.length}
      cuponDesde={cuponDesde}
      cuponHasta={cuponHasta}
    />
  );
}
