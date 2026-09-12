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

import { latestGoal, targetFor, goalOn, periodKey, periodStart, periodEnd, addDays } from "./habits.js";

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
 * A goal that has been set and is not yet the one being scored — and the day it will be.
 *
 * ---- Why this exists ----
 *
 * A change counts from the next day, and for a weekly habit from the next WEEK: the target in
 * force for a period is the one that was true when the period opened, so a number lowered on a
 * Wednesday cannot re-score the Monday. That is the anti-cheat rule and it stays. What it cost
 * was this: somebody set "3 a week" on a Saturday, the card said "of 2" until Monday, and the
 * only honest reading of a screen that shows 2 after you typed 3 is that the app did not save it.
 *
 * So the rule is surfaced instead of hidden. Null when the latest goal is already the one being
 * scored, or when the number did not change (toggling a habit off and on sets a goal too).
 */
export function pendingGoal(state, habit, memberId, today) {
  const set = latestGoal(state, habit.habitId, memberId);
  if (!set || !Number.isFinite(set.target) || set.target <= 0) return null;
  const key = periodKey(today, habit.period);
  const start = periodStart(key, habit.period);
  if (set.from <= start) return null;
  const inForce = goalOn(state, habit.habitId, memberId, start);
  const current = inForce && Number.isFinite(inForce.target) && inForce.target > 0
    ? inForce.target
    : targetFor(state, habit, memberId, start, start);
  if (current === set.target) return null;
  // The first period that opens on or after the day the change counts from.
  const fromKey = periodKey(set.from, habit.period);
  const from = periodStart(fromKey, habit.period) === set.from
    ? set.from
    : addDays(periodEnd(fromKey, habit.period), 1);
  return { target: set.target, from };
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
