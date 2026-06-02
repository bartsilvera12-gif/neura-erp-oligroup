import SorteosListClient from "./SorteosListClient";
import type { SorteosVentasKpis } from "@/lib/sorteos/ventas-kpis";

/**
 * KPIs y lista de sorteos se cargan en el cliente para que `/sorteos` no quede
 * bloqueada por el server render mientras se calculan métricas. El servidor
 * devuelve un skeleton inmediato; `SorteosListClient` hace fetch a
 * `/api/sorteos/kpis` y `/api/sorteos` en `useEffect`. Esto evita el 503
 * transient en `/sorteos?_rsc=…` que aparecía cuando el contenedor estaba
 * frío y Turbopack compilaba el server component en el primer hit.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const EMPTY_KPIS: SorteosVentasKpis = {
  boletosHoy: 0,
  boletosSorteo: 0,
  montoHoy: 0,
  montoSorteo: 0,
  sorteoActivoNombre: null,
};

export default function SorteosPage() {
  return <SorteosListClient ventasKpis={EMPTY_KPIS} />;
}
