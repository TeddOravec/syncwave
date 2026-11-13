// AI DJ — thin layer over the Vercel AI SDK. Swappable provider (openai /
// anthropic / google / ollama). Generates short between-track intros, interprets
// plain-language chat requests into a search query, and suggests what to play
// next. Every call is wrapped so a missing/unreachable LLM never breaks
// playback — the DJ just stays quiet and the room falls back to plain search.

import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getSettings, activePersona, activeVoice } from "./settings.mjs";

function getModel() {
  const s = getSettings();
  if (s.llmProvider === "anthropic") {
    return createAnthropic({ apiKey: s.llmApiKey })(s.llmModel);
  }
  if (s.llmProvider === "google") {
    // Gemini, via a Google AI Studio key. The free tier is generous enough to
    // run a DJ for a room of friends indefinitely, which makes this the first
    // provider worth suggesting to someone who doesn't already pay for one.
    return createGoogleGenerativeAI({ apiKey: s.llmApiKey })(s.llmModel);
  }
  if (s.llmProvider === "ollama") {
    // Ollama exposes an OpenAI-compatible endpoint at /v1.
    const base = (s.llmBaseUrl || "http://localhost:11434").replace(/\/$/, "");
    return createOpenAI({ baseURL: `${base}/v1`, apiKey: "ollama" })(s.llmModel);
  }
  return createOpenAI({ apiKey: s.llmApiKey })(s.llmModel);
}

/**
 * Token ceilings, sized for models that think before they speak.
 *
 * These used to be 30/80/200 — snug fits for the handful of words each call
 * actually needs. On a reasoning model that is a trap: the budget covers the
 * model's internal thinking *and* its answer, so the thinking eats the whole
 * allowance and the reply comes back as an empty string with
 * `finishReason: "length"`. No error, no warning, nothing in a log. The DJ just
 * never says anything, on a correctly configured account.
 *
 * Measured on gemma-4-26b-a4b-it: a one-line search query came back empty at
 * 30 tokens and answered in five at 400. A persona-voiced intro was still
 * empty at 1024 and fine at 4096 — a longer system prompt gives the model more
 * to think about, so the ceiling has to clear the thinking, not the answer.
 *
 * So these are deliberately generous. Output length is governed where it
 * belongs: by telling the model how long to be, and by slicing what comes back.
 */
const LIMITS = {
  test: 1024,
  request: 2048,
  intro: 4096,
  suggest: 8192,
};

/**
 * The text, or null — and a log line either way when there wasn't any.
 *
 * An empty completion is a failure that doesn't throw: the request succeeded,
 * the model simply said nothing. Left unremarked it looks exactly like a DJ
 * with nothing to add, which is how a token ceiling that was too low went
 * unnoticed until someone asked why the DJ never spoke.
 */
function usableText(where, result) {
  const text = (result?.text ?? "").trim();
  if (text) return text;
  const s = getSettings();
  console.warn(
    `[dj] ${where} returned nothing (${s.llmProvider}/${s.llmModel}, finish: ${result?.finishReason})` +
      (result?.finishReason === "length"
        ? " — the model spent its whole token budget, most likely on reasoning."
        : "")
  );
  return null;
}

/**
 * Pull the useful sentence out of a provider error.
 *
 * The SDK wraps the HTTP body, so `e.message` is often a generic retry
 * summary while the thing you actually need — "unexpected model name format",
 * "quota exceeded", "API key not valid" — is JSON inside `responseBody`.
 */
export function djError(e) {
  let msg = e?.responseBody || e?.message || String(e);
  try {
    msg = JSON.parse(msg)?.error?.message || msg;
  } catch {
    /* not JSON — the message is already the message */
  }
  return String(msg).replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Say why the DJ went quiet.
 *
 * Every call site below returns null on failure so that a broken LLM can never
 * take playback down with it — which is right, but it also meant a wrong model
 * name and a DJ with nothing to say looked identical from the outside, in the
 * logs, and in /admin. Silence is a fine failure mode; an unexplained one is
 * not.
 */
function djFailed(where, e) {
  const s = getSettings();
  console.warn(`[dj] ${where} failed (${s.llmProvider}/${s.llmModel}): ${djError(e)}`);
}

export function djEnabled() {
  return getSettings().aiDjEnabled;
}

/**
 * One real call to the configured model, with the error left intact.
 *
 * Exists so /admin can answer "is this actually working" without waiting for a
 * track change and then guessing.
 */
export async function testDj() {
  const s = getSettings();
  const where = { provider: s.llmProvider, model: s.llmModel };
  try {
    // A system prompt, deliberately: every real DJ call uses one, and some
    // models accept a bare prompt while doing nothing useful with a system
    // instruction. A check that exercises an easier path than the feature is
    // a check that passes while the feature is broken.
    const { text, finishReason } = await generateText({
      model: getModel(),
      system: "You are being checked for connectivity. Answer in one word.",
      prompt: "Reply with the single word: OK",
      maxTokens: LIMITS.test,
      maxRetries: 0,
    });

    const reply = text.trim();
    if (!reply) {
      // The call succeeded and the model said nothing — which is what a
      // reasoning model does when it spends its whole budget thinking.
      return {
        ...where,
        ok: false,
        error:
          finishReason === "length"
            ? "The model used its entire token budget without answering — typical of a reasoning model. Try a smaller or non-thinking model."
            : "The model connected but returned an empty reply.",
      };
    }
    return { ...where, ok: true, reply: reply.slice(0, 60) };
  } catch (e) {
    return { ...where, ok: false, error: djError(e) };
  }
}

export function djName() {
  return activePersona().name;
}

export function djAvatar() {
  return activePersona().avatar;
}

/**
 * One line of context about the room, appended to prompts.
 *
 * The mood is inferred from what the room has actually been doing (see
 * MOODS in protocol.mjs), so handing it to the DJ is the difference between a
 * host who reads the room and one who reads a track listing.
 */
function roomContext(mood) {
  return mood ? `The room's mood right now is "${mood.label}" (${mood.why}).` : "";
}

/** Short spoken-style intro for a track. Returns null on any failure. */
export async function generateIntro(track, { mood } = {}) {
  try {
    const persona = activePersona();
    const res = await generateText({
      model: getModel(),
      system: persona.prompt,
      prompt: [
        `Introduce this track for the room in your voice, max 2 short sentences, no quotes:`,
        `"${track.title}" by ${track.artist}.`,
        roomContext(mood),
      ]
        .filter(Boolean)
        .join("\n"),
      maxTokens: LIMITS.intro,
    });
    const text = usableText("intro", res);
    return text && text.slice(0, 300);
  } catch (e) {
    djFailed("intro", e);
    return null;
  }
}

/**
 * The most a single `/dj` line may queue.
 *
 * There is a cap because a request is one person talking, not a mandate: "add
 * 100 songs" from one listener would bury a shared queue that everyone else is
 * also using. Ten is enough to fill an evening's opening stretch.
 */
export const MAX_REQUEST_TRACKS = 10;

/**
 * Turn a chat request into search queries.
 *
 * Returns a list, because "add 10 romantic songs" is one request for ten
 * tracks and used to yield exactly one — the prompt asked for a single query,
 * so the model dutifully returned a single query and the count in the message
 * was quietly thrown away.
 *
 * An empty array means "not a music request", which is also what a failure
 * returns; both mean the same thing to the caller — do nothing.
 */
export async function interpretRequest(message, { mood } = {}) {
  try {
    const res = await generateText({
      model: getModel(),
      system: [
        "You turn a listener's chat message into YouTube Music search queries.",
        "Reply with one query per line and nothing else — no numbering, no commentary, no blank lines.",
        "If the listener names a specific song or artist, return that verbatim on a single line — never substitute your own taste for an explicit request.",
        // Without this, "add 10 romantic songs" comes back as "romantic songs
        // 1" through "romantic songs 10": ten numbered restatements of the
        // request, which search resolves to compilation mixes and hour-long
        // playlists rather than to songs. Naming real records is the only way
        // a mood request turns into a queue anyone wants to hear.
        `Otherwise — for a mood, a genre, or any request for several songs — each line must name one specific, real, released track in the form "Artist - Title".`,
        "Never reply with a generic phrase, a numbered variation of the request, a playlist name, or a compilation or mix title.",
        `If the listener asks for a number of songs, return exactly that many distinct tracks, up to ${MAX_REQUEST_TRACKS}.`,
        "Otherwise return exactly one line.",
        "If the message is not a music request, reply with exactly NONE.",
      ].join(" "),
      prompt: [message, roomContext(mood)].filter(Boolean).join("\n\n"),
      maxTokens: LIMITS.request,
    });
    const text = usableText("request", res);
    if (!text) return [];

    return text
      .split("\n")
      // Models add numbering despite being told not to; strip it, then the
      // quotes they like to wrap titles in.
      .map((l) => l.replace(/^\s*[-*\d.)\s]+/, "").trim().replace(/^["']|["']$/g, "").trim())
      .filter((l) => l && !/^none$/i.test(l))
      .map((l) => l.slice(0, 120))
      .slice(0, MAX_REQUEST_TRACKS);
  } catch (e) {
    djFailed("request", e);
    return [];
  }
}

/**
 * What the DJ would put on next.
 *
 * Returns plain search queries ("Artist – Title") rather than tracks, because
 * the LLM has no idea what is actually on YouTube Music; the caller resolves
 * each one through the normal search path and drops anything that doesn't
 * come back. That also means a hallucinated title costs a miss, not a bad
 * queue entry.
 *
 * Returns an empty array — never throws — when the DJ is off or unreachable,
 * which is the signal for the caller to fall back to plain artist search.
 *
 * `taste` is the room's own listening history (see lib/taste.mjs) and `adjacent`
 * is a list of artists near this room's music that it has never played (see
 * lib/related.mjs). Both are needed: history alone is a feedback loop — what
 * gets suggested gets played, and played tracks are what the next suggestion is
 * drawn from, so a room converges on five artists and stays there. Asking the
 * model for "similar but different" does not break that; it answers from the
 * same memory. A catalogue-derived list of neighbours does, because the names
 * on it are ones the model would not have reached for.
 *
 * Measured on this instance: with history only, three refreshes returned the
 * same four artists (Glass Animals, MGMT, Arctic Monkeys, TOOL — the four most
 * played). With the adjacent list and the rules below, the same three refreshes
 * returned 11 distinct artists across 15 rows and none of them was a repeat of
 * the track playing.
 *
 * Two lessons cost a rebuild each:
 *
 * - A prompt that merely *mentions* history does not work. The first version
 *   added one sentence ("history outranks your genre") and a lo-fi persona still
 *   answered with five lo-fi instrumentals. Structure + a countable quota moved
 *   it, and the same is true of diversity here.
 * - `temperature` is set below rather than left at the SDK default (0). At 0 the
 *   model is deterministic, so "suggest something else" asked the same question
 *   and got the same answer back — the refresh button looked broken because it
 *   was.
 *
 * @param {{
 *   seed?: { title: string, artist: string } | null,
 *   mood?: { label: string, why: string } | null,
 *   avoid?: string[],
 *   taste?: { lines: string[], usable: boolean, recentArtists: string[] } | null,
 *   adjacent?: Array<{ artist: string, title: string }>,
 *   count?: number,
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function suggestTracks({
  seed,
  mood,
  avoid = [],
  taste = null,
  adjacent = [],
  count = 5,
} = {}) {
  if (!djEnabled()) return [];
  try {
    const persona = activePersona();
    const steer = Boolean(taste?.usable);
    const neighbours = adjacent.slice(0, 10);
    const fromNeighbours = Math.min(2, neighbours.length);

    const rules = steer
      ? [
          `HOW TO CHOOSE: this room's own listening history is the primary signal.`,
          `Your persona is a way of talking, not a genre filter — it only decides between picks that fit the history equally well.`,
          `Never name a track the room has already played, and never name the same artist twice.`,
          taste?.recentArtists?.length
            ? `At most one pick may be by an artist it has just played (${taste.recentArtists.join(", ")}).`
            : "",
          fromNeighbours
            ? `${fromNeighbours} of the ${count} must be by an artist from the neighbours list — artists the room has never heard but that sit next to what it plays.`
            : "",
        ]
      : [`When picking music you lean towards: ${persona.taste}.`];

    const res = await generateText({
      model: getModel(),
      temperature: 1,
      system: [
        persona.prompt,
        `You are choosing what the room hears next. Reply with exactly ${count} lines.`,
        `Each line must be "Artist - Song Title" and nothing else. No numbering, no commentary, no blank lines.`,
        `Only suggest real, released tracks you are confident exist.`,
        ...rules.filter(Boolean),
      ].join(" "),
      prompt: [
        steer ? `WHAT THIS ROOM ACTUALLY PLAYS (strongest signal):` : "",
        ...(steer ? (taste?.lines ?? []) : []),
        steer && neighbours.length
          ? [
              `ADJACENT TO IT, NEVER PLAYED HERE (real artists, from the catalogue's own similarity graph):`,
              ...neighbours.map((n) => `- ${n.artist}`),
            ].join("\n")
          : "",
        steer ? `Your taste, only as a tiebreaker: ${persona.taste}.` : "",
        seed
          ? `The room is playing "${seed.title}" by ${seed.artist}. Suggest what follows it well.`
          : `The room has nothing playing yet. Suggest an opening set.`,
        roomContext(mood),
        avoid.length ? `Do not suggest any of these: ${avoid.slice(0, 30).join("; ")}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      maxTokens: LIMITS.suggest,
    });

    const text = usableText("suggest", res);
    if (!text) return [];
    return text
      .split("\n")
      // Strip list markers the model added despite being asked not to.
      .map((l) => l.replace(/^\s*[-*\d.)\s]+/, "").trim())
      // A line has to look like "Artist - Title". Personas are chatty by
      // design, and a persona told to pick music will sometimes open with a
      // fact about the record before it starts listing — measured, not
      // imagined. Length alone let that through, and the sentence went
      // straight to search as if it were a song, which returns either nothing
      // or something absurd. Requiring the separator costs nothing: it is the
      // format the prompt asked for.
      .filter((l) => /\S\s+[-–—]\s+\S/.test(l) && l.length > 2 && l.length < 120)
      .slice(0, count);
  } catch (e) {
    djFailed("suggest", e);
    return [];
  }
}

/**
 * What the room needs to know for a between-songs blurb.
 *
 * Deliberately cheap and boring: the last few tracks (and which were skipped),
 * what is queued next and who put it there, the room's mood, and how much chat
 * has happened lately. All of it is already on `room` — this exists so the
 * prompt does not have to reach into the room object.
 */
function blurbContext(room) {
  // The setting is a period: "every 6 songs" means look three tracks back and
  // three ahead, so the host is talking about the neighbourhood it sits in
  // rather than just the track under it.
  const every = Math.max(2, Number(activeVoice().every) || 6);
  const span = Math.max(1, Math.floor(every / 2));
  const played = (room.history || [])
    .slice(-span)
    .map((t) => `"${t.title}" by ${t.artist}${t.skipped ? " (skipped)" : ""}`);
  const next = (room.queue || [])
    .slice(0, span)
    .map((t) => `"${t.title}" by ${t.artist}${t.addedBy ? ` (queued by ${t.addedBy})` : ""}`);
  const cutoff = Date.now() - 15 * 60 * 1000;
  const chats = (room.chat || []).filter((m) => !m.system && m.ts >= cutoff);
  const skips = (room.session?.recentSkips || []).filter((ts) => ts >= cutoff);

  const lines = [];
  if (room.current) lines.push(`Starting now: "${room.current.title}" by ${room.current.artist}.`);
  if (played.length) lines.push(`Just played: ${played.join("; ")}.`);
  if (next.length) lines.push(`Coming up: ${next.join("; ")}.`);
  if (room.mood) lines.push(`The room feels "${room.mood.label}" (${room.mood.why}).`);
  if (room.participants) lines.push(`${room.participants.size} people are in the room.`);
  if (chats.length) lines.push(`${chats.length} chat messages in the last 15 minutes.`);
  if (skips.length) lines.push(`${skips.length} tracks were skipped recently.`);
  return lines.join("\n");
}

/**
 * A spoken blurb between songs, radio-host style. Returns null on any failure —
 * the room then simply moves on to the next track as it always did.
 */
export async function composeBlurb(room) {
  try {
    const persona = activePersona();
    const res = await generateText({
      model: getModel(),
      system: persona.prompt,
      prompt: [
        "You are the host, speaking out loud to the room between songs. You sound like a late-night radio DJ: warm, brief, a little wry.",
        "In 1-3 short sentences and at most 45 words: name the track that just played, name the one that is starting or next, and add one human detail about the room if there is one.",
        "Name songs by title, with the artist when it flows. Never describe music by genre — 'some synth pop' is a failure; \"that was Tame Impala's Let It Happen\" is the job.",
        "Plain spoken prose only — no lists, no quotes around titles, no timings, no track numbers, no hype.",
        blurbContext(room),
      ]
        .filter(Boolean)
        .join("\n"),
      maxTokens: LIMITS.intro,
    });
    const text = usableText("blurb", res);
    return text ? text.slice(0, 320) : null;
  } catch (e) {
    djFailed("blurb", e);
    return null;
  }
}
