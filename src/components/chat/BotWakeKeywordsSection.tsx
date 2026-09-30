"use client";

import { useState } from "react";
import {
  BOT_WAKE_KEYWORDS_MAX_COUNT,
  BOT_WAKE_KEYWORDS_MAX_LENGTH,
  normalizeWakeKeywordText,
  type BotWakeKeywordsFormState,
  type BotWakeKeywordsMatchMode,
} from "@/lib/chat/bot-wake-keywords";

type Props = {
  value: BotWakeKeywordsFormState;
  onChange: (v: BotWakeKeywordsFormState) => void;
};

export function BotWakeKeywordsSection({ value, onChange }: Props) {
  const [draft, setDraft] = useState("");
  const [tooLongNotice, setTooLongNotice] = useState(false);

  function setMatchMode(m: BotWakeKeywordsMatchMode) {
    onChange({ ...value, matchMode: m });
  }

  function addKeywords() {
    const raw = draft;
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;

    let hadTooLong = false;
    const existingNormalized = new Set(value.keywords.map((k) => normalizeWakeKeywordText(k)));
    const newKeywords = [...value.keywords];
    let added = 0;

    for (const part of parts) {
      if (newKeywords.length >= BOT_WAKE_KEYWORDS_MAX_COUNT) break;
      if (part.length > BOT_WAKE_KEYWORDS_MAX_LENGTH) {
        hadTooLong = true;
        continue;
      }
      const n = normalizeWakeKeywordText(part);
      if (!n) continue;
      if (existingNormalized.has(n)) continue;
      existingNormalized.add(n);
      newKeywords.push(part);
      added += 1;
    }

    setTooLongNotice(hadTooLong);

    if (added > 0) {
      onChange({ ...value, keywords: newKeywords });
      setDraft("");
    }
  }

  function removeAt(i: number) {
    onChange({ ...value, keywords: value.keywords.filter((_, j) => j !== i) });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[#4FAEB2]/40 bg-[#4FAEB2]/5 p-3">
        <label className="flex items-start gap-2 text-sm font-medium text-slate-800">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.wakeOnAnyMessage}
            onChange={(e) => onChange({ ...value, wakeOnAnyMessage: e.target.checked })}
          />
          Despertar el bot con cualquier mensaje
        </label>
        <p className="mt-1 text-xs text-slate-600">
          El bot manda el primer mensaje apenas la persona escribe, sin esperar a que alguien del equipo la
          atienda. Útil después de una campaña, cuando quedan muchas conversaciones esperando.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          No interrumpe a nadie: no se activa si la persona está a mitad del flujo, ni si alguien del equipo ya
          contestó en esa conversación.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        Usar palabras personalizadas en este canal
      </label>
      <p className="text-xs text-slate-500">
        Si está inactivo o la lista queda vacía, se usan las palabras predeterminadas del sistema (hola, menú,
        iniciar, etc.).
      </p>

      <div>
        <span className="block text-xs font-semibold text-slate-500 uppercase mb-1">
          Frases de varias palabras
        </span>
        <p className="text-xs text-slate-500 mb-2">
          &quot;Exacta&quot; solo dispara si el mensaje completo coincide. &quot;Prefijo&quot; también si el
          mensaje empieza con la frase y un espacio.
        </p>
        <div className="flex flex-wrap gap-3 text-sm">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="bot_wake_match_mode"
              checked={value.matchMode === "exact"}
              onChange={() => setMatchMode("exact")}
            />
            Exacta
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="bot_wake_match_mode"
              checked={value.matchMode === "starts_with"}
              onChange={() => setMatchMode("starts_with")}
            />
            Prefijo
          </label>
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-500 uppercase mb-1">Agregar palabra o frase</label>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
          <input
            className="flex-1 min-w-0 border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (tooLongNotice) setTooLongNotice(false);
            }}
            placeholder="Ej: hola, quiero, comprar más"
            disabled={!value.enabled}
          />
          <button
            type="button"
            onClick={addKeywords}
            disabled={!value.enabled}
            className="shrink-0 border border-slate-200 text-slate-800 hover:bg-slate-50 disabled:opacity-50 px-4 py-2 rounded-lg text-sm"
          >
            Agregar
          </button>
        </div>
        {tooLongNotice ? (
          <p className="text-xs text-amber-800 mt-1">
            Algunas palabras/frases superan 60 caracteres y no fueron agregadas.
          </p>
        ) : null}
        <p className="text-xs text-slate-400 mt-1">
          Podés agregar varias palabras o frases separadas por coma. Máximo {BOT_WAKE_KEYWORDS_MAX_COUNT} entradas,{" "}
          {BOT_WAKE_KEYWORDS_MAX_LENGTH} caracteres cada una. La comparación ignora mayúsculas, acentos y espacios
          extra.
        </p>
      </div>

      {value.keywords.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {value.keywords.map((k, i) => (
            <li
              key={`${normalizeWakeKeywordText(k)}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 border border-slate-200 px-3 py-1 text-sm text-slate-800"
            >
              <span className="max-w-[240px] truncate" title={k}>
                {k}
              </span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="text-slate-500 hover:text-red-600 text-lg leading-none px-0.5"
                aria-label={`Quitar ${k}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-400">Ninguna palabra configurada.</p>
      )}
    </div>
  );
}
