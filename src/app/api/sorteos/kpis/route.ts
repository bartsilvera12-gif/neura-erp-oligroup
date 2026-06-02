import { NextRequest, NextResponse } from "next/server";
import { getSorteosVentasKpis } from "@/lib/sorteos/ventas-kpis";

/**
 * GET /api/sorteos/kpis — KPIs del módulo Sorteos (Boletos hoy/sorteo, Monto hoy/sorteo).
 *
 * Endpoint dedicado para que `/sorteos/page.tsx` no tenga que esperar estos
 * cálculos server-side antes de devolver HTML. La página renderiza el
 * skeleton/cliente inmediatamente y el `SorteosListClient` hace fetch a este
 * endpoint en `useEffect`, mostrando "…" mientras llega la respuesta.
 *
 * READ-ONLY. Reutiliza `getSorteosVentasKpis()` que ya cachea/encapsula la
 * lógica (3 queries paralelas a triple7.sorteos / sorteo_entradas / sorteo_cupones).
 */
export async function GET(_request: NextRequest) {
  try {
    const kpis = await getSorteosVentasKpis();
    return NextResponse.json({ success: true, data: kpis });
  } catch (err) {
    // En caso de error de sesión / red, devolver KPIs en cero sin romper la UI.
    const message = err instanceof Error ? err.message : "Error";
    return NextResponse.json({
      success: false,
      error: message,
      data: {
        boletosHoy: 0,
        boletosSorteo: 0,
        montoHoy: 0,
        montoSorteo: 0,
        sorteoActivoNombre: null as string | null,
      },
    });
  }
}
