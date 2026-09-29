"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  listRevendedoresBySorteo,
  updateRevendedor,
  type SorteoRevendedorRow,
} from "@/lib/sorteos/revendedores-actions";

export default function EditarRevendedorPage() {
  const params = useParams();
  const router = useRouter();
  const sorteoId = String(params?.id ?? "");
  const revId = String(params?.revId ?? "");
  const [row, setRow] = useState<SorteoRevendedorRow | null>(null);
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [codigo, setCodigo] = useState("");
  const [verificador, setVerificador] = useState("");
  const [activo, setActivo] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sorteoId || !revId) return;
    listRevendedoresBySorteo(sorteoId)
      .then((rows) => {
        const r = rows.find((x) => x.id === revId) ?? null;
        setRow(r);
        if (r) {
          setNombre(r.nombre);
          setTelefono(r.telefono ?? "");
          setCodigo(r.codigo_referido);
          setVerificador(r.codigo_verificador ?? "");
          setActivo(r.activo);
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Error"))
      .finally(() => setLoading(false));
  }, [sorteoId, revId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    try {
      await updateRevendedor(revId, {
        nombre,
        telefono: telefono.trim() || null,
        codigo_referido: codigo.trim(),
        codigo_verificador: verificador,
        activo,
      });
      router.push(`/sorteos/${sorteoId}/revendedores`);
      router.refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="py-16 text-center text-slate-400 text-sm animate-pulse">Cargando…</div>;
  }

  if (!row) {
    return (
      <div className="space-y-4">
        <p className="text-red-600 text-sm">Revendedor no encontrado.</p>
        <Link href={`/sorteos/${sorteoId}/revendedores`} className="text-[#4FAEB2] text-sm hover:underline">
          Volver
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href={`/sorteos/${sorteoId}/revendedores`} className="hover:text-slate-800">
          Revendedores
        </Link>
        <span>/</span>
        <span className="text-slate-800 font-medium">Editar</span>
      </div>
      <h1 className="text-2xl font-bold text-gray-800">Editar revendedor</h1>
      {err && (
        <div className="bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-4 py-2">{err}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4 bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Nombre</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            value={telefono}
            onChange={(e) => setTelefono(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Código referido</label>
          <input
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
            value={codigo}
            onChange={(e) => setCodigo(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Código verificador (4 dígitos)</label>
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
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          Activo
        </label>
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="bg-[#4FAEB2] hover:bg-[#3F8E91] disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
          <Link
            href={`/sorteos/${sorteoId}/revendedores`}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
          >
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}
