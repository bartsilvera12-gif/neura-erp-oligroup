"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import TicketConfirmacionModal from "@/components/sorteos/TicketConfirmacionModal";
import type { ManualPromo } from "@/lib/sorteos/manual-promos";

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
};

/**
 * Sorteos elegibles para el alta manual (GET /api/sorteos/manual-options): solo id + nombre de los
 * activos. No usa `GET /api/sorteos`, que devuelve la fila completa con boletos vendidos y
 * recaudación — datos que el operador de cupón manual no necesita ni debe recibir.
 */
export function useSorteosCuponManual(enabled: boolean) {
  const [sorteos, setSorteos] = useState<SorteoListItem[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loadingSorteos, setLoadingSorteos] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      setLoadErr(null);
      setLoadingSorteos(true);
      try {
        const res = await fetchWithSupabaseSession("/api/sorteos/manual-options", {
          cache: "no-store",
        });
        const json = (await res.json()) as { success?: boolean; data?: SorteoListItem[] };
        if (!res.ok || !json.success || !Array.isArray(json.data)) {
          if (!cancelled) setLoadErr("No se pudieron cargar los sorteos.");
          return;
        }
        if (!cancelled) setSorteos(json.data);
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

/**
 * Promos que ofrece el bot (GET /api/sorteos/manual-promos). El vendedor elige la misma
 * opción que vería el cliente en WhatsApp y de ahí salen cantidad y monto, en vez de
 * tipearlos: así no se cobran precios que no existen en el flujo.
 */
export function usePromosCuponManual(enabled: boolean) {
  const [promos, setPromos] = useState<ManualPromo[]>([]);
  const [loadingPromos, setLoadingPromos] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      setLoadingPromos(true);
      try {
        const res = await fetchWithSupabaseSession("/api/sorteos/manual-promos", {
          cache: "no-store",
        });
        const json = (await res.json()) as { success?: boolean; data?: ManualPromo[] };
        if (!cancelled && res.ok && json.success && Array.isArray(json.data)) {
          setPromos(json.data);
        }
      } catch {
        /* sin promos: el formulario cae a carga manual */
      } finally {
        if (!cancelled) setLoadingPromos(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { promos, loadingPromos };
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

/** Opción "otro monto": habilita los campos libres de cantidad y monto. */
const MANUAL_PROMO_ID = "__manual__";

const EMPTY_FIELDS = {
  nombre: "",
  apellido: "",
  cedula: "",
  telefono: "",
  cantidad_boletos: "1",
  monto_total: "",
  observacion_interna: "",
  codigo_verificador: "",
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
  const [okCliente, setOkCliente] = useState<{ nombre: string; telefono: string; monto: number }>({
    nombre: "",
    telefono: "",
    monto: 0,
  });

  const { promos, loadingPromos } = usePromosCuponManual(true);
  /** `""` = ninguna promo elegida todavía; `MANUAL` = carga libre de cantidad y monto. */
  const [promoId, setPromoId] = useState("");
  const promoSel = useMemo(() => promos.find((p) => p.id === promoId) ?? null, [promos, promoId]);
  const modoManual = promoId === MANUAL_PROMO_ID || promos.length === 0;

  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
    setSubmitErr(null);
    setSubmitOk(null);
    setOkCupones([]);
    setOkDeliveryId(null);
    setOkOrden(null);
    setTicketOpen(false);
    setPromoId("");
  }, [resetSignal]);

  /** Elegir promo completa cantidad y monto; el monto sin promo queda a cargo del vendedor. */
  const onPromoChange = useCallback(
    (id: string) => {
      setPromoId(id);
      setSubmitErr(null);
      if (id === MANUAL_PROMO_ID || !id) return;
      const p = promos.find((x) => x.id === id);
      if (!p) return;
      setForm((prev) => ({
        ...prev,
        cantidad_boletos: String(p.cantidad),
        monto_total: p.monto != null ? String(p.monto) : prev.monto_total,
      }));
    },
    [promos]
  );

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
    const monto = Number(form.monto_total);
    if (!sorteoId) {
      setSubmitErr("Elegí un sorteo.");
      return;
    }
    if (promos.length > 0 && !promoId) {
      setSubmitErr("Elegí una promo (o “Otro monto” para cargarlo a mano).");
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
    if (!Number.isFinite(monto) || monto < 0) {
      setSubmitErr("El monto total debe ser mayor o igual a 0.");
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
          cantidad_boletos: cantidad,
          monto_total: monto,
          observacion_interna: form.observacion_interna.trim() || null,
          generar_ticket_png: form.generar_ticket_png,
          idempotency_key: idempotencyKey,
          codigo_verificador: form.codigo_verificador.trim() || null,
          promo_nombre: promoSel?.label ?? null,
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
        setSubmitErr(json.error ?? "No se pudo registrar la venta.");
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
      });
      /** Con ticket generado, el modal es el cierre de la venta: ver, enviar o imprimir. */
      if (deliveryId) setTicketOpen(true);
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

      {loadingPromos && promos.length === 0 ? (
        <p className="text-xs text-slate-500">Cargando promos…</p>
      ) : null}

      {promos.length > 0 ? (
        <div className="flex flex-col gap-1.5 text-xs text-slate-600">
          <span>Promo *</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {promos.map((p) => {
              const sel = p.id === promoId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onPromoChange(p.id)}
                  aria-pressed={sel}
                  className={`flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    sel
                      ? "border-[#4FAEB2] bg-[#4FAEB2]/10 text-slate-900 ring-2 ring-[#4FAEB2]/25"
                      : "border-slate-200 bg-white text-slate-700 hover:border-[#4FAEB2]/60"
                  }`}
                >
                  <span className="text-sm font-semibold leading-tight">{p.label}</span>
                  <span className="text-[11px] text-slate-500">
                    {p.cantidad} {p.cantidad === 1 ? "boleta" : "boletas"}
                    {p.monto != null ? ` · Gs. ${formatGs(p.monto)}` : " · precio de lista"}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => onPromoChange(MANUAL_PROMO_ID)}
              aria-pressed={promoId === MANUAL_PROMO_ID}
              className={`flex flex-col items-start gap-0.5 rounded-xl border border-dashed px-3 py-2.5 text-left transition-colors ${
                promoId === MANUAL_PROMO_ID
                  ? "border-[#4FAEB2] bg-[#4FAEB2]/10 text-slate-900 ring-2 ring-[#4FAEB2]/25"
                  : "border-slate-300 bg-white text-slate-700 hover:border-[#4FAEB2]/60"
              }`}
            >
              <span className="text-sm font-semibold leading-tight">Otro monto</span>
              <span className="text-[11px] text-slate-500">Cargar cantidad y monto a mano</span>
            </button>
          </div>
        </div>
      ) : null}

      {modoManual ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-2">
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            Cantidad boletos *
            <input
              name="cantidad_boletos"
              type="number"
              min={1}
              step={1}
              value={form.cantidad_boletos}
              onChange={onField}
              required
              className="border border-slate-300 rounded px-3 py-2.5 text-base sm:px-2 sm:py-2 sm:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            Monto total (₲) *
            <input
              name="monto_total"
              type="number"
              min={0}
              step={1}
              value={form.monto_total}
              onChange={onField}
              required
              className="border border-slate-300 rounded px-3 py-2.5 text-base tabular-nums sm:px-2 sm:py-2 sm:text-sm"
            />
          </label>
        </div>
      ) : promoSel ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
          <div className="flex items-baseline justify-between gap-3">
            <span>
              {promoSel.cantidad} {promoSel.cantidad === 1 ? "boleta" : "boletas"}
            </span>
            <span className="text-base font-semibold tabular-nums text-slate-900">
              Gs. {formatGs(Number(form.monto_total) || 0)}
            </span>
          </div>
          {promoSel.monto == null ? (
            <label className="mt-2 flex flex-col gap-1">
              Monto total (₲) *
              <input
                name="monto_total"
                type="number"
                min={0}
                step={1}
                value={form.monto_total}
                onChange={onField}
                required
                className="rounded border border-slate-300 px-3 py-2.5 text-base tabular-nums sm:px-2 sm:py-2 sm:text-sm"
              />
            </label>
          ) : null}
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Método de pago
        <input
          value="Efectivo"
          readOnly
          className="border border-slate-200 bg-slate-50 rounded px-3 py-2.5 text-base text-slate-700 sm:px-2 sm:py-2 sm:text-sm"
        />
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
      />
    </form>
  );
}
