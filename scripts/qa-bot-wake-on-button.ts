/**
 * QA unitario (sin DB) de `evaluateBotWakeForInbound`.
 *
 *   npm run qa:bot-wake-on-button
 *
 * Cubre el cambio que permite que un clic de botón (plantilla de campaña /
 * reply interactivo) despierte el bot por palabra clave del canal, y las
 * regresiones que ese cambio podría introducir en flujos existentes.
 */
import {
  evaluateBotWakeForInbound,
  type BotWakeInboundEvaluation,
} from "../src/lib/chat/bot-wake-keywords";

type Case = {
  name: string;
  args: Parameters<typeof evaluateBotWakeForInbound>[0];
  expectMatched: boolean;
  expectSkipReason?: BotWakeInboundEvaluation["skipReason"];
};

const CANAL_CON_KEYWORDS = {
  bot_wake_keywords_enabled: true,
  bot_wake_keywords: ["participar", "quiero participar"],
  bot_wake_keywords_match_mode: "exact",
};

const CANAL_SIN_KEYWORDS = { bot_wake_keywords_enabled: false, bot_wake_keywords: [] };

const CASES: Case[] = [
  {
    name: "texto 'hola' sin config de canal → set default (comportamiento previo)",
    args: { messageType: "text", content: "hola", channelConfig: CANAL_SIN_KEYWORDS },
    expectMatched: true,
  },
  {
    name: "texto 'participar' con keywords del canal",
    args: { messageType: "text", content: "Participar", channelConfig: CANAL_CON_KEYWORDS },
    expectMatched: true,
  },
  {
    name: "clic de plantilla (type button) con keywords del canal → despierta",
    args: { messageType: "button", content: "Participar", channelConfig: CANAL_CON_KEYWORDS },
    expectMatched: true,
  },
  {
    name: "clic interactivo con keywords del canal → despierta",
    args: { messageType: "interactive", content: "participar", channelConfig: CANAL_CON_KEYWORDS },
    expectMatched: true,
  },
  {
    name: "REGRESIÓN: botón 'Menú principal' sin keywords propias NO reinicia el flujo",
    args: { messageType: "button", content: "Menú principal", channelConfig: CANAL_SIN_KEYWORDS },
    expectMatched: false,
    expectSkipReason: "button_requires_channel_keywords",
  },
  {
    name: "REGRESIÓN: botón 'Inicio' sin keywords propias NO reinicia el flujo",
    args: { messageType: "interactive", content: "Inicio", channelConfig: null },
    expectMatched: false,
    expectSkipReason: "button_requires_channel_keywords",
  },
  {
    name: "botón con label que no es keyword → sigue el flujo normal",
    args: { messageType: "button", content: "Ver mis boletos", channelConfig: CANAL_CON_KEYWORDS },
    expectMatched: false,
  },
  {
    name: "placeholder '[button:abc123]' nunca despierta",
    args: { messageType: "interactive", content: "[button:abc123]", channelConfig: CANAL_CON_KEYWORDS },
    expectMatched: false,
    expectSkipReason: "placeholder_content",
  },
  {
    name: "imagen nunca despierta",
    args: { messageType: "image", content: "participar", channelConfig: CANAL_CON_KEYWORDS },
    expectMatched: false,
    expectSkipReason: "unsupported_message_type",
  },
  {
    name: "kill switch (allowButtonTypes=false) restaura el comportamiento previo",
    args: {
      messageType: "button",
      content: "Participar",
      channelConfig: CANAL_CON_KEYWORDS,
      allowButtonTypes: false,
    },
    expectMatched: false,
    expectSkipReason: "unsupported_message_type",
  },
];

function main(): void {
  let failed = 0;
  for (const c of CASES) {
    const got = evaluateBotWakeForInbound(c.args);
    const okMatched = got.matched === c.expectMatched;
    const okReason =
      c.expectSkipReason === undefined ? true : got.skipReason === c.expectSkipReason;
    if (okMatched && okReason) {
      console.log(`  ok   ${c.name}`);
      continue;
    }
    failed += 1;
    console.error(
      `  FAIL ${c.name}\n       esperado matched=${c.expectMatched}` +
        (c.expectSkipReason ? ` skipReason=${c.expectSkipReason}` : "") +
        `\n       obtenido matched=${got.matched} skipReason=${got.skipReason ?? "-"}`
    );
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} casos ok`);
  if (failed > 0) process.exit(1);
}

main();
