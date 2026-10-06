"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import TicketConfirmacionModal from "@/components/sorteos/TicketConfirmacionModal";

/**
 * Única implementación del alta manual de cupones (venta presencial efectivo).
 * La usan el modal "Crear cupón manual" (/sorteos/cupones) y la página
 * /sorteos/cupones-manuales. Ambos llaman a POST /api/sorteos/manual-sale.
 */

export type SorteoListItem = {
  id: string;
  nombre: string;
  estado?: string;
  ticket_delivery_mode?: string;
  /** Precio unitario del boleto; se usa para calcular el total automáticamente. */
  precio_por_boleto?: number | null;
};

type RespuestaSorteos = { success?: boolean; data?: SorteoListItem[]; error?: string };

/** Motivo real del fallo, para que el cartel de la pantalla diga algo accionable. */
function detalleError(res: Response, json: RespuestaSorteos | null): string {
  const msg = (json?.error ?? "").trim();
  if (msg) return `${msg} (HTTP ${res.status})`;
  if (res.status === 401) return "La sesión expiró (HTTP 401). Volvé a entrar.";
  if (res.status === 403) return "El usuario no tiene permiso sobre los sorteos (HTTP 403).";
  if (res.status === 404) return "El endpoint no existe en esta versión desplegada (HTTP 404).";
  return `HTTP ${res.status}`;
}

/**
 * Sorteos elegibles para el alta manual.
 *
 * Primero `GET /api/sorteos/manual-options`, que devuelve solo id + nombre de los activos: el
 * operador de cupón manual no necesita la fila completa con boletos vendidos y recaudación.
 * Si ese endpoint falla, cae a `GET /api/sorteos` para no dejar la pantalla inutilizable, y el
 * error queda visible con su causa en vez del genérico "no se pudieron cargar".
 */
export function useSorteosCuponManual(enabled: boolean) {
  const [sorteos, setSorteos] = useState<SorteoListItem[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loadingSorteos, setLoadingSorteos] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const pedir = async (url: string): Promise<{ lista: SorteoListItem[] } | { error: string }> => {
      const res = await fetchWithSupabaseSession(url, { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as RespuestaSorteos | null;
      if (!res.ok || !json?.success || !Array.isArray(json.data)) {
        return { error: detalleError(res, json) };
      }
      return { lista: json.data };
    };

    (async () => {
      setLoadErr(null);
      setLoadingSorteos(true);
      try {
        const principal = await pedir("/api/sorteos/manual-options");
        if (cancelled) return;
        if ("lista" in principal) {
          setSorteos(principal.lista);
          return;
        }

        console.warn("[cupon-manual] manual-options falló, probando /api/sorteos:", principal.error);
        const fallback = await pedir("/api/sorteos");
        if (cancelled) return;
        if ("lista" in fallback) {
          /**
           * Solo activos, sin caer a "todos" si no hay ninguno: la transacción de venta
           * manual hace ROLLBACK con "El sorteo no está activo", así que ofrecer un sorteo
           * finalizado termina en una venta que falla recién al guardar.
           */
          setSorteos(fallback.lista.filter((s) => (s.estado ?? "activo") === "activo"));
          return;
        }
        setLoadErr(`No se pudieron cargar los sorteos: ${principal.error}`);
      } catch {
        if (!cancelled) setLoadErr("Error de red al cargar sorteos.");
      } finally {
        if (!cancelled) setLoadingSorteos(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { sorteos, loadErr, loadingSorteos };
}

type Props = {
  sorteos: SorteoListItem[];
  sorteoId: string;
  onSorteoIdChange?: (id: string) => void;
  /** Muestra el select de sorteo dentro del formulario (modal). */
  showSorteoSelect?: boolean;
  loadErr?: string | null;
  /** Al cambiar, se genera una nueva clave de idempotencia y se limpian mensajes (p. ej. al abrir el modal). */
  resetSignal?: number;
  /** Si se pasa, muestra el botón "Cerrar". */
  onClose?: () => void;
};

const formatGs = (n: number) => new Intl.NumberFormat("es-PY").format(Math.round(n || 0));

const EMPTY_FIELDS = {
  nombre: "",
  apellido: "",
  cedula: "",
  telefono: "",
  ciudad: "",
  cantidad_boletos: "1",
  observacion_interna: "",
  codigo_verificador: "",
  metodo_pago: "efectivo",
};

export default function SorteoCuponManualForm({
  sorteos,
  sorteoId,
  onSorteoIdChange,
  showSorteoSelect = false,
  loadErr = null,
  resetSignal = 0,
  onClose,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [form, setForm] = useState({ ...EMPTY_FIELDS, generar_ticket_png: true });
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);
  /**
   * Resultado de la última venta. La respuesta ya traía cupones y `ticket.delivery_id`,
   * pero la pantalla solo mostraba el número de orden: el operador acotado al cupón
   * manual no tiene el módulo Sorteos, así que no veía por ningún lado los números que
   * acababa de venderle al cliente que tiene enfrente.
   */
  const [okCupones, setOkCupones] = useState<string[]>([]);
  const [okDeliveryId, setOkDeliveryId] = useState<string | null>(null);
  const [okOrden, setOkOrden] = useState<number | null>(null);
  const [ticketOpen, setTicketOpen] = useState(false);
  /**
   * Snapshot del comprador tomado en el submit exitoso, ANTES de que el reset del
   * formulario pise nombre y teléfono, que son los que usa el envío por WhatsApp.
   */
  const [okCliente, setOkCliente] = useState<{
    nombre: string;
    telefono: string;
    monto: number;
    documento: string;
    sorteoNombre: string;
  }>({
    nombre: "",
    telefono: "",
    monto: 0,
    documento: "",
    sorteoNombre: "",
  });

  /**
   * Venta manual: el operador carga la cantidad y el total se calcula solo (cantidad × precio del
   * sorteo). No se usan promos: el monto no se escribe a mano.
   */
  const sorteoSel = useMemo(() => sorteos.find((s) => s.id === sorteoId) ?? null, [sorteos, sorteoId]);
  const precioUnitario = useMemo(() => {
    const p = Number(sorteoSel?.precio_por_boleto);
    return Number.isFinite(p) && p > 0 ? p : 0;
  }, [sorteoSel]);
  const cantidadNum = useMemo(() => {
    const n = Math.floor(Number(form.cantidad_boletos));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [form.cantidad_boletos]);
  const totalCalculado = useMemo(
    () => Math.round(precioUnitario * cantidadNum),
    [precioUnitario, cantidadNum]
  );

  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
    setSubmitErr(null);
    setSubmitOk(null);
    setOkCupones([]);
    setOkDeliveryId(null);
    setOkOrden(null);
    setTicketOpen(false);
  }, [resetSignal]);

  const onField = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const { name, value, type } = e.target;
      if (type === "checkbox") {
        const c = e.target as HTMLInputElement;
        setForm((p) => ({ ...p, [name]: c.checked }));
        return;
      }
      setForm((p) => ({ ...p, [name]: value }));
    },
    []
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitErr(null);
    setSubmitOk(null);
    setOkCupones([]);
    setOkDeliveryId(null);
    setOkOrden(null);

    const cantidad = Math.floor(Number(form.cantidad_boletos));
    const monto = totalCalculado;
    if (!sorteoId) {
      setSubmitErr("Elegí un sorteo.");
      return;
    }
    if (!form.nombre.trim() || !form.apellido.trim()) {
      setSubmitErr("Nombre y apellido son obligatorios.");
      return;
    }
    if (!form.telefono.trim()) {
      setSubmitErr("El teléfono es obligatorio.");
      return;
    }
    if (!Number.isFinite(cantidad) || cantidad < 1) {
      setSubmitErr("La cantidad de boletos debe ser mayor a 0.");
      return;
    }
    if (precioUnitario <= 0) {
      setSubmitErr("El sorteo no tiene un precio por boleto configurado. Cargalo en el sorteo para calcular el total.");
      return;
    }
    if (!Number.isFinite(monto) || monto <= 0) {
      setSubmitErr("No se pudo calcular el total. Revisá la cantidad y el precio del sorteo.");
      return;
    }
    if (!idempotencyKey) {
      setSubmitErr("Falta clave de idempotencia; cerrá y volvé a abrir el formulario.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetchWithSupabaseSession("/api/sorteos/manual-sale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sorteo_id: sorteoId,
          nombre: form.nombre.trim(),
          apellido: form.apellido.trim(),
          cedula: form.cedula.trim(),
          telefono: form.telefono.trim(),
          ciudad: form.ciudad.trim() || null,
          cantidad_boletos: cantidad,
          monto_total: monto,
          observacion_interna: form.observacion_interna.trim() || null,
          generar_ticket_png: form.generar_ticket_png,
          idempotency_key: idempotencyKey,
          codigo_verificador: form.codigo_verificador.trim() || null,
          promo_nombre: null,
          metodo_pago: form.metodo_pago === "transferencia" ? "transferencia" : "efectivo",
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        data?: {
          entrada_id?: string;
          numero_orden?: number;
          revendedor_nombre?: string | null;
          monto_total?: number;
          cupones?: Array<{ id?: string; numero_cupon?: string }>;
          ticket?: {
            attempted?: boolean;
            delivery_ok?: boolean;
            skipped?: boolean;
            reason?: string;
            delivery_id?: string;
          };
        };
        error?: string;
      };
      if (!res.ok || !json.success) {
        if (res.status === 401) {
          setSubmitErr("Tu sesión expiró. Volvé a iniciar sesión y reintentá la venta.");
        } else {
          setSubmitErr(json.error ?? "No se pudo registrar la venta.");
        }
        return;
      }

      const num = json.data?.numero_orden ?? "—";
      let msg = `Orden Nº ${num} creada correctamente (pago confirmado).`;
      if (json.data?.revendedor_nombre) {
        msg += ` Venta atribuida a ${json.data.revendedor_nombre}.`;
      }
      const t = json.data?.ticket;
      if (form.generar_ticket_png && t?.attempted) {
        if (t.delivery_ok && t.skipped && t.reason === "text_only") {
          msg += " Ticket PNG omitido: el sorteo está en modo solo texto.";
        } else if (t.delivery_ok === false) {
          msg += ` Advertencia: no se generó el ticket PNG (${t.reason ?? "error"}). La orden quedó registrada.`;
        } else if (t.skipped) {
          msg += ` Ticket: ${t.reason ?? "omitido"}.`;
        }
      }
      setSubmitOk(msg);
      setOkCupones(
        (json.data?.cupones ?? [])
          .map((c) => String(c?.numero_cupon ?? "").trim())
          .filter((n) => n.length > 0)
      );
      const deliveryId = t?.delivery_id?.trim() || null;
      setOkDeliveryId(deliveryId);
      setOkOrden(typeof json.data?.numero_orden === "number" ? json.data.numero_orden : null);
      setOkCliente({
        nombre: `${form.nombre.trim()} ${form.apellido.trim()}`.trim(),
        telefono: form.telefono.trim(),
        monto: Number.isFinite(monto) ? monto : 0,
        documento: form.cedula.trim(),
        sorteoNombre: sorteos.find((s) => s.id === sorteoId)?.nombre ?? "",
      });
      /**
       * El modal es el cierre de TODA venta, haya PNG o no: sin imagen igual muestra los
       * números, imprime el comprobante y permite mandarlo por WhatsApp. Antes solo se
       * abría con `delivery_id`, así que en los sorteos en modo solo texto la venta
       * terminaba en un cartelito y el vendedor se quedaba sin nada que darle al cliente.
       */
      setTicketOpen(true);
      setForm((p) => ({ ...p, ...EMPTY_FIELDS }));
      // Venta registrada: la próxima carga es otra venta (misma clave devolvería esta orden).
      setIdempotencyKey(crypto.randomUUID());
      router.refresh();
    } catch {
      setSubmitErr("Error de red al guardar.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 p-4 text-sm sm:p-5">
      <p className="text-slate-600 text-xs">
        Registra comprador y monto; se confirma el pago al guardar. No se crea conversación ni se
        envía nada automáticamente: al guardar se abre el ticket para enviarlo por WhatsApp o
        imprimirlo.
      </p>

      {loadErr ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 text-xs">
          {loadErr}
        </div>
      ) : null}
      {submitErr ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-800 text-xs">
          {submitErr}
        </div>
      ) : null}
      {submitOk ? (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <div>{submitOk}</div>

          {okCupones.length > 0 ? (
            <div className="mt-2">
              <span className="font-semibold">{okCupones.length === 1 ? "Número" : "Números"}:</span>{" "}
              <span className="font-mono text-sm tracking-wide">{okCupones.join("  ·  ")}</span>
            </div>
          ) : null}

          {okDeliveryId ? (
            <button
              type="button"
              onClick={() => setTicketOpen(true)}
              className="mt-2 w-full rounded border border-emerald-300 bg-white px-3 py-2 font-medium text-emerald-800 transition-colors hover:bg-emerald-100 sm:w-auto sm:px-2 sm:py-1"
            >
              Ver ticket
            </button>
          ) : null}
        </div>
      ) : null}

      {showSorteoSelect ? (
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Sorteo *
          <select
            name="sorteo_id"
            value={sorteoId}
            onChange={(e) => onSorteoIdChange?.(e.target.value)}
            required
            className="border border-slate-300 rounded px-3 py-2.5 text-base text-slate-900 sm:px-2 sm:py-2 sm:text-sm"
          >
            <option value="">— Elegir —</option>
            {sorteos.map((s) => (
              <option key={s.id} value={s.id}>
                {s.nombre}
                {(s.estado ?? "") !== "activo" ? ` (${s.estado})` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Nombre *
          <input
            name="nombre"
            value={form.nombre}
            onChange={onField}
            required
            className="border border-slate-300 rounded px-3 py-2.5 text-base sm:px-2 sm:py-2 sm:text-sm"
            autoComplete="given-name"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Apellido *
          <input
            name="apellido"
            value={form.apellido}
            onChange={onField}
            required
            className="border border-slate-300 rounded px-3 py-2.5 text-base sm:px-2 sm:py-2 sm:text-sm"
            autoComplete="family-name"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Cédula
        <input
          name="cedula"
          value={form.cedula}
          onChange={onField}
          className="border border-slate-300 rounded px-3 py-2.5 text-base font-mono sm:px-2 sm:py-2 sm:text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Teléfono *
        <input
          name="telefono"
          value={form.telefono}
          onChange={onField}
          required
          placeholder="Ej. 0981123456"
          className="border border-slate-300 rounded px-3 py-2.5 text-base font-mono sm:px-2 sm:py-2 sm:text-sm"
          autoComplete="tel"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Ciudad
        <input
          name="ciudad"
          value={form.ciudad}
          onChange={onField}
          placeholder="Ej. Ciudad del Este"
          className="border border-slate-300 rounded px-3 py-2.5 text-base sm:px-2 sm:py-2 sm:text-sm"
          autoComplete="address-level2"
        />
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Cantidad de boletas *
          <input
            name="cantidad_boletos"
            type="number"
            min={1}
            step={1}
            value={form.cantidad_boletos}
            onChange={onField}
            required
            inputMode="numeric"
            className="border border-slate-300 rounded px-3 py-2.5 text-base sm:px-2 sm:py-2 sm:text-sm"
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-slate-600">
          Total a cobrar (₲)
          <div className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-3 py-2.5 sm:px-2 sm:py-2">
            <span className="text-base font-semibold tabular-nums text-slate-900">
              Gs. {formatGs(totalCalculado)}
            </span>
            {precioUnitario > 0 ? (
              <span className="text-[11px] text-slate-500">
                {cantidadNum || 0} × {formatGs(precioUnitario)}
              </span>
            ) : (
              <span className="text-[11px] text-amber-600">sin precio configurado</span>
            )}
          </div>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Método de pago
        <select
          name="metodo_pago"
          value={form.metodo_pago}
          onChange={onField}
          className="border border-slate-300 rounded px-3 py-2.5 text-base text-slate-900 sm:px-2 sm:py-2 sm:text-sm"
        >
          <option value="efectivo">Efectivo</option>
          <option value="transferencia">Transferencia</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Código verificador del revendedor (opcional)
        <input
          name="codigo_verificador"
          value={form.codigo_verificador}
          onChange={(e) =>
            setForm((p) => ({ ...p, codigo_verificador: e.target.value.replace(/\D/g, "").slice(0, 4) }))
          }
          placeholder="4 dígitos"
          inputMode="numeric"
          pattern="\d{4}"
          maxLength={4}
          title="4 dígitos del revendedor, o vacío si la venta no es de un revendedor"
          className="border border-slate-300 rounded px-3 py-2.5 text-base font-mono tracking-widest sm:px-2 sm:py-2 sm:text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Observación interna (opcional)
        <textarea
          name="observacion_interna"
          value={form.observacion_interna}
          onChange={onField}
          rows={2}
          className="border border-slate-300 rounded px-3 py-2.5 text-base sm:px-2 sm:py-2 sm:text-sm"
        />
      </label>

      <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
        <input
          type="checkbox"
          name="generar_ticket_png"
          className="h-4 w-4"
          checked={form.generar_ticket_png}
          onChange={onField}
        />
        Generar ticket PNG (si el sorteo tiene imagen configurada)
      </label>

      <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:flex-wrap">
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-[#4FAEB2] px-4 py-3 font-medium text-white hover:bg-[#3F8E91] disabled:opacity-60 sm:w-auto sm:py-2"
        >
          {loading ? "Guardando…" : "Guardar venta"}
        </button>
        {onClose ? (
          <button
            type="button"
            className="w-full px-2 py-3 text-slate-600 underline sm:w-auto sm:py-2"
            onClick={onClose}
          >
            Cerrar
          </button>
        ) : null}
      </div>

      <TicketConfirmacionModal
        open={ticketOpen}
        onClose={() => setTicketOpen(false)}
        deliveryId={okDeliveryId}
        numeroOrden={okOrden}
        telefonoCliente={okCliente.telefono}
        nombreCliente={okCliente.nombre}
        cupones={okCupones}
        montoTotal={okCliente.monto}
        documentoCliente={okCliente.documento}
        sorteoNombre={okCliente.sorteoNombre}
      />
    </form>
  );
}
