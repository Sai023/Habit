// awards.js — every badge that can be earned, and how many times you have earned it.
//
// ---- Why a count and not a flag ----
//
// A streak is a rank held while the run is alive: lose it and the badge goes with it. That is what
// makes it worth protecting rather than worth collecting, and it is the right thing for the board.
//
// It is the wrong thing for a trophy case. Somebody who reached twenty days, lost it to one bad
// week and clawed back to twenty has done the hard thing twice, and a case that shows a single
// Silver is quietly telling them the first one did not happen. So this counts CROSSINGS across the
// whole history rather than reading today's streak — and a badge earned three times says so.
//
// ---- Why it walks forward ----
//
// onGoalStreak walks backwards from today and stops at the first bad day, which is all it needs.
// A history cannot stop there: it has to see every run. So this replays the log forward once,
// carrying a running streak, and counts each time that streak lands exactly on a threshold.
//
// Bounded by the same four hundred days the rest of the engine walks. Nothing here should ever be
// asked about a run older than that, and an unbounded loop over a corrupt log is how a screen
// hangs on somebody's phone rather than on a test.

import { addDays, daysBetween, walk, HIT, EXEMPT, NO_DATA } from "./habits.js";
import { dayIsOnGoal } from "./summary.js";
import { TIERS, habitSteps, habitSpan } from "./milestones.js";

/** The same horizon habits.js walks. */
const MAX_DAYS = 400;

/**
 * The major badges: every category met, every day.
 *
 * Returns one entry per tier, in order, always all four — the case shows what can be earned as
 * well as what has been, so an unearned tier is a row with a zero rather than a missing row.
 */
export function majorAwards(state, me, today) {
  const counts = new Map(TIERS.map((t) => [t.at, 0]));

  let day = earliestDay(state, today);
  let run = 0;
  while (daysBetween(day, today) >= 0) {
    const won = dayIsOnGoal(state, me, day, today);
    // Nothing asked: neither a win nor a loss, and it must not break the run. A rest day in the
    // middle of a streak is not a failure, and the streak walk agrees.
    if (won === null) { day = addDays(day, 1); continue; }
    run = won ? run + 1 : 0;
    if (counts.has(run)) counts.set(run, counts.get(run) + 1);
    day = addDays(day, 1);
  }

  return TIERS.map((tier) => ({
    ...tier,
    times: counts.get(tier.at) || 0,
  }));
}

/**
 * The minor badges, per habit.
 *
 * Read off `walk`, which has already resolved every period's final status — grace tokens spent,
 * rest days exempted, sensors that went quiet. Re-deriving those here would be a second opinion
 * about what a streak is, and the first time the two disagreed the case would contradict the card
 * it was opened from.
 */
export function habitAwards(state, me, today) {
  const out = [];

  for (const habit of state.habits.values()) {
    const w = walk(state, habit.habitId, me, today);
    if (!w) continue;

    const steps = habitSteps(habit.period);
    const counts = new Map(steps.map((n) => [n, 0]));
    let run = 0;
    for (const status of w.statuses.values()) {
      if (status === HIT || status === EXEMPT) run += 1;
      else if (status === NO_DATA) { /* preserved, earns no progress */ }
      else run = 0;
      if (counts.has(run)) counts.set(run, counts.get(run) + 1);
    }

    out.push({
      habitId: habit.habitId,
      name: habit.name || "Habit",
      icon: habit.icon || "◆",
      period: habit.period,
      streak: w.streak,
      levels: steps.map((at, i) => ({
        at,
        level: i + 1,
        span: habitSpan(at, habit.period),
        times: counts.get(at) || 0,
      })),
    });
  }

  // Most decorated first, then the closest to their next one. A case is meant to be looked at, and
  // the things somebody has actually done should be at the top of it.
  return out.sort((a, b) => {
    const earned = (h) => h.levels.reduce((n, l) => n + l.times, 0);
    return earned(b) - earned(a) || b.streak - a.streak;
  });
}

/** The whole case, in one call, because the sheet wants both halves together. */
export function awards(state, me, today) {
  const major = majorAwards(state, me, today);
  const habits = habitAwards(state, me, today);
  return {
    major,
    habits,
    earned: major.reduce((n, t) => n + t.times, 0)
      + habits.reduce((n, h) => n + h.levels.reduce((m, l) => m + l.times, 0), 0),
  };
}

/** The first day worth asking about: the oldest habit, floored at the walk horizon. */
function earliestDay(state, today) {
  let first = today;
  for (const habit of state.habits.values()) {
    if (habit.createdDay && habit.createdDay < first) first = habit.createdDay;
  }
  const floor = addDays(today, -MAX_DAYS);
  return first < floor ? floor : first;
}
