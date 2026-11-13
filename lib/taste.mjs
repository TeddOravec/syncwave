// Listening history → a small, explainable taste profile for the DJ.
//
// The suggestion panel used to be a function of two things: the persona's genre
// string and whatever track happened to be playing. Same persona, same prompt,
// same answer — which is why "the DJ suggests" read as a style label wearing a
// track title, and why the same five names came back every time.
//
// A room's own history is the one signal that is specific to *this* room and
// changes as the night goes on, so it is what the picker reads now: what this
// room finishes, what it skips, and what it just heard. Everything here is
// derived on read from `room.history` (which is persisted), so there is no new
// store to keep in step and nothing to go stale.
//
// Kept rule-based and readable rather than clever, for the same reason MOODS
// is: a recommendation nobody can explain is worse than an obvious one.

/** How many recent tracks are withheld from suggestions. */
const AVOID_RECENT = 25;
/**
 * How many recent tracks the *taste score* is computed over.
 *
 * All 120 plays make the profile an all-day average: an artist someone played
 * twenty times this morning still owns the top slot at 6pm, and every
 * suggestion is drawn from that slot. Scoring the recent stretch instead lets
 * the room move, while `heard` below keeps the whole history for novelty —
 * "has this room ever played them" is a different question from "what does it
 * want now".
 */
const SCORE_WINDOW = 60;
/** Artists played this recently are in rotation and must not be suggested back. */
const ROTATION_WINDOW = 10;

/**
 * Upload channels, not artists.
 *
 * YouTube Music files a lot of this under "Various Artists", and one of those
 * with twenty-two finished plays outranks every real name in the room — which
 * then gets fed to the model as the room's favourite, and searched as a seed.
 * A compilation bucket is never a useful suggestion.
 */
const NOT_AN_ARTIST = new Set(["various artists", "unknown", "unknown artist", "va"]);

function realArtist(name) {
  return !NOT_AN_ARTIST.has(String(name).trim().toLowerCase());
}

/**
 * What one play is worth.
 *
 * A finish is the only unambiguous "yes" this system ever gets — nobody
 * presses like. A skip in the first half is the only clean "no". Everything
 * between is a shrug, and is counted as such.
 */
function verdictOf(h) {
  const dur = Number(h.duration) || 0;
  const played = Number(h.playedSec) || 0;
  const ratio = dur > 0 ? Math.min(1, played / dur) : 0;
  if (h.skipped && ratio < 0.5) return { score: -1, verdict: "skipped" };
  if (!h.skipped && ratio >= 0.8) return { score: 2, verdict: "finished" };
  if (ratio >= 0.25) return { score: 1, verdict: "partial" };
  return { score: -1, verdict: "skipped" };
}

/** "Artist - Title", the shape the DJ prompt and the avoid list already speak. */
export function titleOf(h) {
  return `${h.artist} - ${h.title}`;
}

/**
 * Build the profile.
 *
 * @param {Array<object>} history  room.history, oldest first
 */
export function tasteFromHistory(history) {
  const plays = Array.isArray(history)
    ? history.filter((h) => h && h.artist && h.title)
    : [];

  const artists = new Map();
  for (const h of plays.slice(-SCORE_WINDOW)) {
    const { score, verdict } = verdictOf(h);
    const key = String(h.artist).trim();
    const a = artists.get(key) ?? {
      artist: key,
      score: 0,
      plays: 0,
      finished: 0,
      skipped: 0,
    };
    a.score += score;
    a.plays += 1;
    if (verdict === "finished") a.finished += 1;
    if (verdict === "skipped") a.skipped += 1;
    artists.set(key, a);
  }

  const ranked = [...artists.values()].sort(
    (x, y) => y.score - x.score || y.plays - x.plays
  );

  // Artists this room actually finishes, best first. `score > 0` rather than
  // `finished > 0` so one finish does not outvote two skips.
  const liked = ranked
    .filter((a) => a.score > 0 && realArtist(a.artist))
    .slice(0, 8)
    .map((a) => a.artist);
  // Artists it bails on. Only a real negative is worth telling the model about;
  // a single shrug is noise.
  const skipped = ranked
    .filter((a) => a.score < 0 && a.skipped > 0 && realArtist(a.artist))
    .slice(0, 6)
    .map((a) => a.artist);

  const recent = plays.slice(-AVOID_RECENT).map(titleOf);

  // Who just played, and who has ever played. The first is the anti-treadmill
  // rule (do not hand back the artist that is on right now); the second is what
  // "an artist this room has never heard" means when we go looking for
  // neighbours in the catalogue.
  const recentArtists = [...new Set(plays.slice(-ROTATION_WINDOW).map((h) => String(h.artist).trim()))];
  const heardArtists = [...new Set(plays.map((h) => String(h.artist).trim()))];
  const heardIds = plays.slice(-AVOID_RECENT).map((h) => h.videoId).filter(Boolean);
  const finishedTitles = plays
    .filter((h) => verdictOf(h).verdict === "finished")
    .slice(-10)
    .reverse()
    .map(titleOf);

  const lines = [];
  if (plays.length) {
    lines.push(
      `This room has actually played ${plays.length} track${plays.length === 1 ? "" : "s"}.`
    );
  }
  if (liked.length) {
    lines.push(
      `Artists it plays through to the end, most first: ${liked.join(", ")}.`
    );
  }
  if (skipped.length) {
    lines.push(`Artists it skips early: ${skipped.join(", ")}.`);
  }
  if (recent.length) {
    lines.push(`Already played (never suggest these): ${recent.slice(-12).join("; ")}.`);
  }

  return {
    plays: plays.length,
    artists: ranked,
    liked,
    skipped,
    recent,
    recentArtists,
    heardArtists,
    heardIds,
    finished: finishedTitles,
    /** Prompt-ready context; empty when the room has no history yet. */
    lines,
    /** Whether there is enough history to steer anything at all. */
    usable: plays.length >= 3 && liked.length > 0,
  };
}

/** Titles a suggestion must not repeat — everything the room just heard. */
export function recentlyPlayed(history) {
  const plays = Array.isArray(history) ? history.filter((h) => h?.artist && h?.title) : [];
  return plays.slice(-AVOID_RECENT).map(titleOf);
}
