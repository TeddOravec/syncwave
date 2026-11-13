import { NextRequest, NextResponse } from "next/server";
import { searchSongs } from "@/lib/ytmusic.mjs";
import { djEnabled, djName, suggestTracks } from "@/lib/dj.mjs";
import { getRoom } from "@/lib/rooms.mjs";
import { recentlyPlayed, tasteFromHistory } from "@/lib/taste.mjs";
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

/**
 * What to play next.
 *
 * Three sources, and the response says which one answered so the UI can be
 * honest about it:
 *
 * - `dj`      — the active persona picks, with the room's own listening history
 *               in hand (what it finishes, what it skips, what it just heard).
 *               The queries it returns are resolved through ordinary search, so
 *               a title it imagined fails to resolve instead of poisoning the
 *               queue.
 * - `history` — DJ off or unreachable: search the artists this room actually
 *               finishes, not just the one that happens to be playing. This is
 *               the case that used to look frozen, because it was one artist
 *               query answered by a static catalogue order.
 * - `artist`  — no usable history yet: search the seed artist, which is what
 *               this endpoint did before the DJ existed.
 *
 * `code` is the room code. Without it there is no history to read and the
 * endpoint behaves exactly as it always did.
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

  const memoKey = [
    code || "-",
    seed ? `${seed.artist}|${seed.title}` : "-",
    mood?.id || "-",
    limit,
    useHistory ? taste.plays : 0,
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
        count: limit,
      });
      if (queries.length) {
        // One search per suggestion, in parallel, each taking the top hit.
        // Anything that doesn't resolve is dropped silently — a miss should
        // cost a row, not the whole panel.
        const settled = await Promise.allSettled(queries.map((q) => searchSongs(q, 1)));
        const heard = new Set(history.slice(-40).map((h) => h.videoId));
        const seen = new Set<string>();
        const results: Track[] = [];
        for (const r of settled) {
          if (r.status !== "fulfilled") continue;
          const top = r.value[0];
          if (!top || seen.has(top.videoId) || heard.has(top.videoId)) continue;
          seen.add(top.videoId);
          results.push(top);
        }
        if (results.length) {
          const body = {
            results,
            source: "dj",
            dj: djName(),
            mood,
            history: { plays: taste.plays, artists: taste.liked.slice(0, 5) },
          };
          memoSet(memoKey, body);
          return NextResponse.json(body);
        }
      }
    }

    // No DJ, or it had nothing usable to say. Lean on what the room actually
    // plays: its seed artist plus the artists it finishes most, interleaved so
    // the result is not just one artist's catalogue in order.
    const historyArtists = useHistory
      ? taste.liked
          .filter((a) => a.toLowerCase() !== (artist || "").toLowerCase())
          .slice(0, 3)
      : [];
    const queries = [artist, ...historyArtists].filter(Boolean) as string[];
    if (!queries.length) {
      return NextResponse.json({ results: [], source: "none", mood });
    }

    const settled = await Promise.allSettled(queries.map((q) => searchSongs(q, limit + 4)));
    const lists = settled.map((r) => (r.status === "fulfilled" ? r.value : []));
    const heard = new Set(history.slice(-40).map((h) => h.videoId));
    const seen = new Set<string>();
    const results: Track[] = [];
    const longest = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < longest; i += 1) {
      for (const list of lists) {
        const t = list[i];
        if (!t || seen.has(t.videoId) || heard.has(t.videoId)) continue;
        seen.add(t.videoId);
        results.push(t);
      }
    }

    return NextResponse.json({
      results: results.slice(0, limit + 4),
      source: historyArtists.length ? "history" : "artist",
      seedArtist: artist || null,
      artists: queries.filter(Boolean),
      mood,
      history: { plays: taste.plays, artists: taste.liked.slice(0, 5) },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "recommend_failed", detail: String((err as Error)?.message || err) },
      { status: 502 }
    );
  }
}
