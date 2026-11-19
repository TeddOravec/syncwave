# SyncWave fork — roadmap

Fork-only bookkeeping, like `PATCHES.md`. Never part of an upstream PR.
Read this before starting a feature; update it when a design settles or a decision changes.

**Stance (settled 2026-11-17): the fork is the product.** We run `TeddOravec/syncwave`
live at `https://listen.tandy.land`. A PR to upstream (SAKMZ) is a courtesy to other users,
not a gate. Opinionated product changes live here and never wait on a maintainer;
unambiguous bug fixes still go upstream as clean single-purpose PRs.

At the time of writing: `tandy` is 58 commits ahead of `upstream/main`, 0 behind.

## How work is shaped

| Kind | Where it goes |
|---|---|
| Bug fix, no product opinion | `upstream/main` cut, one commit, one PR (see `references/upstream-pr-submission.md` in the skill) |
| Product change (queue model, DJ behaviour, scheduling) | `tandy` only, one commit per change, a row in `PATCHES.md` |
| Anything that changes what the room *is* | design in this file first, then build on dev (`:3100`), then promote |

Deploy path, dev/live layout and the traps (client bundles, boundary deploys, Caddy bypass
list) are documented in the `syncwave-fork-ops` skill. This file is the *what* and *why*.

---

## 1. Queue model: per-person queues with round-robin playback  (the big one)

**Symptom Tedd reports:** one person queues forty tracks by one artist; everyone else
waits forty tracks to hear theirs. Reordering can only move one row one place at a time,
so spreading a batch out by hand is not possible.

**What exists now**

- One flat array `room.queue` — `lib/rooms.mjs:167`, rehydrated at `:87`.
- Each item is `{ ...track, id: uuid, addedBy: <nick string>, addedAt, likes[], votes[] }`
  — `normalizeItem` `:125`, `enqueue` `:780`, `enqueueMany` `:809`.
- Playback is FIFO: `pickNext()` does `queue.shift()` (random index when `shuffle`)
  — `:457`.
- A vote moves a track **one place** up, one vote per person per track — `:1140`.
- Reorder is **host-only**, one item, `toIndex` — `:1159`; the UI drags or nudges one row
  at a time (`components/QueuePanel.tsx:71`, `useReorder`).
- Duplicates are rejected per videoId across the whole room — `:774`.

**Design: keep one array, change who gets the next turn.**

Round-robin does not need per-person buckets on disk. It needs:

1. `queuedBy` — a **stable** identity on the item (see below). `addedBy` stays for display.
2. `room.rr = { lastOwner, order[] }` — the rotation pointer, persisted with the room.
3. `pickNext()` picks the oldest item whose owner is not `lastOwner`, cycling owners in
   `order` (join order, DJ last). An owner with nothing queued is skipped, not waited for.

Result: with four people in the room, the worst case for a newly queued track is three
tracks — regardless of whether one person queued five or fifty. That is the whole point;
the queue stops being first-come-first-served and becomes fair per head.

Consequences to design honestly:

- **Votes and drag-reorder become intra-person.** They order *your* tracks relative to
  each other; they can no longer jump you over another person. Keep the count visible.
  Cross-person pressure is the rotation, which nobody can bribe.
- **Shuffle has to be defined per queue**, not per room, or it silently defeats fairness.
  Proposal: shuffle randomises the order *inside* each person's tracks, rotation stays.
- **The DJ is a pseudo-owner** (it already enqueues under `djName()` — `:862`). Give it the
  last slot in the rotation and never let its tracks outrank a waiting human.
- **Duplicates across people**: two people queueing the same videoId is now ambiguous —
  whose turn does it take? Proposal: a second queueing *joins* the existing item as a
  co-owner (`queuedBy: [a, b]`) and the item takes the turn of whoever is earliest in the
  rotation.
- **`repeat: all`** re-pushes the finished track to the back with `addedBy` intact — it
  should keep its owner rather than becoming ownerless.

**Open question — identity.** `addedBy` is a nickname typed at join. It is neither unique
nor stable: a seat is keyed by socket id (`:931`) and only survives a reconnect by matching
the nick string (`:922`). Round-robin needs something a person cannot accidentally shed:
a `localStorage` device token minted on first join and sent with the join payload, mapped to
the nick. That also fixes "I queued ten and my reload lost my turn".

**Shape:** per-room switch `queueMode: "fifo" | "roundrobin"`, new rooms default
round-robin, `WORK` flipped once Tedd has heard it. Upstream-PR shaped: **no**.

---

## 2. Schedule: auto-pause and auto-play at set times

**Want:** music starts by itself in the morning and stops at the end of the day.

**What exists now** — and it is most of the work already:

- Holding the queue is the pause primitive: the current track always finishes, the room
  parks at the boundary, nothing is consumed — `holdQueue` / `holdBy` (`:1191`).
- The room already holds itself when the last person leaves (`:1402`, `holdBy: "nobody left"`)
  and resumes on first presence (`:954`).

So a schedule is a *timer that flips `holdQueue`*, not new playback machinery.

**Design**

- Per-room `schedule: { open: "07:00", close: "23:00", days: [0-6], tz: "America/Chicago" }`
  on the room object, persisted alongside `shuffle` / `repeat` (`persist()` `:134`).
  Per-room, **not** `/admin` — `lib/settings.mjs` is instance-wide and that is the wrong
  scope for "when does *this* room run".
- One 60 s interval per room (or a single sweeper over all rooms) evaluates `open`/`close`
  in the room's own timezone — `ROOM_TZ` already exists as a default (`lib/dj.mjs:170`).
- Close: set `holdQueue = true`, `holdBy = "schedule"`, system chat line. The track under
  the needle finishes; nothing else starts.
- Open: clear the hold, and if the room already has listeners start the next track; if it
  has none, do nothing — `seatParticipant` already resumes on first arrival. Starting audio
  into an empty room is a download and a yt-dlp hit for nobody.
- Manual hold always wins over the schedule until the next boundary; say who did it.

**Known risk, do not paper over it:** browsers refuse to start audio without a gesture. A
tab left open overnight may set the room to playing (server state is authoritative) and then
fail to produce sound until someone taps. There is already a tap-to-enable affordance for
that (`components/Room.tsx:949`), but a schedule makes it *routine* rather than rare, so it
needs a visible "tap to listen" state on the schedule path, not a silent no-op.

Upstream-PR shaped: **no**.

---

## 3. DJ keeps playing when the queue runs out

**Want:** if nobody has queued anything, the DJ keeps the music going out of the suggestion
feed, still influenced by what people add.

**What exists now**

- An empty queue **stops the room** — `playNext` sets `current = null, isPlaying = false`
  at `:556-567`.
- The suggestion engine is already server-side and room-aware: `suggestTracks()` (`lib/dj.mjs`),
  history/taste (`lib/taste.mjs`), catalogue novelty (`lib/related.mjs`), memoised in
  `app/api/recommend/route.ts`, and `/dj` requests already enqueue under `djName()` (`:862`).

**Design**

- Per-room `autoDj: { enabled: boolean, ahead: 2 }` — the DJ may keep at most `ahead`
  tracks queued, and only when **no human item is waiting**.
- Trigger on the same boundary as `playNext`: if the queue is empty (or below `ahead`).
  Reuse the existing suggest path rather than a second one, so the panel and autoplay can
  never disagree about what the room is into.
- The DJ is a pseudo-owner in the round-robin (above) and yields to every human, so
  someone queueing mid-session is heard within a track or two, not after the DJ's block.
- Existing guards still apply: one row per artist, nothing an artist just played, nothing
  already in the queue, no repeat of a recent row. Cost is one LLM call per fill — memoised.
- Failure is not fatal: no suggestions means the room parks exactly as it does today, with
  the same message. Never let autoplay turn "empty queue" into an error loop.

Upstream-PR shaped: **no**.

---

## 4. Queue controls: batch operations

**Symptom:** spreading an artist run apart is manual drag, one row at a time.

**What exists now:** drag/nudge reorder, host-only, one item (`:1159`,
`components/QueuePanel.tsx`); remove is one row at a time (`:1109`).

**Design (cheap, and mostly obsolete once §1 lands)**

- **Select mode** — checkbox per row, then act on the selection: remove, move to top,
  insert at position N.
- **Spread** — take the selected rows (typically one artist or one album pasted as a batch)
  and interleave them at even intervals across the queue. This is the one control people
  actually want, and under per-person queues it only needs to act inside your own tracks.
- **Batch move** — drag a multi-row selection as a block.

Once §1 is live, most of the pressure behind this disappears: your forty tracks no longer
sit in front of anyone. Build §1 first and re-ask whether this is still worth the UI.

Upstream-PR shaped: **no** for spread; the multi-select *remove* is small enough to be
upstreamable later if the maintainer ever engages.

---

## Order of work

1. **§1 identity + round-robin behind `queueMode`** — dev, `WORK` room, listen to it with
   more than one person before flipping the default.
2. **§3 DJ autoplay** — cheap once §1 exists, because "does a human have anything waiting"
   is already a question the rotation answers.
3. **§2 schedule** — independent of §1/§3, but land it after them so the boundary logic is
   only touched once.
4. **§4** — probably never, if §1 does its job.

## Things that will bite regardless

- A deploy does not reach an already-open tab; `/api/health` build-id reload is the only
  thing that heals it. Anything client-side needs that check before "the feature does nothing".
- A server-pushed chat `kind` is a client contract — add it to `SystemKind` / `ICON` / `TONE`
  or the room crashes with React #130 the moment the event fires.
- Verify UI features through the UI, on dev, with the console captured.
