// dailyfacts.js — the analytical read-model: one clean, correct row per habit-day.
//
// ---- Why this exists ----
//
// Every screen in the app derives its numbers from replay on demand, which is right for a screen.
// It is wrong for analytics. Two things go wrong when you mine the raw log directly:
//
//   • The raw event table LIES. A `sum(value)` over `habit_log` rows ignores `habit_log_clear`
//     withdrawals and counts duplicates, so it can read 400 where the app shows 100. (We learned
//     this the hard way.) Only replay knows the net.
//   • Every question re-walks the log. Asking "does screen time predict steps" with compareDays
//     re-walks replay once per pair; asking it across every pair is O(pairs × days × replay).
//
// So this module projects the replayed state into a flat, immutable-for-the-caller table of
// DAILY FACTS — one row per (habit, member, day), each carrying the net value, the status, the
// target, coarse provenance, and the behavioural dimensions (weekday, iso-week, exempt). It is
// built ONCE from `valueOn`/`rawDayStatus`/`targetOn` — the engine's own truth, so a fact here can
// never disagree with what the app shows — and then every pattern below is a cheap reduction over
// the table rather than another walk of the log.
//
// ---- The rules it keeps ----
//
//   • The engine is the single source of truth. This module computes no value of its own; it asks
//     valueOn/rawDayStatus and records the answer. If replay changes, the facts change with it.
//   • Nothing is claimed below a floor. A "strongest weekday" off two Tuesdays, or a correlation
//     off three days, is the kind of noise somebody reorganises their week around. Every pattern
//     has a minimum and is simply absent below it — a null, never a guess.
//   • EXEMPT days (travel, booked rest) are not misses. They are excluded from met-rates and from
//     correlations, so a holiday cannot read as a collapse in discipline.
//   • Provenance is exact and weighted: each row carries the value's method (typed / sensor /
//     meter, stamped at the write boundary) and a confidence (a measurement over a self-reported
//     number), so analytics can lean on the surer days. Unit stays the metric until a habit's
//     unit can actually change — that is the change-event wave (see docs/DATA-ARCHITECTURE.md).
//
// Only DAY-period habits are projected: weekly and monthly habits have a different natural grain
// and their own (future) period-fact model. Behavioural pattern-finding is a daily question.

import {
  valueOn, methodOn, unitOn, rawDayStatus, targetOn, isTracking, isExcluded, canonicalMember,
  addDays, daysBetween, isoDayOfWeek, isoWeekKey,
  HIT, MISS, NO_DATA, EXEMPT,
} from "./habits.js";
import { PERIOD, AT_MOST } from "./schema.js";

/** How much a value can be leaned on, by how it was captured — for weighting, not for hiding. */
export const CONFIDENCE = { sensor: 1, meter: 0.9, typed: 0.6 };

/** A correlation needs at least this many qualifying days ON EACH SIDE before it says anything. */
export const MIN_PER_SIDE = 5;
/** A weekday needs at least this many samples before it can be called strongest or weakest. */
export const MIN_PER_WEEKDAY = 3;

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Project the state into daily facts for one member.
 *
 * @param state   replayed state
 * @param opts.me         the member
 * @param opts.to         the last day to include (usually today) — required
 * @param opts.from       the first day (default: the day the member joined, else the earliest
 *                        tracked habit's birthday)
 * @param opts.habitIds   restrict to these habit ids (default: every DAY habit the member tracks)
 * @returns Fact[] sorted by (habitId, day). A Fact is:
 *   { day, habitId, habitName, metric, unit, direction, memberId,
 *     value, target, status, met, reported, method, confidence, dow, weekday, isoWeek, exempt }
 */
export function dailyFacts(state, { me, to, from = null, habitIds = null } = {}) {
  if (!state || !me || !to) return [];

  // A member marked out of analysis has no facts to mine (they are still tracked on the board).
  if (isExcluded(state, { memberId: me })) return [];
  const all = [...state.habits.values()].filter((h) =>
    h.period === PERIOD.DAY && isTracking(state, h, me) && !isExcluded(state, { habitId: h.habitId }));
  const habits = habitIds ? all.filter((h) => habitIds.includes(h.habitId)) : all;
  if (!habits.length) return [];

  const member = state.members.get(me);
  // Where to start: the member's join day, or — failing that — the earliest habit birthday, so a
  // person imported without a join date still gets their whole record rather than nothing.
  const earliestBirthday = habits.reduce((min, h) => (!min || (h.createdDay && h.createdDay < min) ? (h.createdDay || min) : min), null);
  const start = from || (member && member.since) || earliestBirthday || to;

  const facts = [];
  for (const habit of habits) {
    for (let day = start; day <= to; day = addDays(day, 1)) {
      // Before the habit existed there is nothing to say — not a miss, not a gap. Skip it, so a
      // habit added last week does not read as a month of silence.
      if (habit.createdDay && day < habit.createdDay) continue;

      const status = rawDayStatus(state, habit, me, day);
      const value = valueOn(state, habit, me, day);
      const reported = value !== null && value !== undefined;
      const method = reported ? methodOn(state, habit, me, day) : null;
      facts.push({
        day,
        habitId: habit.habitId,
        habitName: habit.name || habit.habitId,
        metric: habit.metric,
        unit: unitOn(habit, day),      // the unit in force THAT day, from the dated history
        direction: habit.direction,
        memberId: me,
        value: reported ? value : null,
        target: targetOn(habit, day),
        status,
        met: status === HIT,
        reported,
        // Provenance of the value the app shows: "typed" | "sensor" | "meter" | null, stamped at
        // the write boundary (see ENTRY_METHOD). `confidence` weights a measurement above a
        // self-reported number so analytics can lean on the surer days without hiding the rest.
        method,
        confidence: method ? (CONFIDENCE[method] || 0) : 0,
        dow: isoDayOfWeek(day),
        weekday: WEEKDAYS[isoDayOfWeek(day) - 1],
        isoWeek: isoWeekKey(day),
        exempt: status === EXEMPT,
      });
    }
  }
  return facts;
}

/**
 * The facts for one habit, in day order — restricted to its CURRENT unit.
 *
 * Every per-habit reduction goes through here, and none of them may cross a unit change: averaging
 * eight glasses with two thousand millilitres, or correlating against a rescaled series, is
 * nonsense. When a habit has more than one unit in the window we keep only the latest unit's days,
 * so a pattern is always within one scale. Single-unit habits (the normal case) are unaffected.
 */
function forHabit(facts, habitId) {
  const rows = facts.filter((f) => f.habitId === habitId).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (rows.length < 2) return rows;
  const latestUnit = rows[rows.length - 1].unit;
  return rows.some((f) => f.unit !== latestUnit) ? rows.filter((f) => f.unit === latestUnit) : rows;
}

/**
 * How a habit goes by day of the week.
 *
 * Only HIT/MISS days count — an unreported or exempt day is not evidence either way. Returns a
 * row per weekday with its sample size, met-rate and average value, plus the strongest and weakest
 * weekdays once each clears MIN_PER_WEEKDAY. Below the floor `strongest`/`weakest` are null: a
 * pattern nobody has enough days to trust is not a pattern.
 */
export function byWeekday(facts, habitId) {
  const rows = forHabit(facts, habitId).filter((f) => f.status === HIT || f.status === MISS);
  const perDow = WEEKDAYS.map((name, i) => {
    const dow = i + 1;
    const days = rows.filter((f) => f.dow === dow);
    const withValue = days.filter((f) => f.reported);
    const met = days.filter((f) => f.met).length;
    return {
      dow, weekday: name,
      n: days.length,
      met,
      metRate: days.length ? met / days.length : null,
      avg: withValue.length ? withValue.reduce((s, f) => s + f.value, 0) / withValue.length : null,
    };
  });
  const enough = perDow.filter((d) => d.n >= MIN_PER_WEEKDAY);
  const byRate = [...enough].sort((a, b) => b.metRate - a.metRate);
  return {
    perDow,
    strongest: byRate.length ? byRate[0] : null,
    weakest: byRate.length ? byRate[byRate.length - 1] : null,
  };
}

/**
 * Does holding one habit line up with a better day on another?
 *
 * The behavioural question — "on the days I keep screen time down, do I walk more?" — as a pure
 * reduction over the fact table. For every day the GATE habit was met or missed and the SUBJECT
 * reported a value, split the subject's values into the two piles and compare their averages.
 *
 * `delta` is signed by the SUBJECT's own direction, so positive always means "better on the days
 * the gate held" — a reduce habit going down is an improvement, and reporting it as negative would
 * invert the only sentence a card ever says. `effect` is the absolute gap; `relative` normalises
 * it by the missed-side average so a link in steps (thousands) and one in puffs (tens) can be
 * ranked on the same scale. Null below MIN_PER_SIDE on either side — an honest "not enough yet".
 *
 * This is compareDays generalised: same arithmetic and same signing, but computed off the shared
 * table so every pair can be asked at once (see topCorrelations) instead of re-walking replay.
 */
export function correlate(facts, gateHabitId, subjectHabitId) {
  if (gateHabitId === subjectHabitId) return null;
  const gate = new Map();
  for (const f of forHabit(facts, gateHabitId)) {
    if (f.status === HIT || f.status === MISS) gate.set(f.day, f.met);
  }
  let subjectDirection = null;
  const met = { days: 0, total: 0 };
  const missed = { days: 0, total: 0 };
  for (const f of forHabit(facts, subjectHabitId)) {
    subjectDirection = f.direction;
    if (!gate.has(f.day) || !f.reported) continue;
    const side = gate.get(f.day) ? met : missed;
    side.days += 1;
    side.total += f.value;
  }
  if (met.days < MIN_PER_SIDE || missed.days < MIN_PER_SIDE) return null;

  const metAvg = met.total / met.days;
  const missedAvg = missed.total / missed.days;
  const raw = metAvg - missedAvg;
  const delta = subjectDirection === AT_MOST ? -raw : raw;
  return {
    gateHabitId, subjectHabitId,
    met: { days: met.days, avg: metAvg },
    missed: { days: missed.days, avg: missedAvg },
    delta,                                   // signed: + means better on the days the gate held
    effect: Math.abs(raw),                   // absolute gap in the subject's own units
    relative: missedAvg !== 0 ? Math.abs(raw) / Math.abs(missedAvg) : null, // scale-free, for ranking
  };
}

/**
 * The strongest behavioural links across every pair of daily habits, best first.
 *
 * Runs correlate over all ordered pairs (a gate/subject relationship is directional — "on days
 * you held X, Y was better" is not the same claim as the reverse) and keeps the ones that clear
 * the floor and actually moved, ranked by relative effect so no single big-numbered metric
 * dominates. This is the surface a "what actually moves the needle for me" insight sits on.
 */
export function topCorrelations(facts, { limit = 5 } = {}) {
  const ids = [...new Set(facts.map((f) => f.habitId))];
  const out = [];
  for (const gate of ids) {
    for (const subject of ids) {
      const r = correlate(facts, gate, subject);
      if (r && r.effect > 0 && r.relative !== null) out.push(r);
    }
  }
  out.sort((a, b) => b.relative - a.relative);
  return out.slice(0, limit);
}

/**
 * Raw consistency for a habit: how often it is met, and the runs and gaps.
 *
 * DELIBERATELY not the scored streak. The board's streak forgives with grace tokens (see
 * habits.js streak); this is the unforgiving analytical view — met-rate over reported HIT/MISS
 * days (exempt excluded), the current run of consecutive met days ending at the latest reported
 * day, the longest such run, and the longest gap of consecutive not-met reported days. Two
 * different questions: "am I keeping my streak" (the app) versus "how consistent am I really".
 */
export function consistency(facts, habitId) {
  const rows = forHabit(facts, habitId).filter((f) => f.status === HIT || f.status === MISS);
  const metDays = rows.filter((f) => f.met).length;
  let current = 0, longest = 0, gap = 0, longestGap = 0;
  for (const f of rows) {
    if (f.met) { current += 1; longest = Math.max(longest, current); gap = 0; }
    else { current = 0; gap += 1; longestGap = Math.max(longestGap, gap); }
  }
  return {
    reportedDays: rows.length,
    metDays,
    metRate: rows.length ? metDays / rows.length : null,
    currentStreak: current,
    longestStreak: longest,
    longestGap,
  };
}
