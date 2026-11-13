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

/** "Artist - Title" → its two halves. Titles may contain " - " themselves. */
function splitRow(line: string) {
  const parts = String(line || "").split(/\s+[-–—]\s+/);
  return { artist: parts[0] ?? "", title: parts.slice(1).join(" - ") };
}

/** One row, normalised — the identity a suggestion is served by. */
function rowKey(artist: string, title: string) {
  return `${artistKey(artist)} - ${String(title || "").trim().toLowerCase()}`;
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

  // The client's avoid list is what makes a refresh a different question, and
  // it has to bind the *neighbour reserve* too, not just the prompt: the reserve
  // is drawn from a ranked list, so without this every refresh handed back the
  // same two top-ranked neighbours (measured: three rounds, the same artist in
  // all three) no matter what the model did. Artist-level, because a second
  // track by an artist you were just shown is not variety.
  const avoidArtists = new Set(
    avoid.map((a) => artistKey(artistOf(a))).filter(Boolean)
  );
  // The same row must never be served twice — artist-level blocking alone let a
  // permissive pass hand back the identical track it handed back two refreshes
  // ago (measured: three rows repeated verbatim across rounds 4-6).
  const avoidRows = new Set(
    avoid.map((a) => {
      const r = splitRow(a);
      return rowKey(r.artist, r.title);
    })
  );

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
        // Enforce the diversity the prompt asked for rather than trusting it: a
        // model that ignores the rule costs a row here, not a loop in the panel.
        const recent = new Set(taste.recentArtists.map((a) => artistKey(a)));
        const seen = new Set<string>();

        /** Model lines → the ones worth searching, one per artist. */
        const select = (block: Set<string>) => {
          const used = new Set<string>();
          const out: string[] = [];
          for (const q of queries) {
            const key = artistKey(artistOf(q));
            if (!key || recent.has(key) || used.has(key) || block.has(key)) continue;
            used.add(key);
            out.push(q);
          }
          return out;
        };

        /** One search per suggestion, in parallel, top hit only. */
        const resolve = async (lines: string[]) => {
          const settled = await Promise.allSettled(lines.map((q) => searchSongs(q, 1)));
          const got: Track[] = [];
          for (const r of settled) {
            if (r.status !== "fulfilled") continue;
            const top = r.value[0];
            if (!top || seen.has(top.videoId) || heardIds.has(top.videoId)) continue;
            if (avoidRows.has(rowKey(top.artist, top.title))) continue;
            seen.add(top.videoId);
            got.push(top);
          }
          return got;
        };

        /** Neighbour rows, newest artists first, never one already used here. */
        const reserve = (wantedFor: number, block: Set<string>, used: Set<string>) => {
          const out: Track[] = [];
          for (const n of neighbours) {
            if (out.length >= wantedFor) break;
            const key = artistKey(n.artist);
            if (!key || seen.has(n.videoId) || heardIds.has(n.videoId)) continue;
            if (block.has(key) || used.has(key)) continue;
            if (avoidRows.has(rowKey(n.artist, n.title))) continue;
            seen.add(n.videoId);
            used.add(key);
            out.push(n as Track);
          }
          return out;
        };

        // Strict first: nothing by an artist that just played, nothing by an
        // artist this client has already been shown. That is what a refresh
        // means, and it is what stops the panel becoming a treadmill.
        let picked = await resolve(select(avoidArtists));
        let usedArtists = new Set(picked.map((t) => artistKey(t.artist)));
        let near = reserve(
          Math.min(neighbours.length, Math.max(2, limit - picked.length)),
          avoidArtists,
          usedArtists
        );

        // Nothing left at all means the room has heard every name we can reach
        // without repeating. An empty panel is a worse answer than a second
        // track by an artist it liked earlier, so fall back to blocking only
        // what is currently playing: different tracks, familiar names.
        if (!picked.length && !near.length) {
          picked = await resolve(select(new Set()));
          usedArtists = new Set(picked.map((t) => artistKey(t.artist)));
          near = reserve(
            Math.min(neighbours.length, Math.max(2, limit - picked.length)),
            recent,
            usedArtists
          );
        }

        const results = interleave(picked, near, limit);
        const nearIds = new Set(near.map((t) => t.videoId));
        if (results.length) {
          const body = {
            results,
            source: "dj",
            dj: djName(),
            mood,
            history: { plays: taste.plays, artists: taste.liked.slice(0, 5) },
            // How many rows came from the catalogue's neighbourhood rather than
            // from the room's own artists — the number that says whether this
            // panel is exploring or repeating. Counted on the final list, not on
            // the reserve, so an interleave that dropped one is not over-reported.
            fresh: results.filter((t) => nearIds.has(t.videoId)).length,
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
    // Keep each search's own results: we asked for an artist, so a row by
    // somebody else is noise. Once the obvious hits are filtered out, an artist
    // search starts returning karaoke and "as made famous by" covers by other
    // names (measured: a search for one room favourite surfaced a Disney cast
    // recording), and a suggestion panel is not the place to discover that.
    const lists = settled.map((r, qi) => ({
      query: queries[qi] || "",
      rows: r.status === "fulfilled" ? r.value : [],
    }));
    const seen = new Set<string>();
    const seenArtist = new Set<string>();
    const byArtist: Track[] = [];
    const longest = Math.max(0, ...lists.map((l) => l.rows.length));
    for (let i = 0; i < longest; i += 1) {
      for (const { query, rows } of lists) {
        const t = rows[i];
        if (!t || seen.has(t.videoId) || heardIds.has(t.videoId)) continue;
        const key = artistKey(t.artist);
        // One row per artist here too. Searching an artist returns their
        // catalogue in release order, so without this the fallback fills the
        // panel with three tracks by whoever happened to rank first.
        if (!key || seenArtist.has(key) || avoidArtists.has(key)) continue;
        const wanted = artistKey(query);
        if (wanted && !key.includes(wanted) && !wanted.includes(key)) continue;
        seen.add(t.videoId);
        seenArtist.add(key);
        byArtist.push(t);
      }
    }

    const usedArtists = new Set(byArtist.slice(0, 6).map((t) => artistKey(t.artist)));
    const near: Track[] = [];
    for (const n of neighbours) {
      if (near.length >= 2) break;
      const key = artistKey(n.artist);
      if (!key || seen.has(n.videoId) || heardIds.has(n.videoId)) continue;
      if (avoidArtists.has(key) || usedArtists.has(key)) continue;
      seen.add(n.videoId);
      usedArtists.add(key);
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
