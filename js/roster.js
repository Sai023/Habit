// roster.js — reading the room: who is in it, who is the same person twice, and how much each id
// (and each habit) has actually put on the log.
//
// This is the logic the Habits sheet — the menu — runs before it draws "Who's in" and the offer to
// merge a split identity. It lived inline in that sheet, untested, though it decides the thing that
// matters most there: whether a person scattered across two or three ids is even OFFERED the merge
// that folds them back into one. That is the exact repair the friend group needed when one person
// ended up on three ids, so it is worth pinning rather than trusting to a render function.
//
// Pure functions of the replayed state (and of plain member rows carrying a `logged` count).

/**
 * How many readings sit on the log for one member.
 *
 * Counts the log keys, which are `habitId|memberId|day` (see logKey in habits.js) — so this is
 * coupled to that format, and a test here is what keeps a silent change to it from turning every
 * "readings logged" count to zero without anything failing.
 */
export function countMemberLogs(state, memberId) {
  let n = 0;
  for (const key of state.logs.keys()) if (key.split("|")[1] === memberId) n += 1;
  return n;
}

/** How many readings have ever been logged against one habit — the count that comes back with it. */
export function countHabitLogs(state, habitId) {
  let n = 0;
  for (const key of state.logs.keys()) if (key.split("|")[0] === habitId) n += 1;
  return n;
}

/**
 * People who share a name across more than one id — the same person, split across a rejoin, a
 * reinstall, or a mistyped code.
 *
 * Grouped case- and whitespace-insensitively, so "Anj" and " anj " are one person. A nameless id
 * falls back to its own memberId as the key, so two blank rows are never mistaken for each other.
 * Only groups of two or more come back — a lone id is not a duplicate of anything.
 */
export function duplicateGroups(members) {
  const byName = new Map();
  for (const m of members || []) {
    const key = ((m.name || m.memberId || "") + "").trim().toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(m);
  }
  return [...byName.values()].filter((g) => g.length > 1);
}

/**
 * Which id a duplicate group folds INTO: the one that has logged the most, so the fewest readings
 * have to move and the kept name and join-day are the active person's.
 *
 * A tie on the count is settled by memberId, so the target is the same on every device — it used to
 * fall to whatever order the array happened to hold.
 */
export function mergeTarget(group) {
  return [...group].sort(
    (a, b) => (b.logged || 0) - (a.logged || 0) || ((a.memberId || "") + "").localeCompare((b.memberId || "") + ""),
  )[0];
}
