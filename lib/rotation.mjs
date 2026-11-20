// The queue's playing order, computed without playing anything.
//
// Two consumers need the same answer: `playNext` (which track actually starts)
// and the queue panel (what the room is about to hear, in order). They must not
// each implement the rotation — a preview that disagrees with the player is
// worse than no preview, because it teaches people the queue is a lie.
//
// Everything here is pure: give it the queue and the rotation state, get ids
// back. No room mutation.

/** Whose turn a queued track belongs to: the nickname it was added under. */
export function ownerOf(t) {
  return t?.addedBy || "someone";
}

/**
 * The rotation ring: every owner this room has queued for, in first-queue
 * order, with the DJ last.
 *
 * It deliberately keeps owners who currently have nothing queued. Dropping
 * them shortens the ring, so "who comes after the last person" resolves to the
 * head of the list — which hands the next turn straight back to whoever just
 * played, and lets someone else wait two turns for nothing.
 */
export function buildRing(owners, rrOrder, dj) {
  const ring = [];
  for (const o of rrOrder || []) if (!ring.includes(o)) ring.push(o);
  for (const o of owners || []) if (!ring.includes(o)) ring.push(o);
  if (dj && ring.includes(dj)) {
    ring.splice(ring.indexOf(dj), 1);
    ring.push(dj);
  }
  return ring;
}

/**
 * The owner whose turn it is next. `present` are the owners with something
 * queued; anyone else is skipped over rather than removed.
 */
export function nextOwner(ring, last, present) {
  if (!ring.length) return null;
  const at = last ? ring.indexOf(last) : -1;
  const start = at >= 0 ? at + 1 : 0;
  for (let n = 0; n < ring.length; n++) {
    const cand = ring[(start + n) % ring.length];
    // Skipping `last` is what makes it a rotation rather than "the same person
    // twice" — unless they are the only one with anything queued.
    if (cand !== last && present.includes(cand)) return cand;
  }
  return present[0] ?? null;
}

/**
 * The queue in the order it will actually play.
 *
 * Simulates the rotation over a copy of the queue: same ring, same next-owner
 * rule, same "first track of that owner" pick. Returns item ids, so it stays
 * cheap on the wire — the client already has the items.
 *
 * In first-come mode there is no rotation to simulate (the order is the array),
 * and with shuffle on the order genuinely is random, so neither claims one.
 */
export function projectOrder(room, { limit = 120, dj = null } = {}) {
  const queue = room?.queue || [];
  if (!queue.length) return [];
  if (room.queueMode !== "roundrobin" || room.shuffle) return [];

  const order = [];
  const remaining = queue.slice();
  let last = room.rrLast || null;

  while (remaining.length && order.length < limit) {
    const owners = [];
    for (const t of remaining) {
      const o = ownerOf(t);
      if (!owners.includes(o)) owners.push(o);
    }
    const ring = buildRing(owners, room.rrOrder, dj);
    const owner = nextOwner(ring, last, owners);
    if (!owner) break;
    const i = remaining.findIndex((t) => ownerOf(t) === owner);
    if (i < 0) break;
    order.push(remaining[i].id ?? remaining[i].videoId);
    remaining.splice(i, 1);
    last = owner;
  }
  return order;
}
