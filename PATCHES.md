# Tandy patches on top of upstream Syncwave

Our working fork. `main` = upstream `v1.3.0` (`c9b4adc`) plus the changes below; the `upstream` remote
(SAKMZ) stays pristine so we can rebase onto a new release.

**Items 1-9 are submitted upstream as [PR #1](https://github.com/SAKMZ/syncwave/pull/1)**
(branch `fix/playback-queue-and-pwa`, cut from `v1.3.0` as a single commit of fixes only — no new
features, no AI DJ work). Items 10 and 11 and the DJ voice are deliberately fork-only until there is a
signal the maintainer is reading PRs: upstream is a solo project, 18 stars, and had never received one.

Built and deployed as **CT 1490 on Sol** (`https://listen.tandy.land`). Service notes, verification
evidence and the access model live in the vault at `02_Infrastructure/Services/Syncwave.md`.

## Fixes

| # | Area | What | Upstream-worthy |
|---|---|---|---|
| 1 | `components/Room.tsx` | Fine-sync constants assumed a LAN (40 ms tolerance). Over cellular→tailnet→IPsec the clock estimate is good to ~100 ms, so `playbackRate` was rewritten every second and iOS turned it into stutter. Tolerance 0.04→0.30, nudge 0.04→0.03, hard seek 0.75→1.5 s. | yes |
| 2 | `lib/rooms.mjs`, `app/api/rooms/route.ts` | `POST /api/rooms` accepts an optional `code` so a room can have a permanent URL (`/r/WORK`). Validated, 409 on collision. Random codes stay the default. | **yes [PR]** |
| 3 | `app/layout.tsx`, `public/manifest.webmanifest`, `app/api/room-manifest/route.ts`, `public/*.png` | PWA icons were SVG only, and **iOS ignores an SVG apple-touch-icon**, so "Add to Home Screen" gave a blank tile. Added 180/192/512 PNGs and wired both manifests (the room page installs from `/api/room-manifest`). | **yes [PR]** |
| 4 | `components/ShareButton.tsx` | "The address changes each time you restart Syncwave" is a caveat for the `--share` quick tunnel, shown whenever `publicUrl` was set — including a stable domain. Only shown for a tunnel host now. | **yes [PR]** |
| 5 | `lib/resolver.mjs` | `runDownload` had **no timeout**. A stalled yt-dlp child never settles, so `room.preparing` never clears (everyone sees buffering) *and* the download slot leaks — three stalls and nothing loads again. Kills the child after 90 s without progress, or 8 min total. | **yes [PR]** |
| 6 | `lib/rooms.mjs` | Duplicate tracks in a queue. `enqueueMany` (AI DJ, playlist import) filtered; single add returns the existing entry flagged `duplicate` and the room says "already in the queue — upvote it to move it up". | **yes [PR]** |
| 7 | `components/Room.tsx` | Mute did nothing on iPhone (`volume` is ignored programmatically — only `muted` counts) and was skipped during the 5 s crossfade at every track change. | **yes [PR]** |
| 8 | `lib/rooms.mjs`, `components/Room.tsx` | **The room only advanced when the HOST's audio fired `ended`** — server gated on `host()`, client on `if (isHost)`. A backgrounded host tab stalled the room at the end of every track until someone vote-skipped. Any listener may now report it; the server keeps the first report matching its own `current`. | **yes [PR]** |
| 9 | `lib/rooms.mjs` | (8) needs a guard: `repeat: one` replays the *same* `videoId`, so a duplicate report would advance again — six listeners, six instant skips. 3 s per-room advance debounce; also covers a queue that already holds the same video twice. | **yes [PR]** |

| 10 | `lib/rooms.mjs`, `components/Room.tsx` | **Pause was host-only and unreachable.** `CONTROL_PLAYPAUSE` gated on `host()` and the shortcut on `isHost`, so nobody else had a control — and an empty room kept its clock running all night. Now any participant can **hold the queue**: the track playing always finishes, then the room parks instead of starting the next one, and nothing is consumed from the queue. Release advances again. No one can cut the music mid-song, and the button names who is holding (`holdBy`). The last person leaving sets the hold automatically. Verified live: hold -> still playing -> parked at the boundary with the queue untouched (10 -> 10) -> release -> advanced. | **yes [PR]** |
| 11 | `lib/taste.mjs` (new), `lib/dj.mjs`, `app/api/recommend/route.ts`, `components/Recommendations.tsx`, `components/Room.tsx`, `lib/settings.mjs`, `components/AiDjSettings.tsx` | **"The DJ suggests" was a style label, not a recommendation.** The prompt was persona genre + the track playing, at the SDK's default `temperature: 0` — so the same request returned the same five names every track. Now the picker reads the room's own history (`room.history`, already persisted): what it plays through to the end, what it skips early, and what it has already heard (which it may not re-suggest). Sampling on, and the panel's refresh sends the rows it already showed as an avoid list so "something else" is a different question. `code` is passed to `/api/recommend` so the server reads history, and a 45 s memo keyed on the whole request means a six-person room makes one LLM call per track instead of six. DJ off / unreachable now searches the artists the room finishes rather than only the seed artist (`source: "history"`). Switch: `/admin` -> AI DJ -> **Influenced by history** (`djUseHistory`). | **yes [PR]** |
| 12 | `lib/related.mjs` (new), `lib/ytmusic.mjs`, `lib/taste.mjs`, `lib/dj.mjs`, `app/api/recommend/route.ts` | **History-driven suggestions fed themselves.** Suggested -> played -> in the history -> the strongest thing to suggest from, so the panel converged on the same four artists. Asking the model for "similar but different" answers from its own memory of the same names, so the novelty comes from the catalogue instead: `getUpNexts` (YouTube's own similarity graph) run over the last four tracks the room played, filtered to artists it has **never** played — 157 such artists on the real room, 20 vouched for by 2+ seeds. Prompt reserves 2 of 5 slots for them; the route enforces the rules (one row per artist, nothing by an artist that just played or was already shown, no identical row twice) and fills the reserve with real tracks when the model ignores it. Two tiers so a repeat is a fallback, never an empty panel. Taste now scores the last 60 plays, not all 120. Measured live, three refreshes: **10 rows / 4 distinct artists -> 13 rows / 13 distinct artists, no repeats**. Response carries `fresh` = rows from the neighbourhood. | **not yet** — needs a maintainer opinion on catalogue calls + prompt shape |

## DJ voice (not upstream-ready, still experimental)

Between-songs blurb: `composeBlurb()` writes 1-3 sentences from the last three played, the next three
queued (and who queued them), room mood, headcount and chat volume; `lib/djvoice.mjs` renders it to a
cached opus clip through the fleet's local Kokoro server and range-serves it at `/dj-audio/<hash>.opus`.
`/api/dj/preview?code=WORK&voice=bm_george` auditions it with no side effects — nothing is queued and
nothing is broadcast. Settings: `djVoiceProvider`, `djVoice`, `djPersonaVoices` (a voice per DJ style),
`djBlurbEvery` (default 6 — the blurb already looks three tracks back and three ahead).

**Not wired yet:** no client plays the clip. Timing, ducking and sync are the next step; until then the
endpoint is a preview only.

## Rules for this fork

- Keep each change as its own commit with the reasoning in the message, so a PR can be cut by
  cherry-picking one.
- `upstream` branch stays pristine. To take a new release: fetch upstream, rebase `main` onto the tag,
  re-verify the nine items above still apply (some may have landed).
- Never patch the deployed container in place. Edit here, push, let the dev instance build, then promote.
- Verify with a real room and, for playback changes, two listeners.
