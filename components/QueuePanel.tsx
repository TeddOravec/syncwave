"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowBigUp,
  Check,
  Clock,
  Heart,
  ListMusic,
  Loader2,
  Repeat,
  Search as SearchIcon,
  User,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { Status, Track } from "@/lib/types";
import { useListTransition } from "@/hooks/useListTransition";
import { useReorder } from "@/hooks/useReorder";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/panel";
import { CountButton, DragHandle, RowAction, TrackRow } from "@/components/ui/track-row";
import { Avatar } from "@/components/ui/avatar";

function fmt(s: number) {
  if (!Number.isFinite(s) || s <= 0) return "";
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;
}

const keyOf = (t: Track) => t.id ?? t.videoId;

function QueuePanel({
  queue,
  dl,
  isHost,
  you,
  queueMode,
  order,
  onlyMine,
  onToggleOnlyMine,
  rrOut,
  inRotation,
  onToggleRotation,
  onRemove,
  onLike,
  onVote,
  onReorder,
  onOpenSearch,
  onArtistClick,
  className,
}: {
  queue: Track[];
  dl: Record<string, number>;
  isHost: boolean;
  /** Your nickname — likes and votes are recorded against it. */
  you: string;
  /** How the room is picking what plays next. */
  queueMode: "fifo" | "roundrobin";
  /** The queue in playing order (ids). Empty when there is no order to promise. */
  order: string[];
  /** The panel is filtered to this listener's own tracks. */
  onlyMine: boolean;
  onToggleOnlyMine: () => void;
  /** Nicks sitting this round out — their tracks wait, they are not skipped for good. */
  rrOut: string[];
  /** Whether this listener's own tracks are taking turns right now. */
  inRotation: boolean;
  onToggleRotation: () => void;
  onRemove: (id: string) => void;
  onLike: (id: string) => void;
  onVote: (id: string) => void;
  onReorder: (id: string, beforeId: string | null) => void;
  onOpenSearch: () => void;
  /** Artist names in the queue lead to a search for them. */
  onArtistClick: (artist: string) => void;
  className?: string;
}) {
  // One clock for the whole list rather than a timer per row.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // The list is the playing order, not the arrival order: row one is the track
  // that starts next. `order` is computed server-side by the same code that
  // picks it (lib/rotation.mjs), so this cannot drift from what actually plays.
  const ordered = useMemo(() => {
    if (!order?.length) return queue;
    const byId = new Map(queue.map((t) => [t.id as string, t]));
    const head = order.map((id) => byId.get(id)).filter((t): t is Track => Boolean(t));
    if (!head.length) return queue;
    const seen = new Set(head.map((t) => t.id));
    return [...head, ...queue.filter((t) => !seen.has(t.id))];
  }, [queue, order]);

  // Who is holding tracks, in the order their turns come — first chip is next.
  const turns = useMemo(() => {
    const out: { owner: string; count: number }[] = [];
    for (const t of ordered) {
      const owner = t.addedBy || "someone";
      const found = out.find((x) => x.owner === owner);
      if (found) found.count += 1;
      else out.push({ owner, count: 1 });
    }
    return out;
  }, [ordered]);

  // "Only mine" is a view, not a mode: same list, same order, filtered to the
  // tracks this nickname owns — which is exactly the set a person is allowed to
  // rearrange. Nothing about playback changes while it is on.
  const visible = useMemo(
    () => (onlyMine ? ordered.filter((t) => (t.addedBy || "") === you) : ordered),
    [ordered, onlyMine, you]
  );
  const visibleMins = Math.round(visible.reduce((n, t) => n + (t.duration || 0), 0) / 60);

  /** Drop targets are ids, not indexes — see the note on ordered above. */
  const dropAt = useCallback(
    (key: string, toIndex: number) => {
      const from = visible.findIndex((t) => keyOf(t) === key);
      const target = toIndex > from ? visible[toIndex + 1] : visible[toIndex];
      onReorder(key, target?.id ?? null);
    },
    [visible, onReorder]
  );

  const rows = useListTransition(visible, keyOf);
  const { state, start, move, end, shiftFor } = useReorder(dropAt);

  const indexOf = useCallback((key: string) => visible.findIndex((t) => keyOf(t) === key), [visible]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <SectionHeader
        icon={<ListMusic className="size-3.5" />}
        title={onlyMine ? "Your queue" : "Up next"}
        trailing={
          visible.length > 0 ? (
            <span className="text-[11px] text-muted">
              {visible.length} {visible.length === 1 ? "track" : "tracks"}
              {visibleMins > 0 ? ` · ${visibleMins} min` : ""}
            </span>
          ) : undefined
        }
      />

      {queue.length > 0 ? (
        <div className="mb-2 flex items-center gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5">
            {queueMode === "roundrobin" && turns.length > 1
              ? turns.map((turn, i) => (
            <span
              key={turn.owner}
              title={
                i === 0
                  ? `${turn.owner} is next — ${turn.count} queued`
                  : `${turn.owner} — ${turn.count} queued`
              }
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]",
                i === 0
                  ? "border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-ink"
                  : "border-[var(--soft-border)] bg-white/4 text-muted"
              )}
            >
              <Avatar name={turn.owner} size="sm" />
              <span
                className={cn(
                  "max-w-[7rem] truncate",
                  rrOut.includes(turn.owner) && "opacity-50 line-through decoration-1"
                )}
              >
                {turn.owner}
              </span>
              <span className="tabular-nums">{turn.count}</span>
            </span>
                ))
              : null}
          </div>
          {/* Filter, not a mode: same list, your tracks only, in your order. */}
          <button
            type="button"
            onClick={onToggleOnlyMine}
            aria-pressed={onlyMine}
            data-active={onlyMine || undefined}
            title={
              onlyMine
                ? "Showing only your tracks — press for the whole queue"
                : "Show only your tracks, to rearrange your own queue"
            }
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
              onlyMine
                ? "border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-ink"
                : "border-[var(--soft-border)] bg-white/4 text-muted hover:text-ink"
            )}
          >
            <User className="size-3" />
            Mine
          </button>

          {/* In or out of the rotation. Your tracks stay queued either way —
              this is "not my turn tonight", not "forget my queue". */}
          {queueMode === "roundrobin" ? (
            <button
              type="button"
              onClick={onToggleRotation}
              aria-pressed={inRotation}
              data-active={inRotation || undefined}
              title={
                inRotation
                  ? "Your tracks are taking turns — press to sit the round out (they stay queued)"
                  : "You are sitting the rotation out — press to put your tracks back in"
              }
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
                inRotation
                  ? "border-[color-mix(in_oklab,var(--accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-ink"
                  : "border-[var(--soft-border)] bg-white/4 text-muted hover:text-ink"
              )}
            >
              <Repeat className="size-3" />
              {inRotation ? "In rotation" : "Sitting out"}
            </button>
          ) : null}
        </div>
      ) : null}

      {visible.length === 0 ? (
        // Compact on purpose: an empty queue hands its height to the
        // suggestions below it rather than filling the column with a notice.
        <EmptyState
          compact
          icon={<ListMusic className="size-5" />}
          title={onlyMine ? "Nothing of yours is queued" : "The queue is empty"}
          hint={
            onlyMine
              ? "Add a track and it lands at the end of your own queue."
              : "Anyone in the room can add a track."
          }
          action={
            <Button variant="secondary" size="sm" onClick={onOpenSearch} className="gap-1.5">
              <SearchIcon className="size-3.5" /> Find a song
            </Button>
          }
        />
      ) : (
        <ul className="sw-scroll -mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
          {rows.map(({ item: t, key, exiting }) => {
            const i = indexOf(key);
            const liked = (t.likes ?? []).includes(you);
            const voted = (t.votes ?? []).includes(you);
            const id = t.id;
            // Round-robin turns order into a per-person thing, so your own
            // tracks are yours to arrange. In FIFO the host owns the order.
            const mine = t.addedBy === you;
            const canArrange = isHost || (queueMode === "roundrobin" && mine);
            // Queued, but its owner is sitting this round out: it stays visible
            // and recedes — no position number, because it has no turn yet.
            const parked = rrOut.includes(t.addedBy || "");

            return (
              <TrackRow
                key={key}
                index={exiting || parked ? undefined : i + 1}
                muted={parked}
                art={t.thumbnail}
                title={t.title}
                artist={t.artist}
                onArtistClick={onArtistClick}
                addedBy={t.addedBy}
                addedAt={t.addedAt}
                now={now}
                exiting={exiting}
                dragging={state.activeKey === key}
                shift={exiting ? 0 : shiftFor(i)}
                dragHandle={
                  canArrange && !exiting ? (
                    <DragHandle
                      onPointerDown={(e) => start(e, key, i, visible.length)}
                      onPointerMove={move}
                      onPointerUp={end}
                      onPointerCancel={end}
                      onKeyDown={(e) => {
                        if (!id) return;
                        // Keyboard parity for the drag: the whole point of a
                        // host-ordered queue is lost if you need a mouse.
                        if (e.key === "ArrowUp" && i > 0) {
                          e.preventDefault();
                          dropAt(key, i - 1);
                        }
                        if (e.key === "ArrowDown" && i < visible.length - 1) {
                          e.preventDefault();
                          dropAt(key, i + 1);
                        }
                      }}
                    />
                  ) : undefined
                }
                trailing={
                  <>
                    <CountButton
                      icon={<ArrowBigUp className="size-3.5" />}
                      count={t.votes?.length ?? 0}
                      active={voted}
                      // Says what it does, because a vote that silently moves
                      // the queue is a surprise the second time too.
                      label={
                        voted
                          ? `You bumped this — ${t.votes?.length ?? 0} votes`
                          : `Bump ${t.title} up the queue`
                      }
                      onClick={id && !voted ? () => onVote(id) : undefined}
                      disabled={voted}
                    />
                    <CountButton
                      icon={<Heart className={cn("size-3.5", liked && "fill-current")} />}
                      count={t.likes?.length ?? 0}
                      active={liked}
                      tone="pink"
                      label={liked ? `Unlike ${t.title}` : `Like ${t.title}`}
                      onClick={id ? () => onLike(id) : undefined}
                    />
                    <span className="hidden font-mono text-[11px] tabular-nums text-muted lg:inline">
                      {fmt(t.duration)}
                    </span>
                    <QueueStatus status={t.status} live={dl[t.videoId]} />
                  </>
                }
                actions={
                  canArrange && id ? (
                    <RowAction label={`Remove ${t.title}`} tone="danger" onClick={() => onRemove(id)}>
                      <X className="size-3.5" />
                    </RowAction>
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Whether this track is ready to play the moment it reaches the front. */
function QueueStatus({ status, live }: { status?: Status; live?: number }) {
  const pct = live ?? status?.percent ?? 0;
  const state = live != null && live < 100 ? "downloading" : (status?.state ?? "pending");

  if (state === "cached")
    return <Check className="size-4 shrink-0 text-[var(--success)]" aria-label="ready" />;
  if (state === "downloading")
    return (
      <span className="flex shrink-0 items-center gap-1 font-mono text-xs text-[var(--accent-2)]">
        <Loader2 className="size-3.5 animate-spin" />
        {pct}%
      </span>
    );
  return <Clock className="size-4 shrink-0 text-muted" aria-label="queued" />;
}

/**
 * Memoised: the room re-renders four times a second to advance the progress
 * bar, and none of that touches this panel. Its props are all stable —
 * server state or callbacks the room holds with useCallback.
 */
export default memo(QueuePanel);
