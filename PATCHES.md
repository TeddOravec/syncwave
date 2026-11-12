# Tandy patches on top of upstream Syncwave

Our working fork. `main` = upstream `v1.3.0` (`c9b4adc`) plus the changes below; `upstream` branch is
kept pristine so we can rebase onto a new release. Nothing here is upstream yet — each item is a
candidate PR, and the ones marked **[PR]** are small and self-contained enough to send.

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

| 10 | `lib/rooms.mjs`, `components/Room.tsx` | **Pause was host-only and unreachable.** `CONTROL_PLAYPAUSE` gated on `host()` and the shortcut on `isHost`, so nobody else had a control — and an empty room kept its clock running all night. Now any participant can hold the room (named in chat), and the last person leaving pauses it with the queue and position intact. Verified live: a non-host socket flipped a paused room back to playing. | **yes [PR]** |

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
