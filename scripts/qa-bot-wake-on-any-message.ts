/**
 * QA de `shouldWakeBotOnAnyMessage`: el bot manda el primer mensaje cuando la
 * conversación quedó dormida, sin pisar flujos en curso ni agentes.
 *
 *   npm run qa:bot-wake-any-message
 */
import {
  shouldWakeBotOnAnyMessage,
  isBotWakeOnAnyMessageEnabled,
  parseBotWakeKeywordsSettingsFromConfig,
  sanitizeBotWakeKeywordsForPersistence,
  applyBotWakeKeywordsInputToChannelConfig,
} from "../src/lib/chat/bot-wake-keywords";

const ON = { bot_wake_on_any_message: true };
const OFF = { bot_wake_on_any_message: false };

const BASE = { alreadyRestarted: false, hasActiveFlowSession: false, agentHasReplied: false };

type Case = {
  name: string;
  args: Parameters<typeof shouldWakeBotOnAnyMessage>[0];
  wake: boolean;
  reason?: string;
};

const CASES: Case[] = [
  {
    name: "conversación dormida con el flag activo → despierta",
    args: { channelConfig: ON, ...BASE },
    wake: true,
  },
  {
    name: "flag apagado → no hace nada (comportamiento previo)",
    args: { channelConfig: OFF, ...BASE },
    wake: false,
    reason: "disabled",
  },
  {
    name: "canal sin la clave en config → no hace nada",
    args: { channelConfig: {}, ...BASE },
    wake: false,
    reason: "disabled",
  },
  {
    name: "config null → no hace nada",
    args: { channelConfig: null, ...BASE },
    wake: false,
    reason: "disabled",
  },
  {
    name: "CRITICO: persona a mitad del flujo → NO se reinicia",
    args: { channelConfig: ON, ...BASE, hasActiveFlowSession: true },
    wake: false,
    reason: "flow_session_active",
  },
  {
    name: "CRITICO: un agente ya contestó → el bot no se la quita",
    args: { channelConfig: ON, ...BASE, agentHasReplied: true },
    wake: false,
    reason: "agent_already_replied",
  },
  {
    name: "ya se reinició por palabra clave en este mismo mensaje → no duplica",
    args: { channelConfig: ON, ...BASE, alreadyRestarted: true },
    wake: false,
    reason: "already_restarted",
  },
  {
    name: "flujo en curso Y agente: gana el flujo en curso",
    args: { channelConfig: ON, ...BASE, hasActiveFlowSession: true, agentHasReplied: true },
    wake: false,
    reason: "flow_session_active",
  },
];

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

for (const c of CASES) {
  const got = shouldWakeBotOnAnyMessage(c.args);
  const ok = got.wake === c.wake && (c.reason === undefined || got.reason === c.reason);
  check(c.name, ok, `esperado wake=${c.wake} reason=${c.reason ?? "-"}, obtenido wake=${got.wake} reason=${got.reason}`);
}

// Persistencia: el flag sobrevive el ida y vuelta del formulario.
const state = parseBotWakeKeywordsSettingsFromConfig({
  bot_wake_keywords_enabled: true,
  bot_wake_keywords: ["participar"],
  bot_wake_on_any_message: true,
});
check("se lee desde config", state.wakeOnAnyMessage === true);
check("no rompe las keywords existentes", state.keywords.length === 1 && state.enabled);

const persisted = sanitizeBotWakeKeywordsForPersistence(state);
check("se guarda", persisted.bot_wake_on_any_message === true);

const cfg: Record<string, unknown> = {};
applyBotWakeKeywordsInputToChannelConfig(cfg, { bot_wake_on_any_message: true });
check("se aplica al config del canal", cfg.bot_wake_on_any_message === true);
check("isBotWakeOnAnyMessageEnabled lo reconoce", isBotWakeOnAnyMessageEnabled(cfg));

const vacio: Record<string, unknown> = { otra_cosa: 1 };
applyBotWakeKeywordsInputToChannelConfig(vacio, {});
check("sin campos definidos no toca el config", vacio.bot_wake_on_any_message === undefined);

console.log(`\n${failed === 0 ? "todo ok" : `${failed} fallo(s)`}`);
if (failed > 0) process.exit(1);
