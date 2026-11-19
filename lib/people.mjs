// Who in a room is a person.
//
// A room's participants are not all listeners. The house plays through a
// browser tab someone named "Speakers", and the DJ counting that as a person
// made it say "three of us in here" to two people — the host was counting the
// thing it talks out of.
//
// There is no flag on a join to say "this is a device": the speaker client is
// an ordinary tab with an ordinary nickname, so the name is the only signal
// available. That is a heuristic and it is allowed to be a blunt one — the
// blast radius is a blurb saying "two of us" instead of "three", and the
// alternative is a count that is wrong every single night.
//
// Add names for a deployment with SERVICE_NICKS="Kitchen,Patio" (comma
// separated, matched word-for-word so "Patio" also covers "Patio Speaker").

const APPLIANCES = new Set([
  // audio
  "speaker",
  "speakers",
  "stereo",
  "hifi",
  "hi-fi",
  "receiver",
  "amp",
  "amplifier",
  "soundbar",
  "sub",
  "subwoofer",
  "sonos",
  "homepod",
  "airplay",
  "chromecast",
  "cast",
  // display
  "tv",
  "television",
  "projector",
  "display",
  "monitor",
  // assistants
  "echo",
  "alexa",
  // household appliances — same convention, so a nickname like "Stove" is a
  // device rather than a person
  "stove",
  "oven",
  "fridge",
  "freezer",
  "microwave",
  "dishwasher",
  "washer",
  "dryer",
  "toaster",
  "kettle",
]);

const extra = new Set(
  String(process.env.SERVICE_NICKS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/** Is this nickname a device rather than a listener? */
export function isServiceClient(nick) {
  const words = String(nick || "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
  if (!words.length) return false;
  if (extra.size && (extra.has(words.join(" ")) || words.some((w) => extra.has(w)))) return true;
  return words.some((w) => APPLIANCES.has(w));
}

/**
 * How many people are actually listening. Accepts the live participant Map or
 * an array of participants.
 */
export function humanCount(participants) {
  const list = participants
    ? typeof participants.values === "function" && !Array.isArray(participants)
      ? [...participants.values()]
      : [...participants]
    : [];
  let n = 0;
  for (const p of list) if (!isServiceClient(p?.nick)) n += 1;
  return n;
}
