// score.js — one number out of a hundred, from habits that are not comparable.
//
// The problem this solves is that a step count, three workouts a week, a screen-time ceiling and a
// monthly savings target are four different kinds of thing measured on four different clocks, and
// the previous answer — every habit contributes its own completion ratio, weighted by a number the
// user picked — quietly made the leaderboard a contest in choosing favourable weights.
//
// ---- The shape ----
//
//   habit    → a score in [0, BONUS_CAP], on its own terms
//   category → the mean of its habits' scores, capped
//   day      → the four category weights, RENORMALISED over the categories in play, capped at 1
//
// Three properties hold by construction and are pinned by tests, because each of them is a hole
// somebody would otherwise find:
//
//   • A day is worth exactly 100, whatever mix of categories a person happens to be running. The
//     weights renormalise over what is actually being judged rather than over all four.
//   • Resting, or a sensor going quiet, is NEUTRAL. It removes a category from the day rather than
//     scoring it zero — and, just as importantly, never RAISES anybody's score. The naive version
//     of "shift the weight to their other habits" pays you for taking a rest day and pays you
//     again for a broken watch.
//   • Tracking more never lowers your ceiling. Each category is scored on its own before the
//     weights combine, so adding a second fitness habit splits Core Fitness rather than diluting
//     the whole day.
//
// ---- Why the weights are not settable ----
//
// They were, from 0.5x to 10x, per habit, by whoever created it. In a group of three that is not a
// preference, it is a dial on your own scoreline: put 10x on the easiest thing you do and the rest
// of the board is arguing about the remainder. Categories are the group's priorities and they live
// here, in code, the same for everyone.

import {
  valueForPeriod, targetFor, isTracking, rawPeriodStatus,
  periodKey, periodStart, periodEnd, isoDayOfWeek, daysInPeriod,
  HIT, MISS, NO_DATA, EXEMPT,
} from "./habits.js";
import { METRIC, PERIOD, AT_MOST } from "./schema.js";

export const CATEGORY = {
  FITNESS: "fitness",
  DISCIPLINE: "discipline",
  REST: "rest",
  MONEY: "money",
};

/** The group's priorities, in code because they are the group's and not one member's. */
export const CATEGORY_WEIGHT = {
  [CATEGORY.FITNESS]: 40,
  [CATEGORY.DISCIPLINE]: 30,
  [CATEGORY.REST]: 15,
  [CATEGORY.MONEY]: 15,
};

export const CATEGORY_LABEL = {
  [CATEGORY.FITNESS]: "Core fitness",
  [CATEGORY.DISCIPLINE]: "Discipline",
  [CATEGORY.REST]: "Rest & recovery",
  [CATEGORY.MONEY]: "Money",
};

export const CATEGORY_ICON = {
  [CATEGORY.FITNESS]: "🏋",
  [CATEGORY.DISCIPLINE]: "📵",
  [CATEGORY.REST]: "🛌",
  [CATEGORY.MONEY]: "💰",
};

export const CATEGORY_ORDER = [
  CATEGORY.FITNESS, CATEGORY.DISCIPLINE, CATEGORY.REST, CATEGORY.MONEY,
];

/**
 * How far above target a habit can carry.
 *
 * Overachieving is meant to buy a buffer, not a licence. Fifteen per cent is enough that a strong
 * week of steps can absorb one weak sleep inside Core Fitness, and small enough that no single
 * enormous day can carry a whole category — which is what "capped so a single massive day cannot
 * break the leaderboard" has to mean if it means anything.
 *
 * The cap is applied at the CATEGORY, deliberately, and again at the day. Overachieving on steps
 * can rescue a soft workout inside Core Fitness; it cannot paper over a blown Discipline. If the
 * buffer crossed categories the four weights would be decorative — one runaway metric would be
 * able to buy the whole board.
 */
export const BONUS_CAP = 1.15;

/** Where a habit sits when nobody has said. */
const METRIC_CATEGORY = {
  [METRIC.STEPS]: CATEGORY.FITNESS,
  [METRIC.ACTIVE_CALORIES]: CATEGORY.FITNESS,
  [METRIC.SESSIONS]: CATEGORY.FITNESS,
  [METRIC.SCREEN_MINUTES]: CATEGORY.DISCIPLINE,
  [METRIC.APP_OPENS]: CATEGORY.DISCIPLINE,
  [METRIC.PUFFS]: CATEGORY.DISCIPLINE,
  [METRIC.URGES]: CATEGORY.DISCIPLINE,
  [METRIC.SLEEP]: CATEGORY.REST,
  [METRIC.AMOUNT]: CATEGORY.MONEY,
};

/**
 * Which category a habit counts towards.
 *
 * Anything unrecognised lands in Rest & Recovery, which is where reading and meditation go — the
 * quiet things you do for yourself that are not fitness, not a vice you are cutting down, and not
 * money.
 */
export function categoryFor(habit) {
  if (habit && CATEGORY_WEIGHT[habit.category] !== undefined) return habit.category;
  return METRIC_CATEGORY[habit && habit.metric] || CATEGORY.REST;
}

/** Monday = 1. How far through its period a day is, as a fraction that is never zero. */
function paceFraction(habit, day) {
  if (habit.period === PERIOD.WEEK) return isoDayOfWeek(day) / 7;
  const days = daysInPeriod(periodKey(day, habit.period), habit.period);
  const index = days.indexOf(day);
  return (index < 0 ? days.length : index + 1) / days.length;
}

/**
 * One habit, scored on its own terms.
 *
 * Returns `{ eligible, score, value, target, expected }`. An ineligible habit is not a zero — it is
 * a habit that is not being asked about today, and it leaves the day's arithmetic entirely.
 */
export function habitScore(state, habit, memberId, day) {
  const key = periodKey(day, habit.period);
  const opensOn = periodStart(key, habit.period);
  const out = { habitId: habit.habitId, eligible: false, score: 0, value: null, target: 0, expected: null };

  if (!habit.scored) return out;
  if (!isTracking(state, habit, memberId, opensOn)) return out;

  const status = rawPeriodStatus(state, habit, memberId, key);
  if (status === EXEMPT) return out;

  const target = targetFor(state, habit, memberId, periodEnd(key, habit.period), opensOn);
  const value = valueForPeriod(state, habit, memberId, key);
  out.value = value;
  out.target = target;

  // A sensor that said nothing is not a person who did nothing — except where the absence IS the
  // answer. A weekly or monthly commitment is graded against a pace, and a pace race in which not
  // starting means not being scored is not a race at all, so those are always judged.
  const paced = habit.period !== PERIOD.DAY;
  if (status === NO_DATA && !paced) return out;

  out.eligible = true;
  if (target <= 0) { out.score = 1; return out; }

  // Nothing reported on a daily habit somebody undertook to report is a zero, in BOTH directions.
  //
  // The ceiling case is the one that bites and the tests caught it: no entry means nothing spent
  // means "under the limit" means the maximum bonus — so the best possible score for a vape habit
  // would have been to never open the app. The engine has already decided this is a MISS rather
  // than an outage; the scorer has to honour that instead of re-deriving it from a null.
  //
  // Paced habits are exempt from this because absence is already their subject: a week with no
  // workouts yet is behind pace, and a month before payday is still reachable.
  if (!paced && value === null && status === MISS) { out.score = 0; return out; }

  const got = value === null ? 0 : value;

  if (habit.direction === AT_MOST) {
    // A ceiling. Below is better, and the bottom is where the bonus is.
    //
    //   over the limit   → 0, immediately and without partial credit. The limit is the point.
    //   exactly at it    → 1, a pass
    //   under it         → between 1 and the cap, in proportion to how far under
    //   nothing at all   → the full bonus
    if (got > target) { out.score = 0; return out; }
    out.score = 1 + (BONUS_CAP - 1) * (1 - got / target);
    return out;
  }

  if (!paced) {
    // A daily floor: steps, sleep, a checkbox. Straight proportion, and over-delivery buys buffer.
    out.score = Math.min(BONUS_CAP, got / target);
    return out;
  }

  // Finished the period early? Hold the maximum for the rest of it. Three workouts done by
  // Wednesday is three workouts, and being asked to keep proving it until Sunday would make an
  // early finish worth less than a late one.
  if (got >= target) { out.score = BONUS_CAP; return out; }

  if (habit.period === PERIOD.WEEK) {
    // Linear pace, penalised from Monday. Deliberate: the week is a race you can fall behind in,
    // and being told so on Tuesday is the whole point of running one.
    const expected = target * paceFraction(habit, day);
    out.expected = expected;
    out.score = expected <= 0 ? 1 : Math.min(BONUS_CAP, got / expected);
    return out;
  }

  // Monthly: judged on whether the target is still REACHABLE, not on a straight line.
  //
  // The money category is a payday lump, not a daily drip. Straight-line pace would park it at zero
  // for the three weeks before anybody gets paid — fifteen per cent of the day gone for everyone,
  // every month, for a habit nobody could yet have performed. So there is no penalty while the
  // month can still be saved, and the judgement lands when it can no longer be.
  const days = daysInPeriod(key, habit.period);
  const isLastDay = days[days.length - 1] === day;
  out.expected = target;
  out.score = isLastDay ? Math.min(BONUS_CAP, got / target) : 1;
  return out;
}

/**
 * Every category, scored, for one person on one day.
 *
 * A category with nothing being asked of it is not in the result. That is what makes the day add
 * up to a hundred rather than to "a hundred minus whatever you do not happen to track".
 */
export function categoryScores(state, memberId, day) {
  const buckets = new Map();

  for (const habit of state.habits.values()) {
    const scored = habitScore(state, habit, memberId, day);
    const category = categoryFor(habit);
    if (!buckets.has(category)) buckets.set(category, { category, habits: [], score: 0, eligible: false });
    const bucket = buckets.get(category);
    bucket.habits.push({ habit, ...scored });
    if (scored.eligible) bucket.eligible = true;
  }

  for (const bucket of buckets.values()) {
    const live = bucket.habits.filter((h) => h.eligible);
    // Equal shares inside a category. Nobody sets these either: a dial on how much your own
    // easiest habit counts is the same exploit one level down.
    //
    // No cap needed here, and it is worth saying why rather than leaving a reassuring Math.min
    // that never fires. Every habit is already capped at BONUS_CAP, and the mean of numbers that
    // are each at most the cap is at most the cap. What actually stops the bonus crossing between
    // categories is that each category is scored alone and then weighted — a runaway step count
    // lifts Core Fitness to its ceiling and touches nothing else.
    bucket.score = live.length
      ? live.reduce((sum, h) => sum + h.score, 0) / live.length
      : 0;
  }

  return buckets;
}

/**
 * The day, out of 100.
 *
 * The renormalisation is the load-bearing line. Weights are shared out over the categories being
 * JUDGED, so somebody running two categories is measured out of a hundred exactly like somebody
 * running four — and a rest day moves weight around without ever handing out points for resting,
 * because the categories that remain still have to be earned.
 */
export function dayScore(state, memberId, day) {
  const buckets = categoryScores(state, memberId, day);
  const live = [...buckets.values()].filter((b) => b.eligible);
  const total = live.reduce((sum, b) => sum + CATEGORY_WEIGHT[b.category], 0);

  const categories = CATEGORY_ORDER
    .filter((c) => buckets.has(c))
    .map((c) => {
      const bucket = buckets.get(c);
      const share = bucket.eligible && total > 0 ? (CATEGORY_WEIGHT[c] / total) * 100 : 0;
      return {
        category: c,
        eligible: bucket.eligible,
        score: bucket.score,
        share,
        points: share * bucket.score,
        habits: bucket.habits,
      };
    });

  const raw = categories.reduce((sum, c) => sum + c.points, 0);
  return {
    day,
    // Capped at 100: the buffer is insurance against a shortfall somewhere else, not a way past
    // the ceiling. Uncapped, a day of nothing but overachievement would be worth more than a
    // perfect one, and "out of 100" would stop meaning anything.
    pct: total > 0 ? Math.round(Math.min(100, raw)) : null,
    scored: total > 0,
    categories,
  };
}

/**
 * The same, averaged over a range — which is what a leaderboard is.
 *
 * Days nobody was asked about are skipped rather than counted as zero, so a week away does not
 * read as a week of failure. `days` says how many actually counted, because an average over two
 * days and an average over seven are not the same claim.
 */
export function scoreOver(state, memberId, from, to, addDaysFn) {
  const daily = [];
  for (let d = from; d <= to; d = addDaysFn(d, 1)) {
    const score = dayScore(state, memberId, d);
    if (score.scored) daily.push(score);
  }
  const pct = daily.length
    ? Math.round(daily.reduce((sum, d) => sum + d.pct, 0) / daily.length)
    : null;
  return { pct, days: daily.length, daily };
}

/**
 * The same range, but for one category only — what the board's filter shows.
 *
 * Scored on the category's own terms rather than as a share of the day, because "how am I doing on
 * fitness" is a different question from "how much of my day did fitness earn me".
 */
export function categoryOver(state, memberId, from, to, category, addDaysFn) {
  let sum = 0;
  let days = 0;
  for (let d = from; d <= to; d = addDaysFn(d, 1)) {
    const bucket = categoryScores(state, memberId, d).get(category);
    if (!bucket || !bucket.eligible) continue;
    sum += Math.min(1, bucket.score);
    days += 1;
  }
  return { pct: days ? Math.round((sum / days) * 100) : null, days };
}
