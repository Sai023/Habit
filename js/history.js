// history.js — one habit, read backwards.
//
// ---- Why this is its own module ----
//
// The same reason Streak and QuietGap are, on the shell side: a screen that draws history is
// mostly arithmetic about periods, and arithmetic about periods is where the off-by-ones live. A
// weekly habit's "last eight" are eight ISO weeks, not fifty-six days; a monthly one's are six
// months, not a hundred and eighty days; and the newest entry is the one still running, which is
// the one a summary must not count as finished.
//
// So the shape is here and testable, and habitsheet only draws it.
//
// ---- What it does not do ----
//
// It does not decide how a habit should LOOK. Sleep wants hours and a bedtime, savings wants one
// number a month, vape puffs want a ceiling that moves — those are presentation, they differ per
// metric, and they belong with the thing doing the presenting. This answers the question every one
// of them shares: what happened, in the units the habit is judged in, for each period it has been
// alive.

import {
  periodKey, periodStart, periodEnd, periodsBetween, addDays, daysBetween,
  valueForPeriod, targetFor, rawPeriodStatus, walk, isTracking,
  HIT, MISS, NO_DATA, EXEMPT,
} from "./habits.js";
import { PERIOD } from "./schema.js";

/**
 * How many periods back is worth showing, per cadence.
 *
 * Chosen so each one covers roughly the same stretch of life rather than the same count: a
 * fortnight of days, two months of weeks, half a year of months. A habit's history should feel the
 * same length whichever kind it is.
 */
export const SPAN = {
  [PERIOD.DAY]: 14,
  [PERIOD.WEEK]: 8,
  [PERIOD.MONTH]: 6,
};

/**
 * One habit's recent periods, oldest first.
 *
 * Oldest first because that is the direction a chart reads and the direction a person scans; the
 * caller reverses it if a list suits better.
 *
 * The last entry is the period still running. It carries `open: true` and every summary below
 * excludes it — a week two days in is not a week you failed, and counting it as one is how a
 * screen tells somebody they are doing worse than they are.
 */
export function habitHistory(state, habit, memberId, today, want = null) {
  const period = habit.period || PERIOD.DAY;
  const span = want || SPAN[period] || SPAN[PERIOD.DAY];

  const currentKey = periodKey(today, period);
  // Never before the habit existed — the same birthday habitScore refuses to judge across, so
  // history cannot draw cells for days the engine would not score.
  const from = habit.createdDay;

  // Reach back generously and take the last `span`, rather than trying to step back N periods.
  //
  // Stepping is the version that looks right and is not: a month is not 31 days, so five of them
  // subtracted from the first of March lands in September and returns seven months. Asking
  // periodsBetween for a wide range and slicing the end off is arithmetic the period functions
  // already own, and it cannot drift from how they count.
  const reach = period === PERIOD.DAY ? span : period === PERIOD.WEEK ? span * 7 + 7 : span * 32;
  const wide = addDays(periodStart(currentKey, period), -reach);
  const start = wide > from ? wide : from;
  if (daysBetween(start, today) < 0) return [];

  return periodsBetween(start, today, period).slice(-span).map((key) => {
    const end = periodEnd(key, period);
    const begin = periodStart(key, period);
    return {
      key,
      period,
      from: begin,
      to: end,
      open: key === currentKey,
      value: valueForPeriod(state, habit, memberId, key),
      // The same pair the engine scores with — tapered to the end of the period, read against the
      // goal in force at its start — so a history cell can never disagree with the verdict on it.
      target: targetFor(state, habit, memberId, end, begin),
      status: rawPeriodStatus(state, habit, memberId, key),
    };
  });
}

/**
 * What the window adds up to.
 *
 * Every count here is over CLOSED periods only. The one still running is shown but never scored,
 * because "3 of 14" on a Tuesday morning is a sentence about the future.
 */
export function historySummary(entries) {
  const closed = entries.filter((e) => !e.open);
  const judged = closed.filter((e) => e.status === HIT || e.status === MISS);
  const hits = judged.filter((e) => e.status === HIT).length;

  const withValue = judged.filter((e) => Number.isFinite(e.value));
  const total = withValue.reduce((sum, e) => sum + e.value, 0);

  return {
    judged: judged.length,
    hits,
    missed: judged.length - hits,
    quiet: closed.filter((e) => e.status === NO_DATA).length,
    resting: closed.filter((e) => e.status === EXEMPT).length,
    // Averaged over periods that actually reported, not over the window — a fortnight with four
    // silent days is not a fortnight of low numbers.
    average: withValue.length ? total / withValue.length : null,
    best: withValue.length ? withValue.reduce((b, e) => Math.max(b, e.value), -Infinity) : null,
    // The direction that counts as "good" decides which extreme is worth naming.
    lowest: withValue.length ? withValue.reduce((b, e) => Math.min(b, e.value), Infinity) : null,
  };
}

/**
 * The longest unbroken run this habit has ever had, and the one running now.
 *
 * Read off the same walk the streak comes from, so the two can never disagree — the number on the
 * card and the number on the history screen are one number asked twice.
 */
export function runs(state, habit, memberId, today) {
  const w = walk(state, habit.habitId, memberId, today);
  if (!w) return { current: 0, best: 0 };

  let best = 0;
  let run = 0;
  // Chronological, because a run is a thing that grows forwards. The map is keyed by period and
  // insertion-ordered by the walk, which builds it oldest first.
  for (const status of w.statuses.values()) {
    if (status === MISS) run = 0;
    // EXEMPT holds a run rather than extending it: a rest day is not a day you did the thing.
    else if (status === HIT) { run += 1; best = Math.max(best, run); }
  }
  return { current: w.streak, best: Math.max(best, w.streak) };
}

/** Is this member even doing this habit? A history screen for one they declined is a blank. */
export function tracked(state, habit, memberId) {
  return isTracking(state, habit, memberId);
}
