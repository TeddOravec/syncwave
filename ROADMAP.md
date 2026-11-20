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

**Status: built and verified on dev, 2026-11-19.** `queueMode` per room, switchable from the
button beside the pause control. New rooms start round-robin; rooms that existed before keep
fifo until someone presses the button. Verified with socket clients in fresh rooms: three
owners in two rooms with different seat orders (three distinct owners before any repeat both
times), then four owners plus a participant who queues nothing — `A0, B3, C5, D6, A1, B4, A2`,
each owner's own tracks in the order they queued them, the silent participant consuming no turn.
Two real bugs came out of these runs and both are worth reading, because they are the shapes
this design invites. The first:

> The first version built the rotation from the owners that still had a track queued. Once
> someone's only track played, they dropped out of the ring, so "who comes after them"
> resolved to the head of the list and the next turn went straight back to whoever had just
> played: A, C, A, B instead of A, C, B. **The ring must keep every owner, including one with
> nothing waiting; they are skipped, not deleted.**

**The panel now shows the playing order.** One list, sorted by a projection the server computes
from the same ring the player uses (`lib/rotation.mjs`), with a chip row above it naming who holds
tracks in turn order — first chip is next. That answers "what's next overall" without splitting the
column into per-person lanes: at this column width (~520 px) lanes would be ~130 px each, and on a
phone they would not exist at all. Reorder sends `{ id, beforeId }` because the visible order is a
projection; an index would mean one thing on screen and another in the array.

**Symptom Tedd reported:** one person queues forty tracks by one artist; everyone else
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
- **Sitting out is per person, not per track** (`room.rrOut`): a listener's queued tracks stay
  queued and are skipped while they are out, and resume in their own order when they flip back.
  The projection honours it, or the panel would promise tracks the player will not take.

**Identity — settled twice.** A per-device id (minted on first join, sent with `join`) was
the first answer, on the theory that a nickname is neither unique nor stable. The live room
disproved it inside an hour: one listener was a phone, a laptop and a tab that had not
reloaded, and those are three different ids, so he became three heads in the rotation, his own
queue played out of order, and the DJ's single track queued behind all of them. The room now
rotates by **nickname**, which is what likes, votes and the host seat already use and what
`sw_nick` in localStorage keeps across a reload. Two people who type the same name are one
turn; nobody in this house does, and the alternative cost a real evening.

A participant who never queues — the speaker client, `Speakers` — is in the ring and skipped
every cycle. It is not a person and it must never be given a turn it can use; if it ever
queues, it becomes an owner like anyone else, which is the honest reading.

**Shape:** per-room switch `queueMode: "fifo" | "roundrobin"`, new rooms default
round-robin, `WORK` left in fifo until Tedd flips it. Upstream-PR shaped: **no**.

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

1. ~~**§1 identity + round-robin behind `queueMode`**~~ — **done 2026-11-19** (dev, verified
   with three clients). Next within it: group the queue panel by owner so the rotation is
   visible, then flip `WORK` once Tedd has heard it.
2. **§3 DJ autoplay** — cheap now, because "does a human have anything waiting" is already a
   question the rotation answers.
3. **§2 schedule** — independent of §1/§3, but land it after them so the boundary logic is
   only touched once.
4. **§4** — probably never, if §1 does its job.

## How it deploys (since 2026-11-20)

Push to `tandy` and it ships itself: `scripts/deploy-on-push.sh`, run by
`syncwave-deploy.timer` on the CT every two minutes.

1. **dev** follows the branch immediately and rebuilds — it is the test instance and has
   nobody's song to interrupt. It only rebuilds when the SHA actually moved.
2. **live** fetches, merges `--ff-only`, and builds straight away (building disturbs nothing).
3. The recreate waits for the first moment `/api/health` reports `playing: 0`, because a
   recreate drops `current` and the track restarts from zero. 20-minute ceiling; if the room
   never goes quiet the commit stays `pending` and the next tick resumes waiting.
4. A build that fails is recorded in `failed-sha` and not retried until a newer commit — a
   broken commit cannot spin the CT forever.

State and the append-only log live in `/opt/syncwave-deploy/` (`pending`, `failed-sha`,
`deploy.log`). A merge that cannot fast-forward (local change in the checkout) is reported and
never forced: the running container is left alone.

`/api/health` carrying `{rooms, playing, listeners}` is what makes step 3 honest — no log
grepping, no guessing whether a long track is playing.

Installed on CT 1490 as `syncwave-deploy.timer` (enabled 2026-11-20). Read the last few lines of
`/opt/syncwave-deploy/deploy.log` to see what happened; `systemctl list-timers syncwave-deploy.timer`
says when it next looks. Bootstrap note: the script lives in the repo it deploys, so the very
first install needs one manual `git merge` on the CT before the timer can find it.

## Things that will bite regardless

- A deploy does not reach an already-open tab; `/api/health` build-id reload is the only
  thing that heals it. Anything client-side needs that check before "the feature does nothing".
- A server-pushed chat `kind` is a client contract — add it to `SystemKind` / `ICON` / `TONE`
  or the room crashes with React #130 the moment the event fires.
- Verify UI features through the UI, on dev, with the console captured.
