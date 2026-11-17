"use client";

import { useState } from "react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

const DEFAULT_ORDERS = "1219, 1220, 1221, 1222, 1223, 1225, 1226, 1227, 1229";

export default function RegularizarProvisoriasPage() {
  const [orders, setOrders] = useState<string>(DEFAULT_ORDERS);
  const [reenviar, setReenviar] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  function parseOrders(): number[] {
    return Array.from(
      new Set(
        orders
          .split(/[^0-9]+/)
          .map((x) => parseInt(x.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
      )
    );
  }

  async function run() {
    const nums = parseOrders();
    if (nums.length === 0) {
      setError("Poné al menos un número de orden.");
      return;
    }
    const msg = reenviar
      ? `Regenerar SIN banner y REENVIAR por WhatsApp ${nums.length} boleta(s):\n${nums.join(", ")}\n\n¿Confirmás? (solo se tocan las CONFIRMADAS)`
      : `Solo REGENERAR (sin reenviar) ${nums.length} boleta(s):\n${nums.join(", ")}\n\n¿Confirmás?`;
    if (!window.confirm(msg)) return;

    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetchWithSupabaseSession(
        "/api/sorteos/tickets/batch-regularizar",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ numeros_orden: nums, reenviar }),
        }
      );
      const json = (await res.json()) as { ok?: boolean; error?: string; data?: unknown };
      if (!res.ok || json?.ok === false) {
        setError(json?.error || `Error (HTTP ${res.status})`);
      } else {
        setResult(json?.data ?? json);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">Regularizar boletas provisorias</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
        Regenera la boleta <b>sin el banner rojo &quot;PROVISORIA&quot;</b> (misma numeración, nueva
        revisión) y, si está tildado, la <b>reenvía</b> al cliente por WhatsApp. Solo actúa sobre
        órdenes <b>confirmadas</b>. Usar únicamente para las órdenes afectadas (banner provisorio).
      </p>

      <label className="mt-4 block text-sm font-medium">Números de orden (separados por coma)</label>
      <textarea
        value={orders}
        onChange={(e) => setOrders(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded-lg border border-neutral-300 p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={reenviar}
          onChange={(e) => setReenviar(e.target.checked)}
        />
        Reenviar por WhatsApp (destildá para solo regenerar y verificar primero)
      </label>

      <div className="mt-4">
        <button
          onClick={() => void run()}
          disabled={loading}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Procesando…" : reenviar ? "Regenerar sin banner y reenviar" : "Solo regenerar"}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {result != null && (
        <pre className="mt-4 overflow-auto rounded-lg bg-neutral-100 p-3 text-xs dark:bg-neutral-800">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
