// Facts the host is allowed to say.
//
// The model invents trivia when asked for it — it will confidently name the wrong
// synthesizer on a record — so a "fun fact" blurb only happens when there is
// something real to say, and the source travels with the fact.
//
// Wikipedia first: a song article's opening sentence is "X is a song by Y from the
// album Z (year)" — curated, checkable, and almost always right. MusicBrainz is the
// fallback for the artist. Its release data is deliberately NOT used for albums:
// the same lookup produced "from the album AT&T Wireless Acoustic Series" for
// Everlong and a film soundtrack for an Eno piece, because the search matches
// whichever recording ranks first rather than the one the room is hearing.
//
// Everything here fails soft. No fact means the DJ simply picks another angle.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const CACHE_ROOT = process.env.CACHE_DIR || "./cache";
const DIR = path.join(CACHE_ROOT, "facts");
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UA = "syncwave/1.0 (https://listen.tandy.land)";
const API = "https://musicbrainz.org/ws/2";

/**
 * Bumped whenever the extraction changes, so old answers do not outlive the code
 * that produced them: a 30-day cache happily kept serving a compilation as a
 * track's album after the query that chose it had been fixed.
 */
const FACTS_VERSION = 6;

const memory = new Map();
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// MusicBrainz asks for one request a second; a blurb every few tracks is nowhere
// near that, but two lookups back to back still has to be polite.
let lastCall = 0;
async function paced(fn) {
  const wait = Math.max(0, 1000 - (Date.now() - lastCall));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

function keyFor(kind, s) {
  return createHash("sha1")
    .update(`v${FACTS_VERSION}|${kind}|${s.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

function cached(key) {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const raw = JSON.parse(readFileSync(path.join(DIR, `${key}.json`), "utf8"));
    if (raw && Date.now() - raw.at < TTL_MS) {
      memory.set(key, raw);
      return raw.value;
    }
  } catch {
    /* not cached */
  }
  return undefined;
}

function store(key, value) {
  memory.set(key, { at: Date.now(), value });
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `${key}.json`), JSON.stringify({ at: Date.now(), value }));
  } catch {
    /* a cache we cannot write is still a cache for this process */
  }
}

async function httpJson(url, attempt = 0) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(6_000),
  });
  // 503 is MusicBrainz asking for a pause, not a failure of the query.
  if (res.status === 503 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return httpJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

const mbGet = (q) => httpJson(`${API}${q}${q.includes("?") ? "&" : "?"}fmt=json`);

/**
 * "(2022 Remaster)" and "[From The Motion Picture …]" are packaging, not title —
 * but "(Ascent)" in "An Ending (Ascent)" is part of the name, so only strip a
 * bracket whose contents look like an edition marker.
 */
const PACKAGING =
  /\b(remaster|remastered|live|deluxe|edition|version|mono|stereo|single|bonus|anniversary|from the|motion picture|soundtrack|radio edit|explicit|clean)\b/i;
function cleanTitle(t) {
  return String(t || "")
    .replace(/\s*[\[(]([^\])]*)[\])]/g, (m, inner) => (PACKAGING.test(inner) ? " " : m))
    .replace(/\s+/g, " ")
    .trim();
}

/** The opening sentence of the song's Wikipedia article, if it really is about the song. */
async function wikiFact(artist, title) {
  try {
    const search = await httpJson(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
        `${title} ${artist} song`
      )}&srlimit=3&format=json`
    );
    const hit = search?.query?.search?.[0];
    if (!hit) return null;
    const page = await httpJson(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}?redirect=true`
    );
    const extract = String(page?.extract || "").trim();
    if (!extract) return null;
    const first = extract.split(/(?<=[.!?])\s/)[0].trim();
    if (!first || first.length < 20 || first.length > 300) return null;
    // It has to be about this track: a summary of the album or the artist is not a
    // fact about the song, and quoting one reads like a mistake.
    const words = norm(title)
      .split(" ")
      .filter((w) => w.length > 3);
    if (words.length && !words.every((w) => norm(first).includes(w))) return null;
    return { text: first, source: "Wikipedia" };
  } catch (e) {
    console.warn(`[dj] wikipedia lookup failed: ${e?.message || e}`);
  }
  return null;
}

/** Where a band is from and when they started — always true, never about the recording. */
async function artistFact(artist) {
  const key = keyFor("artist", artist);
  const hit = cached(key);
  if (hit !== undefined) return hit;

  let fact = null;
  try {
    const data = await paced(() => mbGet(`/artist?query=${encodeURIComponent(`artist:"${artist}"`)}&limit=3`));
    const best = (data.artists || []).find(
      (x) => norm(x.name) === norm(artist) && (x.score ?? 0) >= 90
    );
    const begin = best?.["life-span"]?.begin?.slice(0, 4);
    const place = best?.["begin-area"]?.name || best?.area?.name;
    const known = best?.type ? String(best.type).toLowerCase() : "";
    if (best && (begin || place)) {
      let text;
      if (known === "person") {
        text = `${best.name} ${place ? `was born in ${place}` : "was born"}${begin ? ` in ${begin}` : ""}.`;
      } else if (known === "group" || known === "orchestra" || known === "choir") {
        text = `${best.name} formed ${place ? `in ${place} ` : ""}${begin ? `in ${begin}` : ""}.`.replace(/\s+/g, " ");
      } else {
        // Unknown type: a phrasing that is true of a band and a solo artist both.
        text = `${best.name} — ${place ? `from ${place}, ` : ""}${begin || ""}`.replace(/[,\s]+$/, "") + ".";
      }
      fact = { text, source: "MusicBrainz" };
    }
  } catch (e) {
    console.warn(`[dj] artist lookup failed: ${e?.message || e}`);
  }

  store(key, fact);
  return fact;
}

/**
 * One true sentence about a track, or the artist behind it.
 * Returns `{ text, source }` or null.
 */
export async function trackFact({ title, artist }) {
  const t = cleanTitle(title);
  const a = String(artist || "")
    .split(/\s*(?:&|feat\.?|ft\.?|\/)\s*/i)[0]
    .trim();
  if (!t || !a) return null;

  const key = keyFor("track", `${a}|${t}`);
  const hit = cached(key);
  if (hit !== undefined) return hit;

  const fact = (await wikiFact(a, t)) || (await artistFact(a));
  store(key, fact);
  return fact;
}
