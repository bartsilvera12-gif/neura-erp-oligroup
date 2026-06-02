"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, X, RefreshCw, AlertTriangle, Filter } from "lucide-react";

interface ByTagRow {
  tag_id: string;
  tag_code: string;
  tag_label: string;
  tag_color: string | null;
  n: number;
}

interface CountersTagRow {
  tag_id: string;
  code: string;
  label: string;
  color: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  applied_count: number;
  hidden_count: number;
  dry_run_last24h_count: number;
}

interface CountersResponse {
  ok: boolean;
  error?: string;
  totals?: { tags: number; applied: number; hidden: number; dry_run_last24h: number };
  tags?: CountersTagRow[];
}

interface ConversationRow {
  conversation_id: string;
  contact_id: string | null;
  tag_id: string | null;
  tag_code: string | null;
  tag_label: string | null;
  tag_color: string | null;
  contact_name: string | null;
  phone_masked: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  current_node_code: string | null;
  hidden_by_tag: boolean;
  last_tagged_at: string | null;
}

interface ConversationsResponse {
  ok: boolean;
  error?: string;
  filters?: Record<string, unknown>;
  pagination?: { limit: number; offset: number; total: number };
  rows?: ConversationRow[];
}

interface ConversationPreviewMessage {
  id: string;
  from_me: boolean;
  sender_type: string | null;
  message_type: string | null;
  content: string | null;
  created_at: string | null;
  whatsapp_delivery_status: string | null;
}

interface ConversationPreviewResponse {
  ok: boolean;
  error?: string;
  conversation?: {
    conversation_id: string;
    status: string | null;
    flow_status: string | null;
    flow_current_node: string | null;
    human_taken_over: boolean;
    last_message_at: string | null;
    hidden_by_tag: boolean;
    current_tag_id: string | null;
    contact: {
      contact_id: string | null;
      name: string | null;
      phone_masked: string | null;
    };
  };
  messages?: ConversationPreviewMessage[];
  message_count?: number;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-PY", { dateStyle: "short", timeStyle: "short" });
}

const TAG_COLOR: Record<string, string> = {
  compro_varias: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  compro_boleta: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  comprobante_pendiente: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  datos_incompletos: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
  no_compro: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
};

function tagPillClass(code: string): string {
  return TAG_COLOR[code] ?? "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

const INPUT_CN =
  "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20";
const SELECT_CN =
  "w-full appearance-none rounded-xl border border-slate-200 bg-white px-3 py-2 pr-8 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 focus:border-[#4FAEB2] focus:outline-none focus:ring-2 focus:ring-[#4FAEB2]/20";
const BTN_PRIMARY_CN =
  "inline-flex items-center gap-1.5 rounded-xl bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] disabled:opacity-50";
const BTN_SECONDARY_CN =
  "inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91] disabled:opacity-50";

export default function EtiquetasClient() {
  // Filtros
  const [tagCode, setTagCode] = useState("");
  const [phone, setPhone] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);

  // Data: contadores vigentes (vienen de /api/chat/tags/counters al montar)
  // Cuenta sobre chat_conversations.current_tag_id, NO sobre history.dry_run.
  const [counterTags, setCounterTags] = useState<CountersTagRow[]>([]);
  const [totalApplied, setTotalApplied] = useState(0);
  const [loadingCounters, setLoadingCounters] = useState(true);
  const [countersError, setCountersError] = useState<string | null>(null);

  // Data: listado de conversaciones realmente etiquetadas
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // No cargar al entrar. Solo cuando el usuario aplica filtros.
  const [hasSearched, setHasSearched] = useState(false);
  // Filtros efectivamente aplicados (los que viajan a la API).
  const [appliedFilters, setAppliedFilters] = useState<{
    tagCode: string; phone: string; dateFrom: string; dateTo: string;
  } | null>(null);

  // Carga inicial de contadores + tags vigentes (chat_conversations.current_tag_id).
  const fetchCounters = useCallback(async () => {
    setLoadingCounters(true);
    setCountersError(null);
    try {
      const res = await fetch("/api/chat/tags/counters", { cache: "no-store" });
      const json: CountersResponse = await res.json();
      if (!json.ok) {
        setCountersError(json.error || "Error al cargar contadores");
        setCounterTags([]);
        setTotalApplied(0);
        return;
      }
      setCounterTags(json.tags ?? []);
      setTotalApplied(json.totals?.applied ?? 0);
    } catch (e) {
      setCountersError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setLoadingCounters(false);
    }
  }, []);

  useEffect(() => {
    void fetchCounters();
  }, [fetchCounters]);

  // ByTagRow derivado de los counters (lo que pinta las cards y el dropdown).
  const byTag: ByTagRow[] = useMemo(
    () =>
      counterTags
        .slice()
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.code.localeCompare(b.code))
        .map((t) => ({
          tag_id: t.tag_id,
          tag_code: t.code,
          tag_label: t.label,
          tag_color: t.color,
          n: t.applied_count,
        })),
    [counterTags]
  );

  // Modal
  const [modalConvId, setModalConvId] = useState<string | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalData, setModalData] = useState<ConversationPreviewResponse | null>(null);

  // Cuántos filtros tiene actualmente seleccionados el usuario (sin aplicarlos aun).
  const filtersActiveCount = useMemo(() => {
    let n = 0;
    if (tagCode) n++;
    if (phone) n++;
    if (dateFrom) n++;
    if (dateTo) n++;
    return n;
  }, [tagCode, phone, dateFrom, dateTo]);

  // Helper: construye la querystring a partir de un set de filtros aplicados y offset.
  const buildQuery = useCallback(
    (
      f: { tagCode: string; phone: string; dateFrom: string; dateTo: string },
      off: number
    ) => {
      const sp = new URLSearchParams();
      if (f.tagCode) sp.set("tag_code", f.tagCode);
      if (f.phone) sp.set("phone", f.phone);
      if (f.dateFrom) sp.set("date_from", f.dateFrom);
      if (f.dateTo) sp.set("date_to", f.dateTo);
      sp.set("limit", String(limit));
      sp.set("offset", String(off));
      return sp.toString();
    },
    [limit]
  );

  // Lee conversaciones realmente etiquetadas (chat_conversations.current_tag_id).
  const fetchConversations = useCallback(
    async (
      f: { tagCode: string; phone: string; dateFrom: string; dateTo: string },
      off: number
    ) => {
      setLoading(true);
      setError(null);
      try {
        const qs = buildQuery(f, off);
        const res = await fetch(`/api/chat/tags/conversations?${qs}`, { cache: "no-store" });
        const json: ConversationsResponse = await res.json();
        if (!json.ok) {
          setError(json.error || "Error al cargar");
          setRows([]);
          setTotal(0);
          return;
        }
        setRows(json.rows ?? []);
        setTotal(json.pagination?.total ?? 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error inesperado");
      } finally {
        setLoading(false);
      }
    },
    [buildQuery]
  );

  // Buscar: valida que haya al menos un filtro y dispara fetch con offset=0.
  const handleSearch = useCallback(() => {
    if (filtersActiveCount === 0) {
      setError("Elegí al menos un filtro para consultar.");
      return;
    }
    const next = { tagCode, phone, dateFrom, dateTo };
    setAppliedFilters(next);
    setOffset(0);
    setHasSearched(true);
    void fetchConversations(next, 0);
  }, [filtersActiveCount, tagCode, phone, dateFrom, dateTo, fetchConversations]);

  // Recargar: refresca la lista (si ya hay filtros) y también el contador superior.
  const handleReload = useCallback(() => {
    void fetchCounters();
    if (!appliedFilters) {
      setError("Aplicá un filtro primero.");
      return;
    }
    void fetchConversations(appliedFilters, offset);
  }, [appliedFilters, offset, fetchConversations, fetchCounters]);

  // Paginación: solo si ya hay filtros aplicados.
  const handlePage = useCallback(
    (newOffset: number) => {
      if (!appliedFilters) return;
      setOffset(newOffset);
      void fetchConversations(appliedFilters, newOffset);
    },
    [appliedFilters, fetchConversations]
  );

  const openModal = useCallback(async (conversationId: string) => {
    setModalConvId(conversationId);
    setModalData(null);
    setModalError(null);
    setModalLoading(true);
    try {
      const res = await fetch(
        `/api/chat/tags/conversation-preview?conversation_id=${encodeURIComponent(conversationId)}&limit=50`,
        { cache: "no-store" }
      );
      const json: ConversationPreviewResponse = await res.json();
      if (!json.ok) {
        setModalError(json.error || "Error al cargar conversación");
      } else {
        setModalData(json);
      }
    } catch (e) {
      setModalError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setModalLoading(false);
    }
  }, []);

  const closeModal = useCallback(() => {
    setModalConvId(null);
    setModalData(null);
    setModalError(null);
  }, []);

  const resetFilters = useCallback(() => {
    setTagCode("");
    setPhone("");
    setDateFrom("");
    setDateTo("");
    setOffset(0);
    setAppliedFilters(null);
    setRows([]);
    setTotal(0);
    setHasSearched(false);
    setError(null);
  }, []);

  // grandTotal = suma de applied_count vigente sobre chat_conversations.
  const grandTotal = totalApplied;

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="block h-7 w-1.5 rounded-full bg-[#4FAEB2]" />
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Etiquetas Automáticas</h1>
            <p className="mt-1 text-sm text-slate-500">
              Conversaciones clasificadas automáticamente según el estado del WhatsApp.
              Si el cliente vuelve a escribir, reaparecen en Conversaciones.
            </p>
          </div>
        </div>
        <div className="inline-flex max-w-md items-center gap-2 rounded-xl border border-[#4FAEB2]/40 bg-[#4FAEB2]/10 px-3 py-2 text-xs font-medium text-[#3F8E91] shadow-sm">
          <AlertTriangle size={14} className="text-[#4FAEB2] shrink-0" />
          <span>Las conversaciones etiquetadas salen de Conversaciones. Si el cliente vuelve a escribir, reaparecen automáticamente.</span>
        </div>
      </header>

      {/* Cards por etiqueta — siempre visibles, leen el estado VIGENTE de chat_conversations.current_tag_id */}
      {countersError && (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {countersError}
        </div>
      )}
      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-2xl border border-[#4FAEB2]/45 bg-white p-4 shadow-sm">
          <div className="text-[11px] uppercase tracking-[0.1em] text-slate-500">Total etiquetadas</div>
          <div className="mt-1.5 text-2xl font-semibold text-slate-900">
            {loadingCounters ? "…" : grandTotal.toLocaleString("es-PY")}
          </div>
        </div>
        {byTag.map((t) => {
          const active = tagCode === t.tag_code;
          return (
            <button
              key={t.tag_code}
              onClick={() => {
                const next = t.tag_code === tagCode ? "" : t.tag_code;
                setTagCode(next);
                if (appliedFilters) {
                  const applied = { ...appliedFilters, tagCode: next };
                  setAppliedFilters(applied);
                  setOffset(0);
                  void fetchConversations(applied, 0);
                }
              }}
              className={`rounded-2xl border bg-white p-4 text-left shadow-sm transition-colors ${
                active
                  ? "border-[#4FAEB2] ring-2 ring-[#4FAEB2]/25"
                  : "border-slate-200 hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5"
              }`}
              type="button"
            >
              <div className="text-[11px] uppercase tracking-[0.1em] text-slate-500">
                {t.tag_label || t.tag_code}
              </div>
              <div className="mt-1.5 text-2xl font-semibold text-slate-900">
                {loadingCounters ? "…" : t.n.toLocaleString("es-PY")}
              </div>
              <div className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[10px] ${tagPillClass(t.tag_code)}`}>
                {t.tag_code}
              </div>
            </button>
          );
        })}
      </section>

      {/* Filtros */}
      <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]" />
          <h2 className="text-sm font-semibold text-slate-700">Filtros</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Etiqueta</label>
            <select
              value={tagCode}
              onChange={(e) => setTagCode(e.target.value)}
              className={SELECT_CN}
            >
              <option value="">Todas las etiquetas</option>
              {byTag.map((t) => (
                <option key={t.tag_code} value={t.tag_code}>{t.tag_label || t.tag_code}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Teléfono / Número (parcial)</label>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Ej. 2713"
              className={INPUT_CN}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Último mensaje desde</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className={INPUT_CN}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Último mensaje hasta</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className={INPUT_CN}
            />
          </div>
          {/* run_key y current_node eliminados: la UI consulta el estado vigente, no snapshots. */}
        </div>
      </section>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={handleSearch}
          className={BTN_PRIMARY_CN}
          type="button"
          disabled={loading || filtersActiveCount === 0}
          title={filtersActiveCount === 0 ? "Elegí al menos un filtro para consultar." : undefined}
        >
          <Filter size={14} />
          Buscar
        </button>
        <button
          onClick={handleReload}
          className={BTN_SECONDARY_CN}
          type="button"
          disabled={loading || !appliedFilters}
          title={!appliedFilters ? "Aplicá un filtro primero." : undefined}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Recargar
        </button>
        <button
          onClick={resetFilters}
          className={BTN_SECONDARY_CN}
          type="button"
        >
          Limpiar filtros
        </button>
        <div className="ml-auto text-xs text-slate-500">
          {loading
            ? "Cargando…"
            : !hasSearched
              ? filtersActiveCount === 0
                ? "Elegí al menos un filtro y presioná Buscar."
                : `${filtersActiveCount} filtro(s) listos. Presioná Buscar.`
              : `Mostrando ${rows.length} de ${total.toLocaleString("es-PY")}`}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Tabla */}
      {!hasSearched ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <Filter className="mx-auto mb-3 h-8 w-8 text-[#4FAEB2]" />
          <h3 className="text-base font-semibold text-slate-800">Aplicá un filtro para consultar etiquetas.</h3>
          <p className="mt-1 text-sm text-slate-500">
            Las sugerencias son livianas y se calculan a pedido. Elegí una etiqueta, número o rango de fechas y presioná
            <span className="mx-1 font-medium text-slate-700">Buscar</span>.
          </p>
        </div>
      ) : (
      <div className="overflow-x-auto rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Etiqueta</th>
              <th className="px-4 py-3">Contacto</th>
              <th className="px-4 py-3">Teléfono</th>
              <th className="px-4 py-3">Último mensaje</th>
              <th className="px-4 py-3">Vista previa</th>
              <th className="px-4 py-3 text-right">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  Sin resultados para los filtros seleccionados.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.conversation_id} className="transition-colors hover:bg-[#4FAEB2]/5">
                <td className="px-4 py-2.5">
                  {r.tag_code ? (
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tagPillClass(r.tag_code)}`}>
                      {r.tag_label || r.tag_code}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slate-700">
                  {r.contact_name || <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-2.5 font-mono text-sm font-semibold text-slate-800 tracking-wider">
                  {r.phone_masked || "—"}
                </td>
                <td className="px-4 py-2.5 text-slate-500">{formatDate(r.last_message_at)}</td>
                <td className="px-4 py-2.5 text-slate-500 max-w-xs truncate" title={r.last_message_preview ?? ""}>
                  {r.last_message_preview ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() => openModal(r.conversation_id)}
                    className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
                    title="Ver últimos mensajes"
                  >
                    <Search size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {/* Paginación simple - solo si hay busqueda activa */}
      {hasSearched && (
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <span>Offset: {offset}</span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={offset === 0 || loading}
            onClick={() => handlePage(Math.max(0, offset - limit))}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91] disabled:opacity-40"
          >
            Anterior
          </button>
          <button
            type="button"
            disabled={offset + limit >= total || loading}
            onClick={() => handlePage(offset + limit)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91] disabled:opacity-40"
          >
            Siguiente
          </button>
        </div>
      </div>
      )}

      {/* Modal */}
      {modalConvId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={closeModal}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#4FAEB2]/45 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white p-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900">
                  {modalData?.conversation?.contact?.name || "Conversación"}
                </div>
                <div className="truncate font-mono text-xs text-slate-500">
                  {modalData?.conversation?.contact?.phone_masked || modalConvId.slice(0, 8)}
                  {modalData?.conversation?.flow_current_node
                    ? ` · nodo: ${modalData.conversation.flow_current_node}`
                    : ""}
                </div>
              </div>
              <button
                onClick={closeModal}
                className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 shadow-sm transition-colors hover:border-[#4FAEB2]/60 hover:bg-[#4FAEB2]/5 hover:text-[#3F8E91]"
                type="button"
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4">
              {modalLoading && (
                <div className="text-center text-sm text-slate-500">
                  Cargando últimos 50 mensajes…
                </div>
              )}
              {modalError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  {modalError}
                </div>
              )}
              {modalData?.messages?.length === 0 && !modalLoading && (
                <div className="text-center text-sm text-slate-500">Sin mensajes.</div>
              )}
              {modalData?.messages?.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[80%] rounded-2xl border px-3 py-2 shadow-sm ${
                    m.from_me
                      ? "ml-auto border-[#4FAEB2]/30 bg-[#4FAEB2]/10 text-slate-800"
                      : "mr-auto border-slate-200 bg-white text-slate-800"
                  }`}
                >
                  <div className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                    {m.from_me ? "Saliente" : "Entrante"} · {m.message_type || "text"}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm">
                    {m.content || <span className="italic text-slate-400">(sin contenido)</span>}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-400">{formatDate(m.created_at)}</div>
                </div>
              ))}
            </div>
            <footer className="border-t border-slate-200 bg-white p-3 text-[11px] text-slate-500">
              Vista de conversación. Esta etiqueta es una sugerencia del snapshot, no una clasificación definitiva.
              No envía mensajes ni modifica el chat.
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
