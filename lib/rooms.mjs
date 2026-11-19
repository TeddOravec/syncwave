// In-memory room store (persisted to disk) + Socket.io wiring.
// The SERVER owns the playback clock; clients render their <audio> position
// from `startedAt`, so everyone stays in sync. Rooms are durable: they survive
// an empty room and a server restart (permanent links). Ownership is by a
// durable ownerToken the creator holds in localStorage.

import { customAlphabet } from "nanoid";
import {
  EVENTS,
  MOODS,
  RECONNECT_GRACE_MS,
  SKIP_THRESHOLD,
  STATUSES,
} from "./protocol.mjs";
import { prefetchAudio, ensureAudio, touchCache, cacheStatus, cachedGain } from "./resolver.mjs";
import { loadSync, saveDebounced } from "./store.mjs";
import { searchSongs } from "./ytmusic.mjs";
import { djEnabled, generateIntro, composeBlurb, offeredIdeas, interpretRequest, djName } from "./dj.mjs";
import { synthesize, voiceEnabled, clipUrl } from "./djvoice.mjs";
import { activeVoice } from "./settings.mjs";

/**
 * Playback time, on a clock that only ever moves forward.
 *
 * `startedAt` and the `serverNow` clients calibrate against have to advance at
 * the same rate and never jump. `Date.now()` does jump: an NTP correction, a
 * VM suspend and resume, or someone fixing the server's timezone steps it by
 * whatever the drift was. Every listener derives its audio position from those
 * two numbers, so a step doesn't desync one client — it yanks the entire room
 * at once, mid-song.
 *
 * The wall-clock anchor is taken once at boot purely so the values still look
 * like timestamps on the wire. Nothing downstream depends on them matching
 * real time, only on the difference between them being honest. Rooms restore
 * with `startedAt: 0`, so these never have to survive a restart.
 */
const WALL_AT_BOOT = Date.now();
const MONO_AT_BOOT = performance.now();
const monoNow = () => WALL_AT_BOOT + (performance.now() - MONO_AT_BOOT);

const genCode = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 6);
const genToken = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 24);

/** How much of the room's past it remembers. Bounded — this is all in memory. */
const HISTORY_MAX = 120;
/** Window the mood is inferred over. */
const MOOD_WINDOW_MS = 10 * 60 * 1000;

/** @type {Map<string, any>} */
const rooms = (globalThis.__SW_ROOMS ??= new Map());

/** Empty session counters. Reset per process, not per room lifetime. */
function freshSession() {
  return {
    startedAt: Date.now(),
    messages: 0,
    reactions: 0,
    skips: 0,
    /** Every nickname seen this session, so "listeners" isn't just who's here now. */
    seen: new Set(),
    /** Rolling signal log for the mood. Trimmed to MOOD_WINDOW_MS on read. */
    recentReactions: [],
    recentSkips: [],
  };
}

// Rehydrate durable rooms once at startup.
if (!globalThis.__SW_ROOMS_LOADED) {
  globalThis.__SW_ROOMS_LOADED = true;
  const saved = loadSync("rooms", {});
  for (const [code, r] of Object.entries(saved)) {
    rooms.set(code, {
      code,
      name: r.name || `Room ${code}`,
      ownerToken: r.ownerToken || null,
      createdAt: r.createdAt || Date.now(),
      hostId: null,
      participants: new Map(),
      // ip -> { until, nick }. Never persisted (see persist() below) — a kick
      // ban resets on restart, consistent with this being a lightweight
      // moderation tool rather than a security system.
      bannedIps: new Map(),
      inviteOnly: Boolean(r.inviteOnly),
      // socketId -> { id, nick, requestedAt }. Live-session only — someone
      // waiting for approval when the server restarts just rejoins the queue.
      pending: new Map(),
      queue: (r.queue || []).map(normalizeItem),
      history: r.history || [],
      current: null,
      startedAt: 0,
      isPlaying: false,
      preparing: false,
      playToken: 0,
      pausedPosition: 0,
      // Holding the queue is not pausing the music: the track under the needle
      // always finishes. `holdBy` is who asked for it, so the button can say so.
      holdQueue: Boolean(r.holdQueue),
      holdBy: r.holdBy || null,
      shuffle: r.shuffle || false,
      repeat: r.repeat || "off",
      // "fifo" = first come, first served; "roundrobin" = each person in the
      // room gets a turn. Rooms that predate the switch keep what they had.
      queueMode: r.queueMode === "roundrobin" ? "roundrobin" : "fifo",
      /** Owners in the order they first queued — the rotation's memory. */
      rrOrder: Array.isArray(r.rrOrder) ? r.rrOrder.filter((o) => typeof o === "string") : [],
      /** Who was served last. In memory only: a restart resets the rotation. */
      rrLast: null,
      skipVotes: new Set(),
      chat: [],
      mood: null,
      // Tracks played since the DJ last spoke. `null` means "not since this
      // process started", which makes the room's first track announce itself
      // rather than waiting out a full cadence nobody has heard yet.
      sinceBlurb: null,
      // The last few things the host said, so it can avoid repeating its own
      // shape. In memory only: a restart is a new show.
      djRecent: [],
      // Which angles were offered last time. The menu rotates so the host is
      // never handed the same three choices twice in a row.
      djIdeaIdx: 0,
      djIdeaRecent: [],
      session: freshSession(),
    });
  }
}

/**
 * Bring a queue item up to the current shape. Rooms persisted before likes and
 * votes existed replay with neither, and every read site would otherwise need
 * its own `?? []`.
 */
function normalizeItem(t) {
  return {
    ...t,
    addedAt: t.addedAt ?? Date.now(),
    likes: Array.isArray(t.likes) ? t.likes : [],
    votes: Array.isArray(t.votes) ? t.votes : [],
  };
}

function persist() {
  const out = {};
  for (const [code, r] of rooms) {
    // Persist the upcoming list (with current re-queued at front so nothing is lost).
    const queue = [r.current, ...r.queue].filter(Boolean);
    out[code] = {
      code,
      name: r.name,
      ownerToken: r.ownerToken,
      createdAt: r.createdAt,
      shuffle: r.shuffle,
      repeat: r.repeat,
      queueMode: r.queueMode === "roundrobin" ? "roundrobin" : "fifo",
      rrOrder: r.rrOrder,
      inviteOnly: r.inviteOnly,
      queue,
      history: r.history.slice(-HISTORY_MAX),
    };
  }
  saveDebounced("rooms", out);
}

export function createRoom(name, inviteOnly, wantedCode) {
  const code = wantedCode || genCode();
  const ownerToken = genToken();
  const room = {
    code,
    name: name || `Room ${code}`,
    ownerToken,
    createdAt: Date.now(),
    hostId: null,
    participants: new Map(),
    bannedIps: new Map(),
    inviteOnly: Boolean(inviteOnly),
    pending: new Map(),
    queue: [],
    history: [],
    current: null,
    startedAt: 0,
    isPlaying: false,
    preparing: false,
    playToken: 0,
    pausedPosition: 0,
    shuffle: false,
    repeat: "off",
    // A new room starts fair: everyone's first track is heard before anyone's
    // second. Switchable in the room, and FIFO is still one tap away.
    queueMode: "roundrobin",
    rrOrder: [],
    rrLast: null,
    skipVotes: new Set(),
    chat: [],
    mood: null,
    sinceBlurb: null,
    djRecent: [],
    djIdeaIdx: 0,
    djIdeaRecent: [],
    session: freshSession(),
  };
  rooms.set(code, room);
  persist();
  return room;
}

export function getRoom(code) {
  return rooms.get(code);
}

/* ------------------------------------------------------------------ state */

function queueWithStatus(room) {
  return room.queue.map((t) => ({ ...t, status: cacheStatus(t.videoId) }));
}

/** Where the current track is, in seconds, whether it's running or paused. */
function elapsed(room) {
  if (!room.current) return 0;
  if (room.preparing) return 0;
  return room.isPlaying ? (monoNow() - room.startedAt) / 1000 : room.pausedPosition;
}

/**
 * A summary of the session so far.
 *
 * Derived on read rather than kept as running totals: the inputs (history,
 * counters) are small and bounded, and a derived number can't drift out of
 * step with the thing it describes.
 */
function roomStats(room) {
  const s = room.session;
  const played = room.history;

  const listenedSec =
    played.reduce((n, h) => n + (h.playedSec || 0), 0) + elapsed(room);

  const byContributor = new Map();
  for (const h of played) {
    if (!h.addedBy) continue;
    byContributor.set(h.addedBy, (byContributor.get(h.addedBy) || 0) + 1);
  }
  let topContributor = null;
  for (const [nick, count] of byContributor) {
    if (!topContributor || count > topContributor.count) topContributor = { nick, count };
  }

  let mostLiked = null;
  for (const h of played) {
    const likes = h.likes?.length || 0;
    if (likes > 0 && (!mostLiked || likes > mostLiked.likes)) {
      mostLiked = { title: h.title, artist: h.artist, thumbnail: h.thumbnail, likes };
    }
  }

  return {
    since: s.startedAt,
    songsPlayed: played.length,
    listenedSec: Math.round(listenedSec),
    listeners: s.seen.size,
    hereNow: [...room.participants.values()].filter((p) => p.status !== "reconnecting").length,
    messages: s.messages,
    reactions: s.reactions,
    skips: s.skips,
    topContributor,
    mostLiked,
  };
}

/**
 * What the room feels like right now.
 *
 * Rule-based on purpose — see MOODS. The signals are all rates over the last
 * ten minutes so a burst an hour ago doesn't hold the room hostage.
 */
function moodFor(room) {
  const now = Date.now();
  const cutoff = now - MOOD_WINDOW_MS;
  const mins = MOOD_WINDOW_MS / 60000;

  const reactions = room.session.recentReactions.filter((r) => r.ts >= cutoff);
  const skips = room.session.recentSkips.filter((ts) => ts >= cutoff);
  const chats = room.chat.filter((m) => !m.system && m.ts >= cutoff);
  const recentTracks = room.history.slice(-5);

  const hearts = reactions.filter((r) => r.emoji === "❤️").length;

  const signals = {
    reactionRate: reactions.length / mins,
    chatRate: chats.length / mins,
    skipRate: skips.length / mins,
    heartShare: reactions.length ? hearts / reactions.length : 0,
    avgTrackSec: recentTracks.length
      ? recentTracks.reduce((n, t) => n + (t.duration || 0), 0) / recentTracks.length
      : 0,
    hour: new Date().getHours(),
  };

  const hit = MOODS.find((m) => m.match(signals)) ?? MOODS[MOODS.length - 1];
  return { id: hit.id, emoji: hit.emoji, label: hit.label, why: hit.why };
}

/**
 * What a participant looks like on the wire.
 *
 * Whitelisted rather than spread, because everything on this object is walked
 * by the socket.io encoder before it goes out. Anything not JSON — a timer, a
 * socket, a stream — is a live crash rather than a stray field: the encoder
 * recurses through it looking for binary, and Node's internals are full of
 * circular references, so it never comes back.
 */
function publicParticipant(p) {
  return {
    id: p.id,
    nick: p.nick,
    isHost: p.isHost,
    status: p.status,
    statusAt: p.statusAt,
    joinedAt: p.joinedAt,
    songsAdded: p.songsAdded,
    messages: p.messages,
    reactions: p.reactions,
    muted: p.muted,
  };
}

function publicState(room, socketId) {
  const isHost = room.participants.get(socketId)?.isHost;
  return {
    code: room.code,
    name: room.name,
    queue: queueWithStatus(room),
    participants: [...room.participants.values()].map(publicParticipant),
    history: room.history.slice(-HISTORY_MAX),
    stats: roomStats(room),
    mood: room.mood,
    current: room.current,
    startedAt: room.startedAt,
    isPlaying: room.isPlaying,
    preparing: room.preparing,
    pausedPosition: room.pausedPosition,
    shuffle: room.shuffle,
    repeat: room.repeat,
    queueMode: room.queueMode === "roundrobin" ? "roundrobin" : "fifo",
    holdQueue: Boolean(room.holdQueue),
    holdBy: room.holdBy || null,
    serverNow: monoNow(),
    skipVotes: room.skipVotes.size,
    you: socketId,
    aiDj: djEnabled() ? djName() : null,
    inviteOnly: room.inviteOnly,
    // Only the host's own snapshot carries the pending list — this function
    // has exactly one call site (JOIN), so there's no other leak surface.
    pending: isHost ? [...room.pending.values()] : [],
  };
}

function broadcastPending(io, room) {
  if (room.hostId) {
    io.to(room.hostId).emit(EVENTS.PENDING_UPDATE, { pending: [...room.pending.values()] });
  }
}

/* -------------------------------------------------------------- broadcast */

function broadcastPlayback(io, room) {
  io.to(room.code).emit(EVENTS.PLAYBACK_UPDATE, {
    current: room.current,
    startedAt: room.startedAt,
    isPlaying: room.isPlaying,
    preparing: room.preparing,
    pausedPosition: room.pausedPosition,
    shuffle: room.shuffle,
    repeat: room.repeat,
    queueMode: room.queueMode === "roundrobin" ? "roundrobin" : "fifo",
    holdQueue: Boolean(room.holdQueue),
    holdBy: room.holdBy || null,
    serverNow: monoNow(),
    skipVotes: room.skipVotes.size,
  });
}
function broadcastQueue(io, room) {
  io.to(room.code).emit(EVENTS.QUEUE_UPDATE, { queue: queueWithStatus(room) });
}
function broadcastParticipants(io, room) {
  io.to(room.code).emit(EVENTS.PARTICIPANTS_UPDATE, {
    participants: [...room.participants.values()].map(publicParticipant),
  });
}
function broadcastHistory(io, room) {
  io.to(room.code).emit(EVENTS.HISTORY_UPDATE, { history: room.history.slice(-HISTORY_MAX) });
}

/**
 * Stats change on nearly every event, and nobody needs them at 60Hz. One
 * broadcast per room per two seconds is plenty for a summary panel, and it
 * keeps a busy room from spending its bandwidth on its own scoreboard.
 */
const statsTimers = new Map();

/**
 * socket id → the timer holding that seat during the reconnect grace period.
 * Kept here and not on the participant, which is broadcast verbatim.
 */
const dropTimers = new Map();

function broadcastStats(io, room) {
  if (statsTimers.has(room.code)) return;
  statsTimers.set(
    room.code,
    setTimeout(() => {
      statsTimers.delete(room.code);
      io.to(room.code).emit(EVENTS.STATS_UPDATE, { stats: roomStats(room) });
    }, 2000)
  );
}

/**
 * Say whether the DJ is composing.
 *
 * Tracked per room so a late `false` from an abandoned call can't switch off an
 * indicator a newer call turned on, and cleared on a timer as a backstop: a
 * process that dies mid-generation would otherwise leave every client in the
 * room believing the DJ is still typing, with nothing left alive to say
 * otherwise.
 */
const djTypingTimers = new Map();
function djTyping(io, room, on) {
  clearTimeout(djTypingTimers.get(room.code));
  djTypingTimers.delete(room.code);
  if (on) {
    djTypingTimers.set(
      room.code,
      setTimeout(() => {
        djTypingTimers.delete(room.code);
        io.to(room.code).emit(EVENTS.DJ_TYPING, { typing: false, nick: djName() });
      }, 30_000)
    );
  }
  io.to(room.code).emit(EVENTS.DJ_TYPING, { typing: on, nick: djName() });
}

/** Recompute the mood, and tell the room only when it actually changed. */
function refreshMood(io, room) {
  const next = moodFor(room);
  if (room.mood?.id === next.id) return;
  room.mood = next;
  io.to(room.code).emit(EVENTS.MOOD_UPDATE, { mood: next });
}

/**
 * Append to the room log and broadcast it.
 *
 * A message is either something a person (or the DJ) said, or something that
 * happened. The second kind carries `kind` and usually `actor` so the client
 * can render it as an event — icon, avatar, timestamp — instead of parsing the
 * sentence back out of `text`. `text` stays authoritative either way: rooms
 * persisted before `kind` existed replay fine, they just render generically.
 */
function pushChat(io, room, msg) {
  const entry = { id: crypto.randomUUID(), ts: Date.now(), ...msg };
  room.chat.push(entry);
  if (room.chat.length > 200) room.chat.shift();
  io.to(room.code).emit(EVENTS.CHAT_NEW, entry);
}

// Warm a track and stream its download progress to the room.
function warm(io, room, videoId) {
  prefetchAudio(videoId, (pct) => {
    io.to(room.code).emit(EVENTS.DOWNLOAD_PROGRESS, { videoId, percent: pct });
  });
}

// Whose turn a queued track belongs to: the nickname it was added under, which
// is the identity the room already uses for likes, votes and the host seat.
//
// A per-device id was tried first and it was wrong for this room. A listener
// reaches us from a phone, a laptop and a tab that had not reloaded yet; each
// of those produced a different id, so one person became three heads in the
// rotation, their own queue played out of order, and the DJ's single track
// waited behind all of them. The nickname survives a reload on its own
// (`sw_nick` in localStorage) and is what everyone in the room can see.
function ownerOf(t) {
  return t?.addedBy || "someone";
}

/** Remember an owner so the rotation has a stable order to cycle through. */
function noteOwner(room, owner) {
  if (!owner) return;
  if (!room.rrOrder) room.rrOrder = [];
  if (!room.rrOrder.includes(owner)) room.rrOrder.push(owner);
}

/**
 * Give the turn to the next person who has something queued, instead of to
 * whoever queued first. One person queueing forty tracks by one artist no
 * longer puts forty tracks in front of everybody else — the rotation is by
 * head, so the worst case is one track per other person in the room.
 *
 * The order is the order people first queued, and the DJ sits at the end of
 * it: its fill tracks must never outrank a person who is waiting.
 */
function pickRoundRobin(room) {
  if (!room.queue.length) return null;

  const present = [];
  for (const t of room.queue) {
    const o = ownerOf(t);
    if (!present.includes(o)) present.push(o);
  }

  // The ring is every owner this room has queued for, in first-queue order.
  // It deliberately keeps people who currently have nothing queued: dropping
  // them makes the ring shorter, and "who is after the last person" then
  // resolves to the head of the list — which hands the next turn straight back
  // to whoever just played and lets someone wait two turns for nothing.
  const ring = [];
  for (const o of room.rrOrder || []) if (!ring.includes(o)) ring.push(o);
  for (const o of present) if (!ring.includes(o)) ring.push(o);

  // The DJ keeps its slot at the end: a fill track may never outrank a person.
  const dj = djName();
  if (ring.includes(dj)) {
    ring.splice(ring.indexOf(dj), 1);
    ring.push(dj);
  }

  const last = room.rrLast;
  const at = last ? ring.indexOf(last) : -1;
  const start = at >= 0 ? at + 1 : 0;
  let owner = null;
  for (let n = 0; n < ring.length; n++) {
    const cand = ring[(start + n) % ring.length];
    // Skipping `last` is what makes it a rotation rather than "the same
    // person twice" — unless they are the only one with anything queued.
    if (cand !== last && present.includes(cand)) {
      owner = cand;
      break;
    }
  }
  if (!owner) owner = present[0];

  room.rrLast = owner;
  // Each turn is the owner's **next track in line**. Round-robin is about
  // whose turn it is, not about shuffling anyone's list — a random pick here
  // reads as "it ignored my order", which is exactly what it did.
  const mine = room.queue.filter((t) => ownerOf(t) === owner);
  const i = room.queue.indexOf(mine[0]);
  return room.queue.splice(i, 1)[0];
}

// Pull the next track off the queue — the next person's turn when the room is
// running round-robin, a random position when shuffle is on, else the front.
function pickNext(room) {
  if (!room.queue.length) return null;
  if (room.queueMode === "roundrobin") return pickRoundRobin(room);
  if (room.shuffle) {
    const i = Math.floor(Math.random() * room.queue.length);
    return room.queue.splice(i, 1)[0];
  }
  return room.queue.shift();
}

/**
 * File the track that just finished into the room's history.
 *
 * `skipped` is inferred rather than passed around: a track that leaves with
 * more than five seconds left on it did not end on its own, whoever cut it
 * short. The likes it collected travel with it, which is what makes "most
 * liked song" answerable at the end of a session.
 */
function recordHistory(io, room, { skipped }) {
  const t = room.current;
  if (!t) return;
  const playedSec = Math.max(0, Math.min(t.duration || 0, elapsed(room)));
  room.history.push({
    id: crypto.randomUUID(),
    videoId: t.videoId,
    title: t.title,
    artist: t.artist,
    thumbnail: t.thumbnail,
    art: t.art,
    duration: t.duration,
    addedBy: t.addedBy,
    likes: t.likes || [],
    playedAt: Date.now(),
    playedSec: Math.round(playedSec),
    skipped,
  });
  if (room.history.length > HISTORY_MAX) room.history.shift();
  if (skipped) {
    room.session.skips += 1;
    room.session.recentSkips.push(Date.now());
  }
  broadcastHistory(io, room);
  broadcastStats(io, room);
  refreshMood(io, room);
}

/**
 * How many tracks may fail back-to-back before the room stops trying.
 *
 * A failure is usually not about the track — a 403 from YouTube, an expired
 * cookie, a proxy pool that has run dry — so the next track fails the same
 * way, and the one after that. Advancing through a queue of them as fast as
 * yt-dlp can refuse is a spinning loop that writes a line of chat per attempt
 * and teaches the room nothing.
 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Reports of the same track ending that land inside this window are ignored. */
const ADVANCE_DEBOUNCE_MS = 3_000;
/** How far ahead of a blurb the clients are told to start it — time to fetch it. */
const BLURB_LEAD_MS = 400;
/** A spoken blurb may hold the room's clock for this long at most. */
const MAX_BLURB_MS = 25_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playNext(io, room, { fromEnd = false, failed = false } = {}) {
  room.skipVotes.clear();
  // Everything that moves the room stamps this. `track:ended` is now reported by
  // every listener, and repeat=one replays the SAME videoId, so a report must be
  // judged against "when did we last advance" as well as which track is current.
  room.lastAdvanceAt = Date.now();

  // Repeat-one: a track that ends on its own just replays (no re-cache needed).
  // An explicit skip (fromEnd=false) bypasses this and moves on.
  if (fromEnd && room.repeat === "one" && room.current) {
    recordHistory(io, room, { skipped: false });
    room.playToken++;
    room.startedAt = monoNow();
    room.isPlaying = true;
    room.preparing = false;
    broadcastPlayback(io, room);
    persist();
    return;
  }

  if (room.current) {
    // Five seconds of slack: a track that runs out doesn't always fire its
    // `ended` handler at exactly its stated duration.
    const left = (room.current.duration || 0) - elapsed(room);
    recordHistory(io, room, { skipped: !fromEnd && left > 5 });
  }

  // Repeat-all: send the track we're leaving to the back of the queue — but
  // only if we actually played it. A track that could not be fetched would
  // otherwise be re-queued to fail again, and with two such tracks the room
  // alternates between them forever.
  if (room.repeat === "all" && room.current && !failed) {
    room.queue.push({ ...room.current, likes: [], votes: [], addedAt: Date.now() });
  }

  const next = pickNext(room);
  if (!next) {
    room.current = null;
    room.isPlaying = false;
    room.preparing = false;
    room.startedAt = 0;
    room.pausedPosition = 0;
    room.playToken++;
    broadcastQueue(io, room);
    broadcastPlayback(io, room);
    persist();
    return;
  }

  // Enter a "preparing" state: the track is current but the shared clock has
  // NOT started, so the progress bar stays put while the audio caches. A token
  // lets a later skip/track supersede this preparation.
  const token = ++room.playToken;
  room.current = next;
  room.isPlaying = false;
  room.preparing = true;
  room.startedAt = 0;
  room.pausedPosition = 0;
  touchCache(next.videoId, { title: next.title, artist: next.artist });
  broadcastQueue(io, room);
  broadcastPlayback(io, room);
  persist();

  // Warm the following track in the background so it's ready when we advance.
  if (room.queue[0]) warm(io, room, room.queue[0].videoId);

  // Fully cache the current track BEFORE starting playback.
  try {
    await ensureAudio(next.videoId, (pct) => {
      if (room.playToken === token) {
        io.to(room.code).emit(EVENTS.DOWNLOAD_PROGRESS, { videoId: next.videoId, percent: pct });
      }
    });
  } catch (err) {
    if (room.playToken === token) {
      room.failStreak = (room.failStreak || 0) + 1;

      if (room.failStreak >= MAX_CONSECUTIVE_FAILURES) {
        // Stop rather than walk the rest of the queue into the same wall. The
        // reason comes from the resolver, which knows whether this was a
        // bot-check, a rate limit or a dead video — the old message threw that
        // away and said "skipping" for all of them.
        room.failStreak = 0;
        room.current = null;
        room.isPlaying = false;
        room.preparing = false;
        room.startedAt = 0;
        room.pausedPosition = 0;
        room.playToken++;
        pushChat(io, room, {
          system: true,
          kind: "error",
          text: `Playback stopped — ${MAX_CONSECUTIVE_FAILURES} tracks in a row wouldn't load. ${
            err?.message || "The server couldn't fetch the audio."
          }`,
        });
        broadcastQueue(io, room);
        broadcastPlayback(io, room);
        persist();
        return;
      }

      pushChat(io, room, {
        system: true,
        kind: "error",
        text: `Couldn't load "${next.title}" — ${err?.message || "skipping."}`,
      });
      playNext(io, room, { failed: true });
    }
    return;
  }

  // A newer skip/vote started another track while we were caching — abandon.
  if (room.playToken !== token) return;

  // Audio is ready. A track only carries a gain once it's been played and
  // measured before — the first-ever spin plays unnormalized rather than
  // delaying the room's clock on a measurement.
  const gain = cachedGain(next.videoId);
  if (gain) next.gain = gain;
  // Consecutive, not cumulative: one bad track in an evening shouldn't count
  // toward a ceiling meant to catch a server that has stopped working.
  room.failStreak = 0;

  // Cadence: the DJ speaks at a boundary every N tracks, counted from the last
  // time it spoke. `every` is a period, not a window — the blurb itself already
  // looks N/2 back and N/2 ahead — and 0 silences the spoken blurbs without
  // turning the DJ off.
  const every = Math.max(0, Number(activeVoice().every) || 0);
  // `sinceBlurb` counts boundaries since the last blurb, so THIS boundary is
  // `sinceBlurb + 1`. Comparing the old count directly made `every: 1` fire every
  // other track — the setting says how many tracks apart blurbs are, not how many
  // must have already played.
  const nth = (room.sinceBlurb ?? every) + 1;
  const due = every > 0 && nth >= every;
  room.sinceBlurb = due ? 0 : nth;
  // A blurb needs a voice to speak with; when there is none, the DJ says the
  // same thing in chat and the room carries on.
  const speaking = djEnabled() && due && voiceEnabled();
  // One line per boundary. A silent feature has no other evidence trail: without
  // this, "did the cadence fire?" is guesswork between a quiet host and a code
  // path that never ran.
  console.log(
    `[dj] boundary ${room.code}: nth=${nth}/${every} due=${due} dj=${djEnabled()} voice=${voiceEnabled()} listeners=${
      room.participants.size
    }`
  );

  // The host talks first, then the song. The room stays in `preparing` — no
  // clock, nothing playing — while the clip runs, and the shared clock starts
  // when it ends, so the blurb sits in the gap between tracks instead of over
  // the intro. The audio is already cached, so the only cost is the wait.
  let spoke = null;
  if (speaking) {
    djTyping(io, room, true);
    spoke = await speakBlurb(io, room, next);
    // A skip (or a newer playNext) while the host was writing wins; this track
    // is already stale and must not start a clock.
    if (room.playToken !== token) return;
    if (spoke?.durationMs) {
      // Lead + clip + a pad, so the song never starts in the clip's last frame.
      await sleep(BLURB_LEAD_MS + Math.min(spoke.durationMs, MAX_BLURB_MS) + 250);
      if (room.playToken !== token) return;
    }
  }

  room.startedAt = monoNow();
  room.isPlaying = true;
  room.preparing = false;
  io.to(room.code).emit(EVENTS.DOWNLOAD_PROGRESS, { videoId: next.videoId, percent: 100 });
  broadcastQueue(io, room);
  broadcastPlayback(io, room);
  persist();

  if (djEnabled()) {
    if (spoke) {
      // The blurb already said it in chat; a second line would be the DJ
      // repeating itself.
      djTyping(io, room, false);
    } else {
      // An LLM takes a second or two, and a room that has just changed track and
      // then sits silent reads as a DJ that has nothing to say. Say it's writing.
      djTyping(io, room, true);
      generateIntro(next, { mood: room.mood })
        .then((intro) => {
          if (intro) pushChat(io, room, { nick: djName(), dj: true, text: intro });
        })
        .finally(() => djTyping(io, room, false));
    }
  } else {
    pushChat(io, room, {
      system: true,
      kind: "nowplaying",
      // Carried so the client can draw the cover instead of repeating the
      // title as prose in the middle of the conversation.
      track: { title: next.title, artist: next.artist, thumbnail: next.thumbnail },
      text: `Now playing: ${next.title} — ${next.artist}`,
    });
  }
}

/**
 * Say something out loud at a track boundary.
 *
 * The writing lands in chat first and unconditionally: a listener who muted the
 * room, or whose browser refused to start the clip, still gets what the host
 * said. Then the clip is rendered into the cache and broadcast with the server
 * time it should start, so everyone hears it together with the music ducked
 * under it.
 *
 * Nothing here may throw into playback. A DJ that cannot speak is a quiet room,
 * not a stopped one.
 */
async function speakBlurb(io, room, track) {
  try {
    const offered = offeredIdeas(room).map((o) => o.id);
    const text = await composeBlurb(room);
    room.djIdeaIdx = (room.djIdeaIdx ?? 0) + 1;
    room.djIdeaRecent = [...(room.djIdeaRecent || []), ...offered].slice(-6);
    if (!text) {
      console.warn("[dj] blurb came back empty — falling back to the chat intro");
      return null;
    }
    pushChat(io, room, { nick: djName(), dj: true, text });
    room.djRecent = [...(room.djRecent || []), text].slice(-3);
    const clip = await synthesize(text);
    // The line is already in chat: the host said it, even if the voice failed.
    // Returning a zero length is what tells the caller "do not also write an
    // intro", while `durationMs = 0` tells it not to hold the clock for audio
    // that is never coming.
    if (!clip) return { durationMs: 0 };
    // `at` is on the same monotonic clock the playback `startedAt` and every
    // `serverNow` use — that is what clients calibrate their offset against.
    io.to(room.code).emit(EVENTS.DJ_SAY, {
      url: clipUrl(clip),
      text,
      nick: djName(),
      at: monoNow() + BLURB_LEAD_MS,
      durationMs: clip.durationMs || 0,
      videoId: track.videoId,
    });
    console.log(
      `[dj] blurb emitted (${io.sockets.adapter.rooms.get(room.code)?.size ?? 0} sockets, ${
        clip.durationMs || 0
      } ms): ${text.slice(0, 60)}`
    );
    return { durationMs: clip.durationMs || 0 };
  } catch (e) {
    console.warn(`[dj] blurb failed: ${e?.message || e}`);
    return null;
  }
}

/** The same video already playing, or already waiting in the queue. */
function alreadyQueued(room, videoId) {
  if (room.current && room.current.videoId === videoId) return room.current;
  return room.queue.find((t) => t.videoId === videoId) || null;
}

/** Add a track to the back of the queue. Shared by people, the DJ and re-adds. */
function enqueue(io, room, track, addedBy) {
  // One copy per video. A second copy of something already playing or waiting
  // buys the room nothing — upvoting the existing entry is the way to say "this
  // sooner" — so return the entry that is already there and let the caller
  // explain that, rather than queuing a duplicate.
  const existing = alreadyQueued(room, track.videoId);
  if (existing) return { ...existing, duplicate: true };

  noteOwner(room, addedBy);
  const item = normalizeItem({ ...track, id: crypto.randomUUID(), addedBy, addedAt: Date.now() });
  room.queue.push(item);
  warm(io, room, item.videoId);
  broadcastQueue(io, room);
  persist();
  return item;
}

/**
 * Add several at once — one broadcast, one save, and only the front of the
 * batch pre-fetched.
 *
 * `enqueue` warms every track it adds, which is right for a single addition
 * and wrong for ten: that is ten concurrent downloads for tracks the room
 * won't reach for half an hour. The rest are fetched on demand when they reach
 * the front, which is the same path a prefetch that didn't finish already
 * takes.
 */
const BULK_WARM = 2;
/** Largest batch one person can add at once. Matches the link importer's cap. */
const MAX_BATCH = 100;
function enqueueMany(io, room, tracks, addedBy) {
  // A batch is allowed to repeat itself — a DJ list can name a track twice, and
  // a pasted playlist can carry it in two sections. The room should still only
  // hold it once, and never a copy of the track that is already playing.
  const seen = new Set();
  if (room.current?.videoId) seen.add(room.current.videoId);
  for (const t of room.queue) if (t?.videoId) seen.add(t.videoId);

  const fresh = [];
  for (const t of tracks) {
    if (!t?.videoId || seen.has(t.videoId)) continue;
    seen.add(t.videoId);
    fresh.push(t);
  }
  noteOwner(room, addedBy);
  const items = fresh.map((t) =>
    normalizeItem({ ...t, id: crypto.randomUUID(), addedBy, addedAt: Date.now() })
  );
  room.queue.push(...items);
  for (const item of items.slice(0, BULK_WARM)) warm(io, room, item.videoId);
  broadcastQueue(io, room);
  persist();
  return items;
}

async function handleDjRequest(io, room, text, requester) {
  // One try/finally around the whole thing. Every early return in here is a
  // normal outcome — the message wasn't a request, the search found nothing —
  // and an indicator that survives any of them stays on forever, which is a
  // worse lie than never showing one.
  djTyping(io, room, true);
  try {
    const queries = await interpretRequest(text, { mood: room.mood });
    if (!queries.length) return;

    // One search per query, in parallel. A query that finds nothing costs its
    // own slot and not the whole request — asking for ten and getting eight is
    // a better answer than asking for ten and getting an apology.
    const settled = await Promise.allSettled(queries.map((q) => searchSongs(q, 1)));
    const already = new Set(
      [room.current?.videoId, ...room.queue.map((t) => t.videoId)].filter(Boolean)
    );
    const found = [];
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const top = r.value[0];
      // Deduplicated against the queue as well as against itself: ten queries
      // for one mood tend to converge on the same few obvious records.
      if (!top || already.has(top.videoId)) continue;
      already.add(top.videoId);
      found.push(top);
    }
    if (!found.length) return;

    enqueueMany(io, room, found, djName());

    const first = found[0];
    const rest = found.length - 1;
    pushChat(io, room, {
      nick: djName(),
      dj: true,
      text:
        rest > 0
          ? `On it, ${requester} — queued ${found.length} tracks, starting with "${first.title}" by ${first.artist}.`
          : `On it, ${requester} — queuing "${first.title}" by ${first.artist}.`,
    });
    pushChat(io, room, {
      system: true,
      kind: "dj",
      actor: djName(),
      track: { title: first.title, artist: first.artist, thumbnail: first.thumbnail },
      text:
        rest > 0
          ? `${djName()} queued ${found.length} tracks`
          : `${djName()} queued ${first.title}`,
    });
    if (!room.current) playNext(io, room);
  } catch {
    /* ignore DJ failures */
  } finally {
    djTyping(io, room, false);
  }
}

/**
 * A socket's address, for kick bans. Mirrors clientIp() in lib/ratelimit.mjs
 * (first entry of a possibly-chained x-forwarded-for), applied to the socket
 * handshake instead of a NextRequest — viable because server.mjs attaches
 * Socket.io to the same raw http.Server Next.js runs on, so the handshake
 * carries the identical proxy headers.
 */
function socketIp(socket) {
  const fwd = socket.handshake.headers["x-forwarded-for"];
  const first = typeof fwd === "string" ? fwd.split(",")[0]?.trim() : null;
  return first || socket.handshake.address || null;
}

const KICK_BAN_MS = 30 * 60 * 1000;

/**
 * Seat someone as a full participant — shared by a normal JOIN and an
 * approved pending request, which is the only reason this isn't just inlined
 * in the JOIN handler. `targetSocket` is deliberately a parameter rather than
 * the closure's own `socket`: an approval runs inside the *host's* handler,
 * acting on a different connection.
 */
function seatParticipant(io, room, targetSocket, name, isHost) {
  if (isHost) room.hostId = targetSocket.id;

  // Someone dropping off wifi and coming back should not read to the room as
  // a departure and an arrival. If a seat is still being held for this name,
  // take it back — counters and join time included.
  let carried = null;
  for (const [id, p] of room.participants) {
    if (p.nick === name && p.status === "reconnecting") {
      carried = p;
      clearTimeout(dropTimers.get(id));
      dropTimers.delete(id);
      room.participants.delete(id);
      break;
    }
  }

  // The queue rotates by nickname, so a person is in the ring from the moment
  // they walk in — even before they have queued anything.
  noteOwner(room, name);

  room.participants.set(targetSocket.id, {
    id: targetSocket.id,
    nick: name,
    isHost,
    status: "listening",
    statusAt: Date.now(),
    joinedAt: carried?.joinedAt ?? Date.now(),
    songsAdded: carried?.songsAdded ?? 0,
    messages: carried?.messages ?? 0,
    reactions: carried?.reactions ?? {},
    muted: carried?.muted ?? false,
  });
  room.session.seen.add(name);

  targetSocket.join(room.code);
  if (!room.mood) room.mood = moodFor(room);
  targetSocket.emit(EVENTS.ROOM_STATE, { ...publicState(room, targetSocket.id), chat: room.chat });
  broadcastParticipants(io, room);
  broadcastStats(io, room);
  if (!carried) {
    pushChat(io, room, { system: true, kind: "joined", actor: name, text: `${name} joined` });
  }
  // Resume a persisted queue on first presence.
  if (!room.current && room.queue.length) playNext(io, room);
}

/* --------------------------------------------------------------- handlers */

export function registerRoomHandlers(io) {
  io.on("connection", (socket) => {
    let joinedCode = null;

    socket.on(EVENTS.JOIN, ({ code, nick, ownerToken }) => {
      const room = rooms.get(code);
      if (!room) {
        socket.emit(EVENTS.ERROR, { message: "Room not found." });
        return;
      }
      const ban = room.bannedIps.get(socketIp(socket));
      if (ban && ban.until > Date.now()) {
        socket.emit(EVENTS.ERROR, { message: "You've been removed from this room." });
        return;
      }
      const name = nick || "guest";
      const isHost = Boolean(ownerToken && ownerToken === room.ownerToken);

      // An invite-only room parks a non-host joiner instead of seating them —
      // they get a live socket (so an approval can reach them) but no
      // participant record until the host says yes.
      if (room.inviteOnly && !isHost) {
        joinedCode = room.code;
        socket.join(room.code);
        room.pending.set(socket.id, { id: socket.id, nick: name, requestedAt: Date.now() });
        socket.emit(EVENTS.JOIN_PENDING, {});
        broadcastPending(io, room);
        return;
      }

      joinedCode = room.code;
      seatParticipant(io, room, socket, name, isHost);
    });

    /** Let a pending joiner in. Mirrors a normal JOIN once seated. */
    socket.on(EVENTS.HOST_APPROVE, ({ id }) => {
      const room = host();
      if (!room) return;
      const req = room.pending.get(id);
      if (!req) return;
      room.pending.delete(id);
      const targetSocket = io.sockets.sockets.get(id);
      // They may have closed the tab while waiting — nothing to seat.
      if (targetSocket) seatParticipant(io, room, targetSocket, req.nick, false);
      broadcastPending(io, room);
    });

    socket.on(EVENTS.HOST_DENY, ({ id }) => {
      const room = host();
      if (!room || !room.pending.delete(id)) return;
      io.sockets.sockets.get(id)?.emit(EVENTS.JOIN_DENIED, {});
      broadcastPending(io, room);
    });

    const inRoom = () => rooms.get(joinedCode);
    const host = () => {
      const room = inRoom();
      return room && room.participants.get(socket.id)?.isHost ? room : null;
    };
    const me = () => inRoom()?.participants.get(socket.id) ?? null;

    /**
     * Any deliberate action means the person is here and not typing, so it
     * clears whatever transient status they were showing. Saves the client
     * from having to send a "never mind" after every interaction.
     */
    const active = (room) => {
      const p = room?.participants.get(socket.id);
      if (!p || p.status === "listening" || p.status === "reconnecting") return;
      p.status = "listening";
      p.statusAt = Date.now();
      broadcastParticipants(io, room);
    };

    socket.on(EVENTS.PRESENCE_SET, ({ status }) => {
      const room = inRoom();
      const p = me();
      if (!room || !p || !STATUSES.includes(status)) return;
      // `reconnecting` is the server's to assign — a client claiming it would
      // be claiming to be absent while plainly connected.
      if (status === "reconnecting" || p.status === status) return;
      p.status = status;
      p.statusAt = Date.now();
      broadcastParticipants(io, room);
    });

    socket.on(EVENTS.QUEUE_ADD, ({ track }) => {
      const room = inRoom();
      const p = me();
      if (!room || !p || !track?.videoId) return;
      const item = enqueue(io, room, track, p.nick);
      if (item.duplicate) {
        pushChat(io, room, {
          system: true,
          kind: "queued",
          text: `${p.nick}: "${item.title}" is already in the queue — upvote it to move it up.`,
        });
        return;
      }
      p.songsAdded += 1;
      active(room);
      broadcastParticipants(io, room);
      broadcastStats(io, room);
      pushChat(io, room, {
        system: true,
        kind: "queued",
        actor: item.addedBy,
        track: { title: item.title, artist: item.artist, thumbnail: item.thumbnail },
        text: `${item.addedBy} queued ${item.title}`,
      });
      if (!room.current) playNext(io, room);
    });

    // A whole album or playlist in one go. One broadcast, one chat line, and
    // only the front of the batch pre-fetched (see enqueueMany).
    socket.on(EVENTS.QUEUE_ADD_MANY, ({ tracks, from } = {}) => {
      const room = inRoom();
      const p = me();
      if (!room || !p || !Array.isArray(tracks)) return;
      const clean = tracks
        .slice(0, MAX_BATCH)
        .filter((t) => typeof t?.videoId === "string" && /^[\w-]{11}$/.test(t.videoId))
        .map((t) => ({
          videoId: t.videoId,
          title: String(t.title || "Unknown").slice(0, 200),
          artist: String(t.artist || "Unknown").slice(0, 200),
          duration: Number.isFinite(t.duration) ? t.duration : 0,
          thumbnail: typeof t.thumbnail === "string" ? t.thumbnail : undefined,
          art: typeof t.art === "string" ? t.art : undefined,
        }));
      if (!clean.length) return;
      const items = enqueueMany(io, room, clean, p.nick);
      p.songsAdded += items.length;
      active(room);
      broadcastParticipants(io, room);
      broadcastStats(io, room);
      const source = typeof from === "string" && from.trim() ? from.trim().slice(0, 80) : "";
      const label = source ? ` from ${source}` : "";
      pushChat(io, room, {
        system: true,
        kind: "queued",
        actor: p.nick,
        count: items.length,
        ...(source ? { from: source } : {}),
        track: { title: items[0].title, artist: items[0].artist, thumbnail: items[0].thumbnail },
        text: `${p.nick} queued ${items.length} track${items.length === 1 ? "" : "s"}${label}`,
      });
      if (!room.current) playNext(io, room);
    });

    socket.on(EVENTS.QUEUE_REMOVE, ({ id }) => {
      const room = inRoom();
      const p = me();
      if (!room || !p) return;
      const item = room.current?.id === id ? null : room.queue.find((t) => t.id === id);
      // Your own track is yours to take back in a round-robin queue; otherwise
      // removing from the room's list stays a host action.
      const own = room.queueMode === "roundrobin" && item && ownerOf(item) === p.nick;
      if (!p.isHost && !own) return;
      room.queue = room.queue.filter((t) => t.id !== id);
      broadcastQueue(io, room);
      persist();
    });

    /** Appreciation. Costs nothing, changes nothing, and people want it. */
    socket.on(EVENTS.QUEUE_LIKE, ({ id }) => {
      const room = inRoom();
      const p = me();
      if (!room || !p) return;
      const item = room.current?.id === id ? room.current : room.queue.find((t) => t.id === id);
      if (!item) return;
      item.likes = item.likes || [];
      const at = item.likes.indexOf(p.nick);
      if (at >= 0) item.likes.splice(at, 1);
      else item.likes.push(p.nick);
      active(room);
      broadcastQueue(io, room);
      broadcastPlayback(io, room);
      persist();
    });

    /**
     * A vote is a nudge up the queue, not just a number. One per person per
     * track, and it moves the track one place forward — so ten people wanting
     * the same song move it ten places, and a single enthusiast can't jump the
     * whole room. The count stays visible either way.
     */
    socket.on(EVENTS.QUEUE_VOTE, ({ id }) => {
      const room = inRoom();
      const p = me();
      if (!room || !p) return;
      const i = room.queue.findIndex((t) => t.id === id);
      if (i < 0) return;
      const item = room.queue[i];
      item.votes = item.votes || [];
      if (item.votes.includes(p.nick)) return;
      item.votes.push(p.nick);
      if (room.queueMode === "roundrobin") {
        // A bump moves the track up among its owner's tracks. It cannot jump
        // someone else's turn — that is the rotation's job, and letting a vote
        // do it would put the queue back to whoever asks loudest.
        const mine = ownerOf(item);
        let j = i - 1;
        while (j >= 0 && ownerOf(room.queue[j]) !== mine) j--;
        if (j >= 0) {
          room.queue.splice(i, 1);
          room.queue.splice(j, 0, item);
        }
      } else if (i > 0) {
        room.queue.splice(i, 1);
        room.queue.splice(i - 1, 0, item);
      }
      active(room);
      broadcastQueue(io, room);
      persist();
    });

    socket.on(EVENTS.QUEUE_REORDER, ({ id, toIndex }) => {
      const room = inRoom();
      const p = me();
      if (!room || !p || typeof toIndex !== "number") return;
      const from = room.queue.findIndex((t) => t.id === id);
      if (from < 0) return;
      const item = room.queue[from];

      let to = Math.max(0, Math.min(room.queue.length - 1, Math.round(toIndex)));
      if (room.queueMode === "roundrobin") {
        // Your own tracks, in your own run. The order *between* people is the
        // rotation, so a drag that crosses someone else's track would be a
        // control that visibly does nothing — it is clamped instead.
        const mine = ownerOf(item);
        if (mine !== p.nick && !p.isHost) return;
        const first = room.queue.findIndex((t) => ownerOf(t) === mine);
        let last = first;
        for (let k = first; k < room.queue.length; k++) if (ownerOf(room.queue[k]) === mine) last = k;
        to = Math.max(first, Math.min(last, to));
      } else if (!p.isHost) {
        return;
      }

      if (from === to) return;
      const [moved] = room.queue.splice(from, 1);
      room.queue.splice(to, 0, moved);
      broadcastQueue(io, room);
      persist();
    });

    /**
     * How the queue picks its next track. Everyone can flip it, like the pause
     * button: this room is cooperative, and the switch is the thing that makes
     * an unfair queue visible rather than a rule nobody can find.
     */
    socket.on(EVENTS.QUEUE_MODE, ({ mode }) => {
      const room = inRoom();
      const p = me();
      if (!room || !p) return;
      const next = mode === "roundrobin" ? "roundrobin" : "fifo";
      if (room.queueMode === next) return;
      room.queueMode = next;
      // A fresh rotation: whoever is next after a switch should not depend on
      // who happened to be served before it.
      room.rrLast = null;
      active(room);
      pushChat(io, room, {
        system: true,
        kind: "queuemode",
        actor: p.nick,
        text:
          next === "roundrobin"
            ? `${p.nick} switched the queue to fair rotation — everyone gets a turn`
            : `${p.nick} switched the queue to first come, first served`,
      });
      broadcastPlayback(io, room);
      persist();
    });

    socket.on(EVENTS.CONTROL_SKIP, () => {
      const room = host();
      if (room) playNext(io, room);
    });

    socket.on(EVENTS.VOTE_SKIP, () => {
      const room = inRoom();
      if (!room || !me() || !room.current) return;
      room.skipVotes.add(socket.id);
      active(room);
      const need = Math.ceil(room.participants.size * SKIP_THRESHOLD);
      if (room.skipVotes.size >= need) {
        pushChat(io, room, { system: true, kind: "skipped", text: `Vote passed — skipping` });
        playNext(io, room);
      } else {
        broadcastPlayback(io, room);
      }
    });

    socket.on(EVENTS.CONTROL_PLAYPAUSE, () => {
      // Hold the queue, do not halt the room. The track playing right now always
      // finishes — anything else lets one person cut the music mid-bar, and it
      // fights the model where a track is consumed from the queue as it starts.
      const room = inRoom();
      const p = me();
      if (!room || !p) return;
      const who = p.nick;

      if (room.holdQueue) {
        room.holdQueue = false;
        room.holdBy = null;
        pushChat(io, room, {
          system: true,
          kind: "resumed",
          actor: who,
          text: `${who} released the queue`,
        });
        // Held at the end of a track means there is nothing playing to resume.
        if (!room.isPlaying && room.current) playNext(io, room);
      } else {
        room.holdQueue = true;
        room.holdBy = who;
        pushChat(io, room, {
          system: true,
          kind: "paused",
          actor: who,
          text: `${who} is holding the queue — this track will finish`,
        });
      }
      broadcastPlayback(io, room);
      persist();
    });

    socket.on(EVENTS.CONTROL_SEEK, ({ position }) => {
      const room = host();
      if (!room || !room.current || room.preparing) return;
      room.startedAt = monoNow() - position * 1000;
      if (!room.isPlaying) room.pausedPosition = position;
      broadcastPlayback(io, room);
    });

    socket.on(EVENTS.TRACK_ENDED, ({ videoId }) => {
      // Any listener may report the end, not just the host: the room used to
      // stall at the end of a track whenever the host's own element never fired
      // `ended` (backgrounded tab, errored media). The videoId check below makes
      // a duplicate or stale report a no-op, so the first one to arrive wins.
      const room = inRoom();
      if (!room || !room.current || room.current.videoId !== videoId) return;
      // One `ended` per track, not one per listener. repeat=one keeps the same
      // videoId after advancing, so the id check alone cannot tell a duplicate
      // report from the next loop.
      if (room.lastAdvanceAt && Date.now() - room.lastAdvanceAt < ADVANCE_DEBOUNCE_MS) return;
      if (room.holdQueue) {
        // Park at the end of the track. The queue is untouched, so whatever is
        // first in line is still first in line when somebody releases the hold.
        room.pausedPosition = room.current.duration || 0;
        room.isPlaying = false;
        broadcastPlayback(io, room);
        return;
      }
      playNext(io, room, { fromEnd: true });
    });

    socket.on(EVENTS.CONTROL_SHUFFLE, () => {
      const room = host();
      if (!room) return;
      room.shuffle = !room.shuffle;
      broadcastPlayback(io, room);
      persist();
    });

    socket.on(EVENTS.CONTROL_REPEAT, () => {
      const room = host();
      if (!room) return;
      const next = { off: "all", all: "one", one: "off" };
      room.repeat = next[room.repeat] ?? "all";
      broadcastPlayback(io, room);
      persist();
    });

    /** Mute or unmute a participant's chat. The room stays visible to them either way. */
    socket.on(EVENTS.HOST_MUTE, ({ id, muted }) => {
      const room = host();
      if (!room) return;
      const target = room.participants.get(id);
      if (!target) return;
      target.muted = Boolean(muted);
      broadcastParticipants(io, room);
    });

    /**
     * Remove someone from the room right now, and keep them out for a while.
     * There's no durable identity beyond a socket connection, so the ban keys
     * off IP rather than participant id — a fresh socket from the same
     * connection would otherwise rejoin instantly and undo the kick.
     */
    socket.on(EVENTS.HOST_KICK, ({ id }) => {
      const room = host();
      if (!room) return;
      const target = room.participants.get(id);
      if (!target || id === socket.id || target.isHost) return;

      const targetSocket = io.sockets.sockets.get(id);
      const ip = targetSocket ? socketIp(targetSocket) : null;
      if (ip) room.bannedIps.set(ip, { until: Date.now() + KICK_BAN_MS, nick: target.nick });

      room.participants.delete(id);
      // Their vote-to-skip has to go with them. The disconnect handler below
      // normally does this, but a kick deliberately short-circuits it — and a
      // vote left behind counts forever against a room that just got smaller,
      // which is how a skip passes with nobody having asked for it.
      room.skipVotes.delete(id);
      clearTimeout(dropTimers.get(id));
      dropTimers.delete(id);
      if (targetSocket) {
        targetSocket.data.kicked = true;
        targetSocket.emit(EVENTS.KICKED, {});
        targetSocket.disconnect(true);
      }
      pushChat(io, room, {
        system: true,
        kind: "kicked",
        actor: target.nick,
        text: `${target.nick} was removed by the host`,
      });
      broadcastParticipants(io, room);
      // The vote tally is carried on the playback payload, so removing a vote
      // has to say so or the room keeps showing the old "1/2".
      broadcastPlayback(io, room);
      broadcastStats(io, room);
    });

    socket.on(EVENTS.CHAT_SEND, ({ text }) => {
      const room = inRoom();
      const p = me();
      // A pending (not-yet-approved) socket has a room but no seat — an
      // invite-only room's whole point is gating this.
      if (!room || !p || !text?.trim() || p.muted) return;
      const nick = p.nick;
      const clean = text.slice(0, 500);
      p.messages += 1;
      room.session.messages += 1;
      active(room);
      pushChat(io, room, { nick, text: clean });
      broadcastStats(io, room);
      refreshMood(io, room);
      // "/dj <request>" (or any message when the DJ is on) can enqueue music.
      if (djEnabled()) {
        const m = clean.match(/^\/dj\s+(.+)/i);
        if (m) handleDjRequest(io, room, m[1], nick);
      }
    });

    // Ephemeral floating emoji — broadcast to everyone, never stored.
    socket.on(EVENTS.REACTION, ({ emoji }) => {
      const room = inRoom();
      const p = me();
      if (!room || !p || typeof emoji !== "string" || emoji.length > 8) return;
      // Who reacted travels with it so the activity feed can attribute it.
      // Deliberately not written to room.chat: reactions are the one thing in
      // here that can arrive several times a second, and the log is replayed
      // to everyone who joins.
      io.to(room.code).emit(EVENTS.REACTION_NEW, { emoji, nick: p.nick, id: crypto.randomUUID() });

      room.session.reactions += 1;
      room.session.recentReactions.push({ ts: Date.now(), emoji });
      if (room.session.recentReactions.length > 400) room.session.recentReactions.shift();
      p.reactions[emoji] = (p.reactions[emoji] || 0) + 1;
      broadcastStats(io, room);
      refreshMood(io, room);
    });

    socket.on(EVENTS.SYNC_PING, ({ t0 }) => {
      socket.emit(EVENTS.SYNC_PONG, { t0, serverNow: monoNow() });
    });

    socket.on("disconnect", () => {
      // A kick already removed the participant and posted its own system
      // message — the reconnect-grace flow below would otherwise still try to
      // hold a seat for someone who was just deliberately removed.
      if (socket.data.kicked) return;
      const room = inRoom();
      if (!room) return;
      // A pending request never became a participant — nothing below applies,
      // just drop the request so it doesn't wait forever for someone gone.
      if (room.pending.delete(socket.id)) {
        broadcastPending(io, room);
        return;
      }
      const p = room.participants.get(socket.id);
      room.skipVotes.delete(socket.id);
      if (room.hostId === socket.id) room.hostId = null;
      if (!p) return;

      // Hold the seat briefly. Phones suspend sockets when the screen locks and
      // a train goes through a tunnel; announcing a departure for either one is
      // noise, and the room can see they're reconnecting in the meantime.
      p.status = "reconnecting";
      p.statusAt = Date.now();
      // Beside the participant, never on it. See publicParticipant.
      dropTimers.set(
        socket.id,
        setTimeout(() => {
          dropTimers.delete(socket.id);
          const still = room.participants.get(socket.id);
          if (!still || still.status !== "reconnecting") return;
          room.participants.delete(socket.id);
          // Nobody left: hold the room where it is instead of leaving the clock
          // running all night. The queue and the current track stay put, so the
          // next person to walk in resumes exactly where the room stopped.
          if (room.participants.size === 0 && !room.holdQueue) {
            // Nobody is listening, so nothing should start behind them. The
            // current track runs out on its own; the hold stops the next one.
            room.holdQueue = true;
            room.holdBy = "nobody left";
            room.skipVotes.clear();
            broadcastPlayback(io, room);
          }
          pushChat(io, room, {
            system: true,
            kind: "left",
            actor: still.nick,
            text: `${still.nick} left`,
          });
          broadcastParticipants(io, room);
          broadcastStats(io, room);
        }, RECONNECT_GRACE_MS)
      );

      // Rooms are durable — do NOT delete when empty; just update presence.
      broadcastParticipants(io, room);
    });
  });
}
