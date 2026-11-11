// cardorder.js — the order somebody wants their habit cards in.
//
// Pure, like today.js: the screen decides nothing about order, it asks these. A saved order is a
// list of habit ids and nothing else, because that is all that survives the things that happen to a
// group's habits — one is added, one is retired, one is opted out of — without a migration.
//
// ---- What a saved order is allowed to be wrong about ----
//
// Everything. It may name a habit that no longer exists (dropped), omit one that is new (placed
// after the ones the person has arranged, in the order the group created them), or be garbage
// altogether (ignored). The person never has to repair it, and a bad one costs them nothing but
// the default order.

/**
 * The habits in the person's order.
 *
 * Habits named in [saved] come first, in that order; anything else follows in its original order,
 * so a habit somebody has not arranged yet lands at the end rather than jumping the queue.
 */
export function orderHabits(habits, saved) {
  if (!Array.isArray(saved) || !saved.length) return habits.slice();
  const byId = new Map(habits.map((h) => [h.habitId, h]));
  const out = [];
  const seen = new Set();
  for (const id of saved) {
    if (typeof id !== "string" || seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id));
  }
  for (const h of habits) if (!seen.has(h.habitId)) out.push(h);
  return out;
}

/** The ids of [habits], as the list to store. */
export const idsOf = (habits) => habits.map((h) => h.habitId);

/**
 * [ids] with [id] taken out and put at position [to] (counted in the list as it ends up).
 * An unknown id, or a position past either end, is clamped or ignored rather than throwing —
 * this runs off a finger, and a finger is not precise.
 */
export function moveTo(ids, id, to) {
  const from = ids.indexOf(id);
  if (from < 0) return ids.slice();
  const out = ids.slice();
  out.splice(from, 1);
  const at = Math.max(0, Math.min(out.length, Number.isFinite(to) ? to : from));
  out.splice(at, 0, id);
  return out;
}

/** One step earlier (delta -1) or later (+1) — the control for people who would rather not drag. */
export function shift(ids, id, delta) {
  const from = ids.indexOf(id);
  if (from < 0) return ids.slice();
  return moveTo(ids, id, from + delta);
}

/**
 * Which slot a dragged card is over.
 *
 * [rects] are every card's box in page coordinates, in current order; (x, y) is the pointer, in the
 * same coordinates. Returns the index of the card under the pointer, or [fallback] — the card's
 * own slot — when the pointer is in a gap or off the grid, so letting go there changes nothing.
 */
export function dropIndex(rects, x, y, fallback) {
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
  }
  return fallback;
}

/** A stored value, made safe: an array of strings or nothing. */
export function cleanSaved(raw) {
  return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
}
