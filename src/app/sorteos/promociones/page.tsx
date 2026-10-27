"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { isPromoVisibleNow } from "@/lib/sorteos/promo-window";

type Promo = {
  optionId: string;
  label: string;
  cantidad: number | null;
  monto: number | null;
  dias: number[];
  horaInicio: string;
  duracionHoras: number;
  activa: boolean;
};

type PromosData = {
  flow_code: string | null;
  node_code: string | null;
  detectado: boolean;
  normales_count: number;
  promos: Promo[];
};

const DIAS: { d: number; t: string }[] = [
  { d: 1, t: "Lun" },
  { d: 2, t: "Mar" },
  { d: 3, t: "Mié" },
  { d: 4, t: "Jue" },
  { d: 5, t: "Vie" },
  { d: 6, t: "Sáb" },
  { d: 7, t: "Dom" },
];

function gs(n: number | null): string {
  if (n == null) return "—";
  return "Gs. " + n.toLocaleString("es-PY");
}

function diasLabel(dias: number[]): string {
  if (dias.length === 0) return "—";
  if (dias.length === 7) return "Todos los días";
  return dias
    .slice()
    .sort((a, b) => a - b)
    .map((d) => DIAS.find((x) => x.d === d)?.t ?? d)
    .join(", ");
}

function enVivoAhora(p: Promo): boolean {
  return isPromoVisibleNow({
    promo_ventana: {
      activa: p.activa,
      dias: p.dias,
      hora_inicio: p.horaInicio,
      duracion_horas: p.duracionHoras,
    },
  });
}

type FormState = {
  optionId: string | null;
  label: string;
  cantidad: string;
  monto: string;
  dias: number[];
  horaInicio: string;
  duracionHoras: string;
};

const EMPTY_FORM: FormState = {
  optionId: null,
  label: "",
  cantidad: "",
  monto: "",
  dias: [],
  horaInicio: "18:00",
  duracionHoras: "24",
};

export default function PromocionesPage() {
  const [data, setData] = useState<PromosData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession("/api/sorteos/promos", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: PromosData;
        error?: string;
      };
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error?.trim() || `No se pudo cargar (${res.status})`);
      }
      setData(json.data);
    } catch (e) {
      setData(null);
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const startNew = () => setForm({ ...EMPTY_FORM });
  const startEdit = (p: Promo) =>
    setForm({
      optionId: p.optionId,
      label: p.label,
      cantidad: p.cantidad != null ? String(p.cantidad) : "",
      monto: p.monto != null ? String(p.monto) : "",
      dias: p.dias,
      horaInicio: p.horaInicio,
      duracionHoras: String(p.duracionHoras),
    });

  const guardar = async (activa: boolean) => {
    if (!form) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession("/api/sorteos/promos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionId: form.optionId ?? undefined,
          label: form.label,
          cantidad: Number(form.cantidad),
          monto: Number(form.monto),
          dias: form.dias,
          hora_inicio: form.horaInicio,
          duracion_horas: Number(form.duracionHoras),
          activa,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        throw new Error(json.error?.trim() || `No se pudo guardar (${res.status})`);
      }
      setForm(null);
      await cargar();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  const togglePausa = async (p: Promo) => {
    setBusyId(p.optionId);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession("/api/sorteos/promos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionId: p.optionId,
          label: p.label,
          cantidad: p.cantidad,
          monto: p.monto,
          dias: p.dias,
          hora_inicio: p.horaInicio,
          duracion_horas: p.duracionHoras,
          activa: !p.activa,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error?.trim() || "No se pudo actualizar");
      await cargar();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusyId(null);
    }
  };

  const eliminar = async (p: Promo) => {
    if (!window.confirm(`¿Eliminar la promo "${p.label}"? Esto quita el botón del bot.`)) return;
    setBusyId(p.optionId);
    setErr(null);
    try {
      const res = await fetchWithSupabaseSession(
        `/api/sorteos/promos?optionId=${encodeURIComponent(p.optionId)}`,
        { method: "DELETE" }
      );
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error?.trim() || "No se pudo eliminar");
      await cargar();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusyId(null);
    }
  };

  const toggleDia = (d: number) =>
    setForm((f) =>
      f
        ? { ...f, dias: f.dias.includes(d) ? f.dias.filter((x) => x !== d) : [...f.dias, d].sort((a, b) => a - b) }
        : f
    );

  const sinMenuNormal = useMemo(
    () => data?.detectado === true && (data?.normales_count ?? 0) === 0,
    [data]
  );

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-xs text-slate-500">
        <Link href="/sorteos" className="font-medium text-slate-500 transition-colors hover:text-[#4FAEB2]">
          Sorteos
        </Link>
        <span aria-hidden className="text-slate-300">/</span>
        <span className="font-semibold text-slate-700">Promociones</span>
      </nav>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#3F8E91]">
            Sorteos · Promos programadas
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Promociones</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Promos tipo <b>7 boletas por 50.000</b> que el bot muestra <b>solo</b> en los días y la
            hora que elijas (hora de Paraguay). Se prenden y apagan solas, y se repiten cada semana.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void cargar()}
            disabled={loading}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:text-[#3F8E91] disabled:opacity-50"
          >
            {loading ? "Actualizando…" : "Actualizar"}
          </button>
          {data?.detectado ? (
            <button
              type="button"
              onClick={startNew}
              className="rounded-lg bg-[#3F8E91] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#357678]"
            >
              + Agregar promo
            </button>
          ) : null}
        </div>
      </div>

      {err ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{err}</div>
      ) : null}

      {sinMenuNormal ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ⚠️ Este paso del bot no tiene ningún botón <b>sin horario</b> (el menú/precio normal). Dejá
          siempre uno, para que el cliente tenga qué elegir cuando la promo está cerrada.
        </div>
      ) : null}

      {/* Sin flujo/nodo detectado */}
      {!loading && data && !data.detectado ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-500">
          No encontré el paso de combos en tu flujo de WhatsApp. Creá primero un combo normal
          (ej. “1 boleta”) en{" "}
          <Link href="/dashboard/conversaciones/flujos" className="font-medium text-[#3F8E91] hover:underline">
            Conversaciones → Flujos
          </Link>{" "}
          y volvé a esta pantalla.
        </div>
      ) : null}

      {/* Lista de promos */}
      {data?.detectado ? (
        <div className="overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-500">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#4FAEB2]" /> Cargando…
            </div>
          ) : data.promos.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-slate-400">
              Todavía no hay promos con horario. Tocá <b>“+ Agregar promo”</b> para crear la primera.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Promo</th>
                    <th className="px-4 py-3">Cantidad</th>
                    <th className="px-4 py-3">Precio</th>
                    <th className="px-4 py-3">Días</th>
                    <th className="px-4 py-3">Horario</th>
                    <th className="px-4 py-3">Estado</th>
                    <th className="px-4 py-3 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.promos.map((p) => {
                    const vivo = enVivoAhora(p);
                    return (
                      <tr key={p.optionId} className="transition-colors hover:bg-[#4FAEB2]/5">
                        <td className="px-4 py-3 font-medium text-slate-800">{p.label}</td>
                        <td className="px-4 py-3 text-slate-600">{p.cantidad ?? "—"} boletas</td>
                        <td className="px-4 py-3 text-slate-600">{gs(p.monto)}</td>
                        <td className="px-4 py-3 text-xs text-slate-600">{diasLabel(p.dias)}</td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {p.horaInicio} · {p.duracionHoras}h
                        </td>
                        <td className="px-4 py-3">
                          {!p.activa ? (
                            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                              Pausada
                            </span>
                          ) : vivo ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> EN VIVO
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
                              Programada
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => startEdit(p)}
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:border-[#4FAEB2]/60 hover:text-[#3F8E91]"
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              onClick={() => void togglePausa(p)}
                              disabled={busyId === p.optionId}
                              className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                            >
                              {p.activa ? "Pausar" : "Reactivar"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void eliminar(p)}
                              disabled={busyId === p.optionId}
                              className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                            >
                              Eliminar
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* Formulario alta/edición */}
      {form ? (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4">
          <div className="w-full max-w-lg rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {form.optionId ? "Editar promo" : "Nueva promo"}
              </h2>
              <button
                type="button"
                onClick={() => setForm(null)}
                className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:text-slate-700"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="mb-1 block text-[11px] font-medium text-slate-500">Texto del botón</label>
                <input
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="7 boletas 50.000"
                  maxLength={24}
                />
                <p className="mt-0.5 text-[10px] text-slate-400">
                  Lo que ve el cliente en el botón de WhatsApp (corto, máx. ~20-24 caracteres).
                </p>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-500">Cantidad de boletas</label>
                <input
                  type="number"
                  min={1}
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                  value={form.cantidad}
                  onChange={(e) => setForm({ ...form, cantidad: e.target.value })}
                  placeholder="7"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-500">Precio total (Gs.)</label>
                <input
                  type="number"
                  min={1}
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                  value={form.monto}
                  onChange={(e) => setForm({ ...form, monto: e.target.value })}
                  placeholder="50000"
                />
              </div>
              <div className="col-span-2">
                <label className="mb-1 block text-[11px] font-medium text-slate-500">Días</label>
                <div className="flex flex-wrap gap-1">
                  {DIAS.map(({ d, t }) => {
                    const on = form.dias.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleDia(d)}
                        className={`rounded-lg border px-2.5 py-1 text-xs ${
                          on
                            ? "border-[#3F8E91] bg-[#3F8E91] text-white"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-500">Hora de inicio</label>
                <input
                  type="time"
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                  value={form.horaInicio}
                  onChange={(e) => setForm({ ...form, horaInicio: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-500">Duración (horas)</label>
                <input
                  type="number"
                  min={1}
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                  value={form.duracionHoras}
                  onChange={(e) => setForm({ ...form, duracionHoras: e.target.value })}
                  placeholder="24"
                />
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setForm(null)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void guardar(true)}
                disabled={saving}
                className="rounded-lg bg-[#3F8E91] px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-[#357678] disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Guardar y activar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="text-[11px] leading-snug text-slate-400">
        Al guardar, el sistema crea o actualiza el botón en el bot por vos. Recordá dejar siempre un
        botón sin horario (el menú normal) en ese paso.
      </p>
    </div>
  );
}
