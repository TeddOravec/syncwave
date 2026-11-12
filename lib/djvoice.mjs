// DJ voice — turn a between-songs blurb into a short audio clip.
//
// Any OpenAI-compatible speech endpoint works; the fleet's local Kokoro server
// is the default (http://<host>:8099/v1, ~1-3s for a 20s clip, no API key).
// Clips are cached by content hash, so a repeated blurb costs nothing and the
// same file can be range-served straight to a browser.
//
// Nothing in here may throw into playback: a silent voice means the DJ says it
// in chat instead, which is a fine failure mode.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activeVoice } from "./settings.mjs";

const CACHE_ROOT = process.env.CACHE_DIR || "./cache";
const DIR = path.join(CACHE_ROOT, "dj");

const VOICE_URL = (process.env.DJ_VOICE_URL || "http://127.0.0.1:8099/v1").replace(/\/$/, "");
const VOICE_MODEL = process.env.DJ_VOICE_MODEL || "kokoro";

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.DJ_GEMINI_MODEL || "gemini-2.5-flash-preview-tts";

/** Gemini's prebuilt voices. Kokoro's are fetched from its own server. */
export const GEMINI_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

/**
 * Kokoro's catalogue, straight from the server so a new voice model does not
 * need a code change. Cached for a minute: the list changes when the container
 * is rebuilt, not between blurbs.
 */
let voiceCache = { at: 0, list: [] };
export async function kokoroVoices() {
  if (Date.now() - voiceCache.at < 60_000 && voiceCache.list.length) return voiceCache.list;
  try {
    const res = await fetch(`${VOICE_URL}/voices`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.voices || [];
    voiceCache = { at: Date.now(), list: list.map(String).sort() };
    return voiceCache.list;
  } catch {
    return voiceCache.list;
  }
}

/** Wrap raw little-endian PCM in a WAV header, then let ffmpeg make an opus clip. */
function pcmToOpus(pcm, sampleRate = 24000) {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * 2; // mono, 16-bit
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);

    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "wav", "-i", "pipe:0",
      "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1",
    ]);
    const chunks = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`))
    );
    ff.stdin.end(Buffer.concat([header, pcm]));
  });
}

/** Render text through Google's preview TTS. Returns opus bytes. */
async function geminiSpeak(text, voice) {
  if (!GEMINI_KEY) throw new Error("no GEMINI_API_KEY for provider=gemini");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) throw new Error(`gemini tts ${res.status} ${String(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const part = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!part?.data) throw new Error("gemini tts returned no audio");
  const rate = Number(/rate=(\d+)/.exec(part.mimeType || "")?.[1] || 24000);
  return pcmToOpus(Buffer.from(part.data, "base64"), rate);
}


/** Hard cap on what we will speak. A talkative model must not stall a room. */
export const MAX_BLURB_CHARS = 320;

export function voiceEnabled() {
  return Boolean(VOICE_URL);
}

function clipPath(hash) {
  return path.join(DIR, `${hash}.opus`);
}

/** Render `text` to a cached opus clip. Returns { hash, bytes, cached } or throws. */
export async function synthesize(text, opts = {}) {
  const clean = String(text || "").trim().slice(0, MAX_BLURB_CHARS);
  if (!clean) return null;

  const preferred = activeVoice();
  const voice = opts.voice || preferred.voice;
  const provider = opts.provider || preferred.provider;

  mkdirSync(DIR, { recursive: true });
  const hash = createHash("sha1")
    .update(`${provider}|${VOICE_MODEL}|${voice}|${clean}`)
    .digest("hex")
    .slice(0, 16);
  const file = clipPath(hash);

  try {
    const { size } = statSync(file);
    if (size > 0) return { hash, bytes: size, cached: true, voice, provider };
  } catch {
    /* not cached yet */
  }

  let buf = null;
  let usedProvider = provider;
  let usedVoice = voice;

  if (provider === "gemini") {
    try {
      buf = await geminiSpeak(clean, voice);
    } catch (e) {
      // A voice outage must not silence the host. Gemini is the one dependency
      // here with a quota, so fall back to the local server and say so.
      console.warn(`[dj] gemini tts failed (${e?.message || e}); using kokoro`);
      usedProvider = "kokoro";
      usedVoice = process.env.DJ_VOICE_FALLBACK || "bf_emma";
    }
  }

  if (!buf) {
    let res;
    try {
      res = await fetch(`${VOICE_URL}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VOICE_MODEL,
          voice: usedVoice,
          input: clean,
          response_format: "opus",
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`tts unreachable (${VOICE_URL}): ${e?.message || e}`);
    }
    if (!res.ok) throw new Error(`tts ${res.status} ${String(await res.text()).slice(0, 120)}`);
    buf = Buffer.from(await res.arrayBuffer());
  }

  if (!buf.length) throw new Error("tts returned an empty body");
  writeFileSync(file, buf);
  return { hash, bytes: buf.length, cached: false, voice: usedVoice, provider: usedProvider };
}

/** Range-serve a cached clip. Mirrors the shape of the /audio route. */
export function handleDjAudio(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const name = url.pathname.replace("/dj-audio/", "").replace(/\.opus$/, "");
    if (!/^[a-f0-9]{8,32}$/.test(name)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad_clip" }));
      return;
    }
    const file = clipPath(name);
    const { size } = statSync(file);
    if (!size) throw new Error("empty clip");

    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": "audio/ogg",
      "Cache-Control": "public, max-age=86400, immutable",
    };
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = String(range).replace(/bytes=/, "").split("-");
      const start = parseInt(startStr, 10) || 0;
      const end = endStr ? parseInt(endStr, 10) : size - 1;
      res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "clip_not_found", detail: String(err?.message || err) }));
  }
}
