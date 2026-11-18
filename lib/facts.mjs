// Facts the host is allowed to say.
//
// The model invents trivia when asked for it — it will confidently name the wrong
// synthesizer on a record — so a "fun fact" blurb only happens when there is
// something real to say. MusicBrainz is the source: it is free, needs no key, and
// every claim we take from it (a release year, an album title, where a band
// formed) is checkable by anyone who looks the track up.
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

const memory = new Map();
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
  return createHash("sha1").update(`${kind}|${s.toLowerCase()}`).digest("hex").slice(0, 16);
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

async function get(pathAndQuery, attempt = 0) {
  const join = pathAndQuery.includes("?") ? "&" : "?";
  const res = await fetch(`${API}${pathAndQuery}${join}fmt=json`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(6_000),
  });
  // 503 is MusicBrainz asking for a pause, not a failure of the query.
  if (res.status === 503 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return get(pathAndQuery, attempt + 1);
  }
  if (!res.ok) throw new Error(`musicbrainz ${res.status}`);
  return res.json();
}

/**
 * "(2022 Remaster)" and "[From The Motion Picture …]" are packaging, not title —
 * but "(Ascent)" in "An Ending (Ascent)" is part of the name, so only strip a
 * bracket whose contents look like an edition marker.
 */
const PACKAGING = /\b(remaster|remastered|live|deluxe|edition|version|mono|stereo|single|bonus|anniversary|from the|motion picture|soundtrack|radio edit|explicit|clean)\b/i;
function cleanTitle(t) {
  return String(t || "")
    .replace(/\s*[\[(]([^\])]*)[\])]/g, (m, inner) => (PACKAGING.test(inner) ? " " : m))
    .replace(/\s+/g, " ")
    .trim();
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * One true sentence about a track, or the artist behind it.
 * Returns `{ text, source }` or null.
 */
export async function trackFact({ title, artist }) {
  const t = cleanTitle(title);
  const a = String(artist || "").split(/\s*(?:&|feat\.?|ft\.?|\/)\s*/i)[0].trim();
  if (!t || !a) return null;

  const key = keyFor("track", `${a}|${t}`);
  const hit = cached(key);
  if (hit !== undefined) return hit;

  let fact = null;
  try {
    const q = `?query=${encodeURIComponent(`artist:"${a}" AND recording:"${t}"`)}`;
    const data = await paced(() => get(`/recording${q}&limit=5`));
    const best = (data.recordings || []).find(
      (r) =>
        norm(r.title) === norm(t) &&
        (r["artist-credit"] || []).some((c) => norm(c.name) === norm(a)) &&
        (r.score ?? 0) >= 90
    );
    if (best) {
      // The earliest dated release that is a real album beats a compilation or a
      // live record: "from the 1986 album Master of Puppets" is the sentence we
      // want, not "from a 2013 reissue".
      const isCompilation = (r) =>
        ((r["release-group"]?.["secondary-types"] || []).map((x) => String(x).toLowerCase()).includes("compilation"));
      const releases = (best.releases || []).filter((r) => r.date && !isCompilation(r));
      const albums = releases
        .filter((r) => (r["release-group"]?.["primary-type"] || "").toLowerCase() === "album")
        .sort((x, y) => String(x.date).localeCompare(String(y.date)));
      const pick = albums[0] || releases.sort((x, y) => String(x.date).localeCompare(String(y.date)))[0];
      if (pick) {
        const year = String(pick.date).slice(0, 4);
        fact = {
          text: `"${t}" is from the album "${pick.title}" (${year}).`,
          source: "MusicBrainz",
        };
      } else if (best["first-release-date"]) {
        fact = {
          text: `"${t}" was first released in ${String(best["first-release-date"]).slice(0, 4)}.`,
          source: "MusicBrainz",
        };
      }
    }
  } catch (e) {
    console.warn(`[dj] fact lookup failed: ${e?.message || e}`);
  }

  if (!fact) fact = await artistFact(a);
  store(key, fact);
  return fact;
}

/** Where a band is from and when they started — the fallback when a track has no clean release. */
async function artistFact(artist) {
  const key = keyFor("artist", artist);
  const hit = cached(key);
  if (hit !== undefined) return hit;

  let fact = null;
  try {
    const data = await paced(() =>
      get(`/artist?query=${encodeURIComponent(`artist:"${artist}"`)}&limit=3`)
    );
    const best = (data.artists || []).find(
      (x) => norm(x.name) === norm(artist) && (x.score ?? 0) >= 90
    );
    const begin = best?.["life-span"]?.begin?.slice(0, 4);
    const place = best?.["begin-area"]?.name || best?.area?.name;
    const person = String(best?.type || "").toLowerCase() === "person";
    if (best && (begin || place)) {
      // "The Weeknd formed in Scarborough in 1990" is wrong in a way people notice.
      const known = best?.type ? String(best.type).toLowerCase() : "";
      let text;
      if (known === "person") {
        text = `"${best.name}" ${place ? `was born in ${place}` : "was born"}${begin ? ` in ${begin}` : ""}.`;
      } else if (known) {
        text = `${best.name} formed ${place ? `in ${place} ` : ""}${begin ? `in ${begin}` : ""}.`.replace(/\s+/g, " ");
      } else {
        // Unknown type (MusicBrainz search leaves it out sometimes): a phrasing that
        // is true of a band and a solo artist both, rather than calling a person a band.
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
