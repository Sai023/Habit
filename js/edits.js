// edits.js — what an edit screen shows, and what saving it writes.
//
// ---- Why these two rules live together, away from the screens ----
//
// Both screens that let somebody change their own number — the goals sheet and the habit editor —
// have to answer the same two questions, and they answered them differently. The goals sheet had
// the right answers and a comment explaining why; the editor was written later and got one of them
// wrong in exactly the way that comment warns about.
//
// The bug it caused was reported as "saving changes when editing a habit does not persist", which
// is what it looks like from outside: you change 10 000 to 8 000, save, reopen, and it says 10 000.
// Nothing failed. The editor was showing the number in FORCE, a goal change starts counting
// tomorrow so that a bad week cannot be rescued on Sunday night, and today's number is therefore
// still the old one. The save had worked perfectly and the screen said otherwise.
//
// So the rules are here, once, and both screens read them. Two copies of a rule about which number
// to show is how the second copy ends up being the wrong one.

import { latestGoal, targetFor } from "./habits.js";

/**
 * The number to put in front of somebody editing their own goal.
 *
 * What they last SET, not what is in force today. A change made yesterday is already theirs even
 * though it starts counting tomorrow, and showing the older number invites them to "fix" it a
 * second time — or, worse, to conclude the app did not save it.
 *
 * Falls back to what is actually being scored for anybody who has never set one, because that is
 * the only honest answer before a choice has been made.
 */
export function goalToShow(state, habit, memberId, day) {
  const set = latestGoal(state, habit.habitId, memberId);
  if (set && Number.isFinite(set.target) && set.target > 0) return set.target;
  return targetFor(state, habit, memberId, day || habit.createdDay);
}

/**
 * Which fields a habit save should carry.
 *
 * The whole point is `target`, and that it is present only when the habit is BORN. A habit's own
 * target is the seed that [targetFor] falls back to for anybody who has not set a goal of their
 * own — so writing it on every edit moved the number for every member who had never opened the
 * goals sheet, which is all of them until they do.
 *
 * Everything else is written every time: they are facts about the habit, they belong to the group,
 * and changing one is the reason somebody opened this screen.
 */
export function habitFields({ isNew, name, type, target, taper, days, tz, dayStartHour,
  visibility, category, source }) {
  const fields = {
    name,
    icon: type.icon,
    metric: type.metric,
    aggregate: type.aggregate,
    direction: type.direction,
    period: type.period,
    category,
    visibility,
    taper: taper ? { amount: 1, everyDays: 7, floor: 0 } : null,
    days,
    tz,
    dayStartHour,
    source,
  };
  if (isNew) fields.target = target;
  return fields;
}
