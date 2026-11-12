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
import { createReadStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const CACHE_ROOT = process.env.CACHE_DIR || "./cache";
const DIR = path.join(CACHE_ROOT, "dj");

const VOICE_URL = (process.env.DJ_VOICE_URL || "http://127.0.0.1:8099/v1").replace(/\/$/, "");
const VOICE_ID = process.env.DJ_VOICE_ID || "bf_emma";
const VOICE_MODEL = process.env.DJ_VOICE_MODEL || "kokoro";

/** Hard cap on what we will speak. A talkative model must not stall a room. */
export const MAX_BLURB_CHARS = 320;

export function voiceEnabled() {
  return Boolean(VOICE_URL);
}

function clipPath(hash) {
  return path.join(DIR, `${hash}.opus`);
}

/** Render `text` to a cached opus clip. Returns { hash, bytes, cached } or throws. */
export async function synthesize(text) {
  const clean = String(text || "").trim().slice(0, MAX_BLURB_CHARS);
  if (!clean) return null;

  mkdirSync(DIR, { recursive: true });
  const hash = createHash("sha1")
    .update(`${VOICE_MODEL}|${VOICE_ID}|${clean}`)
    .digest("hex")
    .slice(0, 16);
  const file = clipPath(hash);

  try {
    const { size } = statSync(file);
    if (size > 0) return { hash, bytes: size, cached: true };
  } catch {
    /* not cached yet */
  }

  let res;
  try {
    res = await fetch(`${VOICE_URL}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VOICE_MODEL,
        voice: VOICE_ID,
        input: clean,
        response_format: "opus",
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`tts unreachable (${VOICE_URL}): ${e?.message || e}`);
  }
  if (!res.ok) throw new Error(`tts ${res.status} ${String(await res.text()).slice(0, 120)}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("tts returned an empty body");
  writeFileSync(file, buf);
  return { hash, bytes: buf.length, cached: false };
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
