"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

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

/** Lista de sorteos del tenant (GET /api/sorteos), priorizando los activos. */
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
        const res = await fetchWithSupabaseSession("/api/sorteos", { cache: "no-store" });
        const json = (await res.json()) as { success?: boolean; data?: SorteoListItem[] };
        if (!res.ok || !json.success || !Array.isArray(json.data)) {
          if (!cancelled) setLoadErr("No se pudieron cargar los sorteos.");
          return;
        }
        if (!cancelled) {
          const activos = json.data.filter((s) => (s.estado ?? "activo") === "activo");
          setSorteos(activos.length > 0 ? activos : json.data);
        }
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

const EMPTY_FIELDS = {
  nombre: "",
  apellido: "",
  cedula: "",
  telefono: "",
  cantidad_boletos: "1",
  monto_total: "",
  observacion_interna: "",
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

  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
    setSubmitErr(null);
    setSubmitOk(null);
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

    const cantidad = Math.floor(Number(form.cantidad_boletos));
    const monto = Number(form.monto_total);
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
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        data?: {
          entrada_id?: string;
          numero_orden?: number;
          ticket?: { attempted?: boolean; delivery_ok?: boolean; skipped?: boolean; reason?: string };
        };
        error?: string;
      };
      if (!res.ok || !json.success) {
        setSubmitErr(json.error ?? "No se pudo registrar la venta.");
        return;
      }

      const num = json.data?.numero_orden ?? "—";
      let msg = `Orden Nº ${num} creada correctamente (pago confirmado).`;
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
    <form onSubmit={onSubmit} className="p-5 space-y-3 text-sm">
      <p className="text-slate-600 text-xs">
        Registra comprador y monto; se confirma el pago al guardar. No se envía WhatsApp ni se crea
        conversación.
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
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900 text-xs">
          {submitOk}
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
            className="border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
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

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          Nombre *
          <input
            name="nombre"
            value={form.nombre}
            onChange={onField}
            required
            className="border border-slate-300 rounded px-2 py-2 text-sm"
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
            className="border border-slate-300 rounded px-2 py-2 text-sm"
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
          className="border border-slate-300 rounded px-2 py-2 text-sm font-mono"
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
          className="border border-slate-300 rounded px-2 py-2 text-sm font-mono"
          autoComplete="tel"
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
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
            className="border border-slate-300 rounded px-2 py-2 text-sm"
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
            className="border border-slate-300 rounded px-2 py-2 text-sm tabular-nums"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Método de pago
        <input
          value="Efectivo"
          readOnly
          className="border border-slate-200 bg-slate-50 rounded px-2 py-2 text-sm text-slate-700"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-slate-600">
        Observación interna (opcional)
        <textarea
          name="observacion_interna"
          value={form.observacion_interna}
          onChange={onField}
          rows={2}
          className="border border-slate-300 rounded px-2 py-2 text-sm"
        />
      </label>

      <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
        <input
          type="checkbox"
          name="generar_ticket_png"
          checked={form.generar_ticket_png}
          onChange={onField}
        />
        Generar ticket PNG (si el sorteo tiene imagen configurada)
      </label>

      <div className="flex flex-wrap gap-2 pt-2">
        <button
          type="submit"
          disabled={loading}
          className="bg-[#4FAEB2] text-white font-medium px-4 py-2 rounded-lg hover:bg-[#3F8E91] disabled:opacity-60"
        >
          {loading ? "Guardando…" : "Guardar venta"}
        </button>
        {onClose ? (
          <button type="button" className="text-slate-600 underline px-2 py-2" onClick={onClose}>
            Cerrar
          </button>
        ) : null}
      </div>
    </form>
  );
}
