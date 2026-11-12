// Persisted instance settings: LLM provider config + AI DJ toggle/persona.
// Process-global singleton so Next routes and the custom server share it.
import { loadSync, saveNow } from "./store.mjs";
import { PERSONAS } from "./personas.mjs";

const DEFAULTS = {
  llmProvider: process.env.LLM_PROVIDER || "ollama", // openai | anthropic | google | ollama
  llmModel: process.env.LLM_MODEL || "llama3.1",
  llmApiKey: process.env.LLM_API_KEY || "",
  llmBaseUrl: process.env.LLM_BASE_URL || "http://localhost:11434",
  aiDjEnabled: process.env.AI_DJ_ENABLED === "true",
  personaId: PERSONAS[0].id,
  // Voice for the DJ's spoken blurbs. "kokoro" is the fleet's local server
  // (free, ~1s); "gemini" is Google's preview TTS (better prosody, paid per
  // character). Both take an OpenAI-ish voice id; the ids are not interchangeable.
  djVoiceProvider: process.env.DJ_VOICE_PROVIDER || "kokoro",
  djVoice: process.env.DJ_VOICE_ID || "bf_emma",
  // A DJ style can own a voice, e.g. { lofi: "bm_george", hype: "am_puck" }.
  djPersonaVoices: {},
  // Speak at a track boundary every N tracks; 0 disables blurbs entirely. Six
  // is the default because the blurb looks three tracks back and three ahead —
  // at one-per-track it is more host than music.
  djBlurbEvery: Number(process.env.DJ_BLURB_EVERY || 6),
  // Proxy pool, for hosts whose IP YouTube refuses. Settable here so a VPS can
  // be fixed from the browser instead of an SSH session and a restart; the
  // matching env vars still win, so a compose file stays the source of truth
  // where someone has chosen to configure it that way.
  webshareApiKey: process.env.WEBSHARE_API_KEY || "",
  proxyList: process.env.YTDLP_PROXY_LIST || "",
};

const state =
  (globalThis.__SW_SETTINGS ??= { ...DEFAULTS, ...loadSync("settings", {}) });

export function getSettings() {
  return { ...state };
}

// Never leak secrets to the browser. Proxy URLs embed their own credentials,
// so the list is reported as a count rather than echoed back.
export function getPublicSettings() {
  const { llmApiKey, webshareApiKey, proxyList, ...rest } = state;
  return {
    ...rest,
    hasApiKey: Boolean(llmApiKey),
    hasWebshareKey: Boolean(webshareApiKey),
    proxyListCount: String(proxyList || "")
      .split(",")
      .filter((s) => s.trim()).length,
  };
}

export async function updateSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULTS && v !== undefined) state[k] = v;
  }
  await saveNow("settings", state);
  return getPublicSettings();
}

export function activePersona() {
  return PERSONAS.find((p) => p.id === state.personaId) || PERSONAS[0];
}

/**
 * The voice the DJ speaks in: a per-persona override if that style owns one,
 * otherwise the instance default. Kept here so the renderer and the settings UI
 * cannot disagree about which voice is actually in use.
 */
export function activeVoice() {
  const map = state.djPersonaVoices || {};
  return {
    provider: state.djVoiceProvider || "kokoro",
    voice: map[state.personaId] || state.djVoice || "bf_emma",
    every: Number(state.djBlurbEvery ?? 6),
  };
}
