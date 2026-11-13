import { NextRequest, NextResponse } from "next/server";
import { searchSongs } from "@/lib/ytmusic.mjs";
import { djEnabled, djName, suggestTracks } from "@/lib/dj.mjs";
import { getRoom } from "@/lib/rooms.mjs";
import { recentlyPlayed, tasteFromHistory } from "@/lib/taste.mjs";
import { adjacentTo } from "@/lib/related.mjs";
import { getSettings } from "@/lib/settings.mjs";
import { MOODS } from "@/lib/protocol.mjs";

export const dynamic = "force-dynamic";

type Track = {
  videoId: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail?: string;
  art?: string;
};

/**
 * Suggestions are expensive and idempotent within a track.
 *
 * Every client in the room asks on its own, so a six-person room used to mean
 * six LLM calls per track change — and six slightly different lists, which
 * looked like the panel changing its mind. A short memo keyed on the whole
 * request makes it one call and one answer per track, and still busts the
 * moment the track, the mood or the "suggest something else" avoid list moves.
 */
const MEMO_TTL_MS = 45_000;
const MEMO_MAX = 64;
const memo = new Map<string, { at: number; body: unknown }>();

function memoGet(key: string) {
  const hit = memo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEMO_TTL_MS) {
    memo.delete(key);
    return null;
  }
  return hit.body;
}

function memoSet(key: string, body: unknown) {
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(key, { at: Date.now(), body });
}

/** The artist half of an "Artist - Title" suggestion. */
function artistOf(query: string) {
  return query.split(/\s+[-–—]\s+/)[0]?.trim() ?? "";
}

/** First artist of "Artist" / "Artist, Featured", lowercased, for comparison. */
function artistKey(name: string) {
  return String(name || "").split(",")[0].trim().toLowerCase();
}

/** Alternate two lists so the panel does not read as two blocks. */
function interleave(a: Track[], b: Track[], limit: number) {
  const out: Track[] = [];
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < a.length || j < b.length)) {
    if (i < a.length) out.push(a[i++]);
    if (j < b.length && out.length < limit) out.push(b[j++]);
  }
  return out;
}

/**
 * What to play next.
 *
 * Three sources, and the response says which one answered so the UI can be
 * honest about it:
 *
 * - `dj`      — the active persona picks, with this room's listening history in
 *               hand and a list of neighbouring artists it has never played.
 *               The queries it returns are resolved through ordinary search, so
 *               a title it imagined fails to resolve instead of poisoning the
 *               queue.
 * - `history` — DJ off or unreachable: the artists this room finishes, mixed
 *               with those neighbours.
 * - `artist`  — no usable history yet: the seed artist, which is what this
 *               endpoint did before the DJ existed.
 *
 * `code` is the room code. Without it there is no history to read and the
 * endpoint behaves exactly as it always did.
 *
 * Why the neighbours list exists at all: history-driven suggestions feed
 * themselves — suggested becomes played, played becomes history, and history is
 * the strongest thing to suggest from — so a room that does nothing about it
 * plays the same four artists forever. lib/related.mjs supplies artists from
 * YouTube's own up-next graph (the catalogue's opinion of what sits next to
 * this music), filtered to ones this room has never played, and the prompt
 * reserves slots for them so the panel explores instead of repeating.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const title = p.get("title")?.trim();
  const artist = p.get("artist")?.trim();
  const moodId = p.get("mood")?.trim();
  const code = p.get("code")?.trim();
  const limit = Math.min(8, Math.max(1, Number(p.get("limit")) || 5));

  const mood = MOODS.find((m) => m.id === moodId) ?? null;

  // Which track this room is on right now, per the server — not per the client
  // asking. A stale tab asking about a track that already ended should get the
  // room's current answer, not one about a song from ten minutes ago.
  const room = code ? getRoom(code) : null;
  const history: any[] = room?.history ?? [];
  const taste = tasteFromHistory(history);
  const useHistory = getSettings().djUseHistory !== false;

  const seed =
    room?.current && room.current.title
      ? { title: room.current.title, artist: room.current.artist }
      : title && artist
        ? { title, artist }
        : null;

  // Two different avoid lists, both real: what this client has already been
  // shown (so "suggest something else" moves), and what the room just played
  // (so the DJ does not offer back what everyone heard an hour ago).
  const asked = (p.get("avoid") || "")
    .split("\n")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const avoid = [
    ...new Set([...asked, ...(useHistory ? recentlyPlayed(history) : [])]),
  ].slice(0, 40);

  const heardIds = new Set(history.slice(-40).map((h) => h.videoId).filter(Boolean));

  // Neighbourhood seeds: what is playing, then the last few things that played.
  // Four is deliberate — four up-next calls run in parallel in about a second
  // and cover the room's recent mood without hammering the catalogue.
  const seedIds = [
    ...(room?.current?.videoId ? [room.current.videoId] : []),
    ...history.slice(-6).map((h) => h.videoId).filter(Boolean),
  ]
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 4);

  const neighbours =
    useHistory && seedIds.length
      ? await adjacentTo(seedIds, {
          excludeArtists: taste.heardArtists,
          excludeIds: taste.heardIds,
          limit: 12,
        }).catch(() => [])
      : [];

  const memoKey = [
    code || "-",
    seed ? `${seed.artist}|${seed.title}` : "-",
    mood?.id || "-",
    limit,
    useHistory ? taste.plays : 0,
    seedIds.join(","),
    neighbours.slice(0, 6).map((n: { artist: string }) => n.artist).join(","),
    avoid.join("~"),
  ].join("::");

  try {
    if (djEnabled()) {
      const cached = memoGet(memoKey);
      if (cached) return NextResponse.json(cached);

      const queries: string[] = await suggestTracks({
        seed,
        mood,
        avoid,
        taste: useHistory ? taste : null,
        adjacent: neighbours,
        count: limit,
      });

      if (queries.length) {
        // Enforce the diversity the prompt asked for rather than trusting it:
        // one row per artist, and nothing by an artist that just played. A model
        // that ignores the rule costs a row here, not a loop in the panel.
        const recent = new Set(taste.recentArtists.map((a) => artistKey(a)));
        const seenArtist = new Set<string>();
        const kept: string[] = [];
        for (const q of queries) {
          const key = artistKey(artistOf(q));
          if (!key || recent.has(key) || seenArtist.has(key)) continue;
          seenArtist.add(key);
          kept.push(q);
        }

        // One search per suggestion, in parallel, each taking the top hit.
        // Anything that doesn't resolve is dropped silently — a miss should
        // cost a row, not the whole panel.
        const settled = await Promise.allSettled(kept.map((q) => searchSongs(q, 1)));
        const seen = new Set<string>();
        const picked: Track[] = [];
        for (const r of settled) {
          if (r.status !== "fulfilled") continue;
          const top = r.value[0];
          if (!top || seen.has(top.videoId) || heardIds.has(top.videoId)) continue;
          seen.add(top.videoId);
          picked.push(top);
        }

        // Reserve the neighbouring slots even when the model ignored them. These
        // are already real tracks, so a reserve costs no extra search.
        const wanted = Math.min(2, Math.max(0, limit - picked.length), neighbours.length);
        const near: Track[] = [];
        for (const n of neighbours) {
          if (near.length >= wanted) break;
          if (seen.has(n.videoId) || heardIds.has(n.videoId)) continue;
          seen.add(n.videoId);
          near.push(n as Track);
        }

        const results = interleave(picked, near, limit);
        if (results.length) {
          const body = {
            results,
            source: "dj",
            dj: djName(),
            mood,
            history: { plays: taste.plays, artists: taste.liked.slice(0, 5) },
            // How many rows came from the catalogue's neighbourhood rather than
            // from the room's own artists — the number that says whether this
            // panel is exploring or repeating.
            fresh: near.length,
          };
          memoSet(memoKey, body);
          return NextResponse.json(body);
        }
      }
    }

    // No DJ, or it had nothing usable to say. Lean on what the room actually
    // plays — its seed artist plus the artists it finishes — mixed with a
    // couple of neighbours, interleaved so the result is not one artist's
    // catalogue in order.
    const historyArtists = useHistory
      ? taste.liked
          .filter((a) => a.toLowerCase() !== (artist || "").toLowerCase())
          .slice(0, 2)
      : [];
    const queries = [artist, ...historyArtists].filter(Boolean) as string[];

    const settled = queries.length
      ? await Promise.allSettled(queries.map((q) => searchSongs(q, limit + 4)))
      : [];
    const lists = settled.map((r) => (r.status === "fulfilled" ? r.value : []));
    const seen = new Set<string>();
    const byArtist: Track[] = [];
    const longest = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < longest; i += 1) {
      for (const list of lists) {
        const t = list[i];
        if (!t || seen.has(t.videoId) || heardIds.has(t.videoId)) continue;
        seen.add(t.videoId);
        byArtist.push(t);
      }
    }

    const near: Track[] = [];
    for (const n of neighbours) {
      if (near.length >= 2) break;
      if (seen.has(n.videoId) || heardIds.has(n.videoId)) continue;
      seen.add(n.videoId);
      near.push(n as Track);
    }

    const results = interleave(byArtist, near, limit);
    if (!results.length) {
      return NextResponse.json({ results: [], source: "none", mood });
    }

    return NextResponse.json({
      results,
      source: historyArtists.length || near.length ? "history" : "artist",
      seedArtist: artist || null,
      artists: queries,
      mood,
      history: { plays: taste.plays, artists: taste.liked.slice(0, 5) },
      fresh: near.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "recommend_failed", detail: String((err as Error)?.message || err) },
      { status: 502 }
    );
  }
}
