"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Mood, Track } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/panel";
import { TrackRowSkeleton } from "@/components/ui/skeleton";
import { RowAction, TrackRow } from "@/components/ui/track-row";

type Source = "dj" | "history" | "artist" | "none";
type HistoryInfo = { plays: number; artists: string[] } | null;

/** How many of this client's own past suggestions are withheld on a refresh. */
const AVOID_MAX = 24;

/**
 * Somewhere to go next, so an empty queue is a suggestion rather than a blank
 * panel.
 *
 * The panel names its basis, because "recommended" with an unstated reason
 * invites people to read intention into a string match. Three bases now:
 *
 * - `dj`      — the AI DJ, picking with this room's listening history in hand.
 * - `history` — DJ off: the artists this room actually finishes, not just the
 *               one that is playing. Previously this was one seed-artist query,
 *               which is why the same rows seemed to sit there all night.
 * - `artist`  — no history yet (a brand new room), so: more from this artist.
 *
 * `code` is what makes the history readable at all; without it the server can
 * only see the track it was told about.
 */
function Recommendations({
  code,
  seed,
  mood,
  excludeIds,
  onAdd,
  limit = 5,
  className,
}: {
  /** Room code — the server reads this room's play history through it. */
  code: string;
  /** The track to draw from — normally whatever is playing. */
  seed: Track | null;
  mood: Mood | null;
  /** videoIds already playing or queued; never suggest those back. */
  excludeIds: Set<string>;
  onAdd: (t: Track) => void;
  limit?: number;
  className?: string;
}) {
  const [results, setResults] = useState<Track[]>([]);
  const [source, setSource] = useState<Source>("none");
  const [dj, setDj] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryInfo>(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [nonce, setNonce] = useState(0);

  // Suggestions this client has already been shown, so "suggest something
  // else" is a different question rather than the same one asked louder.
  // Reset whenever the basis changes — a new track deserves a clean slate.
  const shownRef = useRef<string[]>([]);
  const basisKeyRef = useRef("");

  // Primitives, not the object: `seed` gets a fresh identity on every playback
  // broadcast, and refetching suggestions several times a second would be rude
  // to both YouTube Music and whatever model is behind the DJ.
  const title = seed?.title ?? "";
  const artist = seed?.artist ?? "";
  const moodId = mood?.id ?? "";

  useEffect(() => {
    const basisKey = `${code}\u0000${title}\u0000${artist}\u0000${moodId}`;
    if (basisKeyRef.current !== basisKey) {
      basisKeyRef.current = basisKey;
      shownRef.current = [];
    }

    // Nothing to seed from and no room to read history from — leave the panel
    // out of the way rather than ask a question with no context.
    if (!artist && !code) {
      setResults([]);
      setSource("none");
      setHistory(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const params = new URLSearchParams({ limit: String(limit), code });
    if (title) params.set("title", title);
    if (artist) params.set("artist", artist);
    if (moodId) params.set("mood", moodId);
    if (shownRef.current.length) params.set("avoid", shownRef.current.join("\n"));

    fetch(`/api/recommend?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const list: Track[] = Array.isArray(d.results) ? d.results : [];
        setResults(list);
        setSource((d.source ?? "none") as Source);
        setDj(d.dj ?? null);
        setHistory(d.history ?? null);
        // Keep the last two rounds: a third ask may reasonably reuse the first
        // answer, and an ever-growing list would starve the model of ideas.
        shownRef.current = [
          ...list.map((t) => `${t.artist} - ${t.title}`),
          ...shownRef.current,
        ].slice(0, AVOID_MAX);
      })
      .catch(() => {
        // A failed suggestion is not worth an error state; the section stays
        // out of the way until the next track changes it.
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [code, title, artist, moodId, limit, nonce]);

  const shown = results.filter((t) => !excludeIds.has(t.videoId)).slice(0, limit);

  // Nothing playing and nothing to suggest — the queue panel above is already
  // saying "add a track", so don't say it twice.
  if (!seed && !loading && shown.length === 0) return null;

  const plays = history?.plays ?? 0;
  const basis =
    source === "dj" && dj
      ? `${dj}'s pick${plays ? ` · ${plays} plays` : ""}${mood ? ` · ${mood.label.toLowerCase()}` : ""}`
      : source === "history"
        ? `from ${plays} play${plays === 1 ? "" : "s"} here`
        : seed
          ? `from ${seed.artist}`
          : null;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <SectionHeader
        icon={<Sparkles className="size-3.5" />}
        title={
          source === "dj"
            ? "The DJ suggests"
            : source === "history"
              ? "What this room plays"
              : "More like this"
        }
        trailing={
          <>
            {basis && (
              <span className="max-w-[12rem] truncate text-[11px] text-muted">{basis}</span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setNonce((n) => n + 1)}
              disabled={loading || (!seed && shown.length === 0)}
              aria-label="Suggest something else"
              title="Suggest something else"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      <ul className="sw-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
        {loading && shown.length === 0 && <TrackRowSkeleton count={3} />}

        {!loading && shown.length === 0 && (
          <li className="flex flex-1">
            <EmptyState
              icon={<Sparkles className="size-5" />}
              title="No suggestions right now"
              hint="Search for something instead — anything you add seeds the next set."
            />
          </li>
        )}

        {shown.map((t) => (
          <TrackRow
            key={t.videoId}
            art={t.thumbnail}
            title={t.title}
            artist={t.artist}
            actions={
              <RowAction
                label={added[t.videoId] ? `${t.title} added` : `Add ${t.title}`}
                tone="accent"
                onClick={() => {
                  onAdd(t);
                  setAdded((a) => ({ ...a, [t.videoId]: true }));
                }}
              >
                <Plus
                  className={cn(
                    "size-4 transition-transform duration-200 ease-[var(--ease)]",
                    added[t.videoId] && "rotate-45"
                  )}
                />
              </RowAction>
            }
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * Memoised: the room re-renders four times a second to advance the progress
 * bar, and none of that touches this panel. Its props are all stable —
 * server state or callbacks the room holds with useCallback.
 */
export default memo(Recommendations);
