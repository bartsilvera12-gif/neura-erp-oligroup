"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { SorteoRevendedorRow } from "@/lib/sorteos/revendedores-actions";
import {
  createRevendedor,
  getRevendedorStats,
  setRevendedorActivo,
  type RevendedorStats,
} from "@/lib/sorteos/revendedores-actions";

function publicReferralLink(baseUrl: string, codigo: string, sorteoId: string): string {
  const origin = baseUrl.replace(/\/$/, "");
  const c = encodeURIComponent(codigo.trim());
  return `${origin}/r/${c}?sorteo=${sorteoId}`;
}

function qrDataUrl(link: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(link)}`;
}

export default function SorteoRevendedoresClient(props: {
  sorteoId: string;
  sorteoNombre: string;
  initialRows: SorteoRevendedorRow[];
  baseUrl: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(props.initialRows);
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [codigo, setCodigo] = useState("");
  const [verificador, setVerificador] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statsById, setStatsById] = useState<Record<string, RevendedorStats>>({});
  const [loadingStats, setLoadingStats] = useState<string | null>(null);

  const hintPhone = useMemo(() => {
    return (
      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        El enlace público redirige a WhatsApp usando{" "}
        <code className="text-[11px] bg-white px-1 rounded">WHATSAPP_LINK_PHONE_NUMBER</code> en el servidor
        (E.164 sin +, mismo número al que escriben los clientes).
      </p>
    );
  }, []);

  async function refresh() {
    const { listRevendedoresBySorteo } = await import("@/lib/sorteos/revendedores-actions");
    const next = await listRevendedoresBySorteo(props.sorteoId);
    setRows(next);
    router.refresh();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    try {
      await createRevendedor(props.sorteoId, {
        nombre,
        telefono: telefono.trim() || null,
        codigo_referido: codigo.trim(),
        codigo_verificador: verificador,
        activo: true,
      });
      setNombre("");
      setTelefono("");
      setCodigo("");
      setVerificador("");
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Error al crear");
    } finally {
      setSaving(false);
    }
  }

  async function loadStats(id: string) {
    if (statsById[id]) return;
    setLoadingStats(id);
    try {
      const s = await getRevendedorStats(id);
      setStatsById((m) => ({ ...m, [id]: s }));
    } catch {
      /* ignore */
    } finally {
      setLoadingStats(null);
    }
  }

  async function toggleActivo(r: SorteoRevendedorRow) {
    try {
      await setRevendedorActivo(r.id, !r.activo);
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Error");
    }
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/sorteos" className="hover:text-slate-800">
          Sorteos
        </Link>
        <span>/</span>
        <Link href={`/sorteos/${props.sorteoId}/editar`} className="hover:text-slate-800">
          Editar
        </Link>
        <span>/</span>
        <span className="text-slate-800 font-medium">Revendedores</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-gray-800">Revendedores</h1>
        <p className="text-sm text-slate-600 mt-1">{props.sorteoNombre}</p>
      </div>

      {hintPhone}

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2" role="alert">
          {err}
        </div>
      )}

      <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-4">
        <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wide">Nuevo revendedor</h2>
        <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-slate-600 mb-1">Nombre</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Teléfono (contacto)</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Código referido (único por sorteo)</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Código verificador (4 dígitos)</label>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono tracking-widest"
              value={verificador}
              onChange={(e) => setVerificador(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="1234"
              inputMode="numeric"
              pattern="\d{4}"
              minLength={4}
              maxLength={4}
              title="Exactamente 4 dígitos"
              required
            />
          </div>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="bg-[#4FAEB2] hover:bg-[#3F8E91] disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              {saving ? "Guardando…" : "Crear revendedor"}
            </button>
          </div>
        </form>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wide">Listado</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">No hay revendedores todavía.</p>
        ) : (
          <ul className="space-y-4">
            {rows.map((r) => {
              const link =
                props.baseUrl.trim() !== ""
                  ? publicReferralLink(props.baseUrl, r.codigo_referido, props.sorteoId)
                  : `(configurá dominio público) /r/${encodeURIComponent(r.codigo_referido)}?sorteo=${props.sorteoId}`;
              const st = statsById[r.id];
              return (
                <li
                  key={r.id}
                  className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-900">{r.nombre}</div>
                      <div className="text-xs text-slate-500 font-mono">código: {r.codigo_referido}</div>
                      <div className="text-xs text-slate-500 font-mono">
                        verificador: {r.codigo_verificador ?? "— (sin asignar)"}
                      </div>
                      {r.telefono ? (
                        <div className="text-xs text-slate-500">tel: {r.telefono}</div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${r.activo ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}
                      >
                        {r.activo ? "activo" : "inactivo"}
                      </span>
                      <button
                        type="button"
                        onClick={() => void toggleActivo(r)}
                        className="text-xs text-[#4FAEB2] hover:underline"
                      >
                        {r.activo ? "Desactivar" : "Activar"}
                      </button>
                      <Link
                        href={`/sorteos/${props.sorteoId}/revendedores/${r.id}/editar`}
                        className="text-xs text-slate-600 hover:underline"
                      >
                        Editar
                      </Link>
                    </div>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-xs font-medium text-slate-500 mb-1">Link oficial</div>
                      <div className="break-all text-[#4FAEB2] text-xs">{link}</div>
                    </div>
                    <div className="flex gap-3 items-start">
                      {props.baseUrl.trim() !== "" && r.activo ? (
                        <img
                          src={qrDataUrl(publicReferralLink(props.baseUrl, r.codigo_referido, props.sorteoId))}
                          alt={`QR ${r.codigo_referido}`}
                          width={120}
                          height={120}
                          className="border border-slate-200 rounded-lg bg-white"
                        />
                      ) : (
                        <span className="text-xs text-slate-400">QR disponible con URL base pública</span>
                      )}
                    </div>
                  </div>
                  <div className="border-t border-slate-100 pt-2">
                    <button
                      type="button"
                      onClick={() => void loadStats(r.id)}
                      className="text-xs text-slate-600 hover:text-slate-900 underline"
                    >
                      {st ? "Actualizar métricas" : loadingStats === r.id ? "Cargando…" : "Ver métricas"}
                    </button>
                    {st ? (
                      <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs text-slate-600">
                        <div>
                          Clicks: <strong className="text-slate-900">{st.clicks}</strong>
                        </div>
                        <div>
                          Clicks canjeados: <strong className="text-slate-900">{st.clicks_redeemed}</strong>
                        </div>
                        <div>
                          Sesiones: <strong className="text-slate-900">{st.sesiones_atribuidas}</strong>
                        </div>
                        <div>
                          Órdenes: <strong className="text-slate-900">{st.ordenes}</strong>
                        </div>
                        <div>
                          Monto (PYG): <strong className="text-slate-900">{Math.round(st.monto_total)}</strong>
                        </div>
                        <div>
                          Cupones: <strong className="text-slate-900">{st.cupones}</strong>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
