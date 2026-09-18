// today.js — the Today tab, decided as data.
//
// One place says, for each habit a person tracks: which of five layouts it draws as, whether its
// period is still open, and — the rule that matters most — what state to SHOW while it is open, so a
// day still in progress never paints a shortfall as a failure. The dashboard renders these; it makes
// no decisions of its own. Pure, so the classification and the active-day guard are unit-tested.
//
// ---- The two axes ----
//
// Frequency wins first: a weekly habit is a 7-day grid and a monthly one a pace gauge, whatever they
// measure. A DAILY habit then picks a behavioural archetype:
//   accumulation  build UP to a floor            (steps, sleep)       — a charging battery
//   ceiling       stay UNDER a cap               (locked apps)        — remaining headroom
//   event         a tally where zero is perfect  (vape puffs, urges)  — a clean-day state, not a 0-bar
//
// ---- The active-day guard ----
//
// Every card on Today shows the OPEN period, so `running` is true. The display state is derived from
// value-against-target AND the archetype, never from a raw verdict — so an accumulation shortfall at
// noon reads neutral ("in progress"), never red. A ceiling breach and a logged incident DID happen,
// so those may show a warning while the day runs; only a CLOSED, unmet build-up is a miss.

import {
  valueForPeriod, valueOn, targetFor, isTracking, rawPeriodStatus,
  periodKey, periodStart, periodEnd, addDays, daysBetween, isoDayOfWeek,
  groupDayHabit, EXEMPT,
} from "./habits.js";
import { AT_MOST, AGGREGATE, METRIC, PERIOD, isInterventionHabit } from "./schema.js";
import { dayScore, priceHabits, expectedBy } from "./score.js";
import { onGoalStreak } from "./summary.js";

const WEEKDAY = ["M", "T", "W", "T", "F", "S", "S"]; // isoDayOfWeek 1..7 → Mon..Sun
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));
const pctOf = (v, t) => (t > 0 ? clampPct(((v || 0) / t) * 100) : 0);

/**
 * An abstinence tally — a ceiling you count yourself, where zero is the perfect day (puffs, urges).
 *
 * Requires AT_MOST on purpose: a SUM habit that builds UP to a floor (AT_LEAST — glasses of water)
 * is accumulation, not abstinence, and must never get the "0 is perfect" treatment. Puffs stays
 * exactly what isInterventionHabit already made it; this only also catches a same-shaped urge tally.
 */
export function isEvent(habit) {
  if (!habit || habit.direction !== AT_MOST) return false;
  return habit.metric === METRIC.PUFFS || habit.aggregate === AGGREGATE.SUM;
}

/** Which of the five layouts a habit draws as — frequency first, then the daily archetype. */
export function layoutOf(habit) {
  if (!habit) return "accumulation";
  if (habit.period === PERIOD.WEEK) return "week";
  if (habit.period === PERIOD.MONTH) return "month";
  if (isEvent(habit)) return "event";
  if (habit.direction === AT_MOST) return "ceiling";
  return "accumulation";
}

/**
 * The display state and its colour tone, from value-against-target under the active-day guard.
 * `running` true means the period has not closed yet — the guard forbids a build-up shortfall from
 * reading as anything but neutral until it does.
 */
export function faceOf(layout, value, target, running) {
  const v = value || 0;
  if (layout === "event") {
    if (v === 0) return { state: "clean", tone: "good" };          // the perfect day
    return { state: "logged", tone: v > target ? "bad" : "warn" }; // logged, and over the ceiling is worse
  }
  if (layout === "ceiling") {
    if (v > target) return { state: "over", tone: "bad" };         // punched through the cap — a real breach
    return { state: "safe", tone: "good" };                        // headroom left — safe while under
  }
  // accumulation (and the daily fall-through for week/month, which the caller overrides)
  if (target > 0 && v >= target) return { state: "met", tone: "good" };
  return running
    ? { state: "in-progress", tone: "neutral" }                    // still climbing — never a failure yet
    : { state: "missed", tone: "bad" };                            // only a CLOSED, unmet day is a miss
}

function weekModel(state, me, today, habit, start, target, value) {
  const days = [];
  let d = start;
  for (let i = 0; i < 7; i += 1) {
    const dow = isoDayOfWeek(d);
    days.push({ day: d, dow, label: WEEKDAY[dow - 1], done: (valueOn(state, habit, me, d) || 0) > 0, isToday: d === today });
    d = addDays(d, 1);
  }
  const done = value || 0;
  const weekMet = target > 0 && done >= target;
  return {
    days, done, need: target, weekMet,
    // No "N by tonight" once the week is already won — the conflicting-instruction rule.
    paceBy: weekMet ? null : expectedBy(habit, today),
  };
}

function monthModel(today, start, end, value, target) {
  const daysInMonth = daysBetween(start, end) + 1;
  const dayOfMonth = daysBetween(start, today) + 1;
  const pacePct = clampPct((dayOfMonth / daysInMonth) * 100);
  const filledPct = pctOf(value, target);
  return { dayOfMonth, daysInMonth, pacePct, filledPct, onPace: filledPct >= pacePct };
}

function cardModel(state, me, today, habit, price) {
  const key = periodKey(today, habit.period);
  const start = periodStart(key, habit.period);
  const end = periodEnd(key, habit.period);
  const target = targetFor(state, habit, me, end, start);
  const value = valueForPeriod(state, habit, me, key);
  const layout = layoutOf(habit);
  const rawStatus = rawPeriodStatus(state, habit, me, key);
  const running = true; // Today always shows the open period
  const face = rawStatus === EXEMPT ? { state: "exempt", tone: "neutral" } : faceOf(layout, value, target, running);

  const card = {
    habitId: habit.habitId, name: habit.name || "Habit", icon: habit.icon || "◆",
    metric: habit.metric, direction: habit.direction, period: habit.period,
    layout, running, rawStatus, state: face.state, tone: face.tone,
    value, target,
    xp: price ? { worth: price.worth, earned: price.earned, bonus: price.bonus } : null,
  };

  if (layout === "accumulation") {
    card.toGo = Math.max(0, target - (value || 0));
    card.pct = pctOf(value, target);
  } else if (layout === "ceiling") {
    card.headroom = Math.max(0, target - (value || 0)); // the priority number — allowance left
    card.over = (value || 0) > target;
    card.pct = pctOf(value, target);
  } else if (layout === "event") {
    card.incidents = value || 0; // 0 renders as a state, never a zero-height bar
  } else if (layout === "week") {
    Object.assign(card, weekModel(state, me, today, habit, start, target, value));
  } else if (layout === "month") {
    Object.assign(card, monthModel(today, start, end, value, target));
  }
  return card;
}

/** Hours left in the group's day, or null once it has run out. Device-local, as the old header was. */
function hoursLeft(state, now) {
  const h = groupDayHabit(state);
  if (!h) return null;
  const gone = ((new Date(now).getHours() - h.dayStartHour) + 24) % 24;
  const left = 24 - gone;
  return left <= 0 ? null : left;
}

/**
 * The whole Today tab as data: the hero line, the attribute bars (only those that count today), and a
 * classified card per tracked habit. `now` is the wall clock, for the hours-left anchor.
 */
export function todayModel(state, me, today, now = Date.now()) {
  const scored = dayScore(state, me, today, today);
  const prices = priceHabits(scored);
  const pct = Math.round(scored.pct || 0);

  const hero = {
    streak: onGoalStreak(state, me, today),
    dayXp: pct,
    dayBonus: Math.round(scored.bonus || 0),
    awayXp: Math.max(0, 100 - pct), // "35 XP away from a perfect day"
    perfect: pct >= 100,
    hoursLeft: hoursLeft(state, now),
  };

  // Only the categories that actually calculate today — a monthly Savings goal contributes nothing
  // on a mid-month day, so its row is hidden rather than shown empty (the clutter rule).
  const attributes = (scored.categories || [])
    .filter((c) => c.eligible && c.share > 0)
    .map((c) => ({ category: c.category, points: Math.round(c.points), offered: Math.round(c.share), pct: pctOf(c.points, c.share) }));

  const cards = [...state.habits.values()]
    .filter((h) => isTracking(state, h, me))
    .map((h) => cardModel(state, me, today, h, prices.get(h.habitId)));

  return { hero, attributes, cards };
}
