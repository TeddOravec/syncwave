// Adjacent artists — the reliable way out of a taste feedback loop.
//
// The DJ's suggestions are built from the room's own history, which is right
// until it isn't: whatever gets suggested gets played, played tracks become
// history, and history is what the next suggestion is drawn from. Left alone,
// a room converges on four or five artists and stays there.
//
// Asking the language model for "something similar but different" does not fix
// that — it answers from its own memory of the same names. YouTube Music's
// *up-next* graph does, because it is the catalogue's opinion rather than a
// model's: for one track it returns what the service would play next, and
// running it over a handful of tracks the room actually finishes yields dozens
// of artists in the same neighbourhood that the room has never heard. Measured
// on one real room's six most-played tracks: 157 such artists, with the
// strongest (The Neighbourhood, Hozier, Foster The People, Chevelle) sitting
// next to several seeds at once.
//
// Everything here is bounded and cached: at most four seeds per call, a 15
// minute memo per seed (a track's neighbourhood does not change that fast), and
// a hard cap on the cache so a long-running instance cannot grow it forever.

import { upNext } from "./ytmusic.mjs";

const SEED_LIMIT = 4;
const TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 200;

/** videoId → { at, rows } */
const memo = new Map();

async function cachedUpNext(videoId) {
  const hit = memo.get(videoId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const rows = await upNext(videoId, 50);
  if (memo.size >= CACHE_MAX) memo.delete(memo.keys().next().value);
  memo.set(videoId, { at: Date.now(), rows });
  return rows;
}

/** First artist of "Artist" / "Artist, Featured" — the key we compare on. */
function primaryArtist(name) {
  return String(name || "").split(",")[0].trim();
}

/**
 * Artists near this room's music that it has not played yet.
 *
 * @param {string[]} seedIds videoIds to take the neighbourhood of
 * @param {{ excludeArtists?: string[], excludeIds?: string[], limit?: number }} [options]
 *   excludeArtists — every artist the room has already played;
 *   excludeIds — every videoId the room has already played.
 * @returns {Promise<Array<{artist: string, videoId: string, title: string,
 *   duration: number, thumbnail?: string, art?: string, seeds: number}>>}
 */
export async function adjacentTo(seedIds, { excludeArtists = [], excludeIds = [], limit = 12 } = {}) {
  const heard = new Set(excludeArtists.map((a) => primaryArtist(a).toLowerCase()));
  const played = new Set(excludeIds);
  const seeds = [...new Set(seedIds.filter(Boolean))].slice(0, SEED_LIMIT);
  if (!seeds.length) return [];

  const settled = await Promise.allSettled(seeds.map((id) => cachedUpNext(id)));

  /** artistLower → candidate, with the set of seeds it appeared next to */
  const tally = new Map();
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const hitSeeds = new Set();
    for (const t of r.value) {
      const artist = primaryArtist(t.artist);
      if (!artist) continue;
      const key = artist.toLowerCase();
      if (heard.has(key) || played.has(t.videoId)) continue;
      if (hitSeeds.has(key)) continue; // one vote per seed per artist
      hitSeeds.add(key);

      const cur = tally.get(key);
      if (cur) {
        cur.seeds += 1;
      } else {
        tally.set(key, {
          artist,
          videoId: t.videoId,
          title: t.title,
          duration: t.duration,
          thumbnail: t.thumbnail,
          art: t.art,
          seeds: 1,
        });
      }
    }
  }

  // How many seeds vouch for an artist is the whole ranking: an artist sitting
  // next to four different tracks this room plays is a better bet than one that
  // appeared once, and it is the difference between "sounds like us" and
  // "sounds like one song".
  return [...tally.values()]
    .sort((a, b) => b.seeds - a.seeds || a.artist.localeCompare(b.artist))
    .slice(0, limit);
}
