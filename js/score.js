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
  valueForPeriod, targetFor, isTracking, rawPeriodStatus, walk, progressFor, periodsBetween,
  periodKey, periodStart, periodEnd, isoDayOfWeek, daysInPeriod, addDays, bonusForfeited,
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
  // The label only. CATEGORY.MONEY stays "money" because that string is written into habit_def
  // rows in the shared log — renaming the KEY would orphan every habit already filed under it.
  [CATEGORY.MONEY]: "Savings",
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

/**
 * Where overachievement can earn bonus POINTS, as opposed to merely buying buffer inside its own
 * category.
 *
 * Rest & recovery is deliberately absent. The others are things you can decide to do more of —
 * walk further, spend less, hold the ceiling — and paying for that is the point. Sleeping fifteen
 * per cent past your target is not an achievement to reward; on most nights it is a lie-in, and on
 * the rest it is a number a watch happened to report. Paying for it would make the easiest way up
 * the board "set a low sleep goal", which is the exploit the fixed category weights exist to close.
 */
export const BONUS_CATEGORIES = new Set([CATEGORY.FITNESS, CATEGORY.DISCIPLINE, CATEGORY.MONEY]);

/** Where a habit sits when nobody has said. */
const METRIC_CATEGORY = {
  [METRIC.STEPS]: CATEGORY.FITNESS,
  [METRIC.ACTIVE_CALORIES]: CATEGORY.FITNESS,
  [METRIC.SESSIONS]: CATEGORY.FITNESS,
  [METRIC.SCREEN_MINUTES]: CATEGORY.DISCIPLINE,
  [METRIC.APP_OPENS]: CATEGORY.DISCIPLINE,
  [METRIC.PUFFS]: CATEGORY.DISCIPLINE,
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

/**
 * How many you are expected to have done by the END of today — as a whole number.
 *
 * Nobody can do 0.43 of a workout. A straight fraction of the target is the right maths and the
 * wrong thing to show somebody: "you are behind by 0.43" is not a sentence anyone can act on,
 * and a pace you cannot picture is a pace you ignore.
 *
 * So it rounds UP to the next whole one. Three a week reads 1, 1, 2, 2, 3, 3, 3 across Monday to
 * Sunday: by tonight you should have done one, by Wednesday night two. That is a number you can
 * answer, and it is also what the card says, because a score computed against one figure and
 * displayed against another is worse than either.
 */
export function expectedBy(habit, day) {
  const target = Math.max(0, habit.target || 0);
  if (target <= 0) return 0;
  const days = habit.period === PERIOD.WEEK
    ? 7
    : daysInPeriod(periodKey(day, habit.period), habit.period).length;
  const index = habit.period === PERIOD.WEEK
    ? isoDayOfWeek(day)
    : daysInPeriod(periodKey(day, habit.period), habit.period).indexOf(day) + 1;
  const through = Math.max(1, index) / days;
  return Math.min(target, Math.ceil(target * through));
}

/**
 * One habit, scored on its own terms.
 *
 * Returns `{ eligible, score, value, target, expected }`. An ineligible habit is not a zero — it is
 * a habit that is not being asked about today, and it leaves the day's arithmetic entirely.
 */
export function habitScore(state, habit, memberId, day, today = null) {
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
  //
  // This makes a watch outage cut two ways, and that asymmetry is deliberate. A silent day of STEPS
  // is excused, because nobody can reconstruct a step count by hand. A silent WEEK of workouts is
  // not, because you can always log a workout yourself — the shape of a session is "I went", which
  // is a thing a person knows and can type in. Excusing it would mean a broken watch quietly
  // exempted somebody from the one habit they could most easily have reported.
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
    // Linear pace in whole units, penalised from Monday. Deliberate: the week is a race you can
    // fall behind in, and being told so on Tuesday is the whole point of running one.
    const expected = expectedBy(habit, day);
    out.expected = expected;
    out.score = expected <= 0 ? 1 : Math.min(BONUS_CAP, got / expected);
    return out;
  }

  // Monthly: judged on whether the target is still REACHABLE, not on a straight line.
  //
  // The money category is a payday lump, not a daily drip. Straight-line pace would park it at zero
  // for the three weeks before anybody gets paid — fifteen per cent of the day gone for everyone,
  // every month, for a habit nobody could yet have performed. So there is no penalty while the
  // month can still be saved.
  //
  // But only while. Once the month is OVER the benefit of the doubt was wrong, and history has to
  // say so: a month you never saved a penny in scored full marks on twenty-seven of its days and
  // zero on the last, so missing the whole target cost a single day. The month is judged on what
  // happened, and colours all of its days, the moment it can no longer be argued with.
  const days = daysInPeriod(key, habit.period);
  const lastDay = days[days.length - 1];
  const settled = day === lastDay || (today !== null && today > lastDay);
  out.expected = target;

  // The month is still running: NOT JUDGED AT ALL, rather than judged on progress so far.
  //
  // Judging progress created a cliff that punished honesty. A month with nothing saved was not
  // eligible and cost nothing, but logging the first 500 of a 2000 target made it eligible at 25%
  // and dropped the day from 100 to 80 — so the cheapest thing to do with an early deposit was to
  // not report it until the total looked respectable. A tracker that pays you to withhold data is
  // worse than one that ignores the category.
  //
  // Nothing is lost by waiting. Once the month closes, [settled] is true for EVERY day in it, so
  // the outcome colours the whole month at once — which is what a monthly goal always meant. And
  // hitting the target early is still paid immediately, by the early-finish branch above.
  if (!settled) { out.eligible = false; return out; }

  out.score = Math.min(BONUS_CAP, got / target);
  return out;
}

/**
 * Every category, scored, for one person on one day.
 *
 * A category with nothing being asked of it is not in the result. That is what makes the day add
 * up to a hundred rather than to "a hundred minus whatever you do not happen to track".
 */
export function categoryScores(state, memberId, day, today = null) {
  const buckets = new Map();

  for (const habit of state.habits.values()) {
    const scored = habitScore(state, habit, memberId, day, today);
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
export function dayScore(state, memberId, day, today = null) {
  const buckets = categoryScores(state, memberId, day, today);
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
        // Capped at its share: the buffer works INSIDE a category, lifting a weak habit with a
        // strong sibling, and cannot spill out of one. Uncapped, a runaway step count would quietly
        // pay for a blown screen-time day and the four weights would be decorative — which is the
        // thing the categories exist to prevent.
        points: share * Math.min(1, bucket.score),
        // What the cap on the line above threw away, kept as a SEPARATE currency.
        //
        // The day still tops out at a hundred and always will — that invariant is what makes the
        // percentage mean anything. But the effort above the line is real, and discarding it left
        // somebody who had been perfect for a fortnight with no way to gain ground on somebody
        // ahead of them. So it is banked here instead of inflating the percentage: a second,
        // smaller number that answers "how much more than asked did you do".
        bonus: bucket.eligible && BONUS_CATEGORIES.has(c)
          ? share * (Math.min(BONUS_CAP, bucket.score) - Math.min(1, bucket.score))
          : 0,
        habits: bucket.habits,
      };
    });

  const raw = categories.reduce((sum, c) => sum + c.points, 0);
  const rawBonus = categories.reduce((sum, c) => sum + c.bonus, 0);

  // A week whose taper is being held earns no bonus AT ALL, on any habit.
  //
  // This is the price of the hold, and it is what stops holding from being a reward. Missing three
  // days of the vape pauses the ceiling coming down, which is easier than not missing them — so
  // without a cost the strongest play would be to miss three days a week for ever and keep the
  // opening allowance. The forfeit reaches across every category deliberately: a penalty confined
  // to the habit you were already failing is no penalty at all.
  const forfeited = total > 0 && bonusForfeited(state, memberId, day);
  const earnedBonus = total > 0 ? Math.round(rawBonus) : 0;

  return {
    day,
    // Capped at 100: the buffer is insurance against a shortfall somewhere else, not a way past
    // the ceiling. Uncapped, a day of nothing but overachievement would be worth more than a
    // perfect one, and "out of 100" would stop meaning anything.
    pct: total > 0 ? Math.round(Math.min(100, raw)) : null,
    // Never more than fifteen, and not by a clamp: the shares of the categories in play sum to a
    // hundred, each can exceed its ceiling by at most fifteen per cent, so the most this can reach
    // is fifteen — and less than that for anybody whose day is partly Rest, which earns none.
    bonus: forfeited ? 0 : earnedBonus,
    // Kept rather than discarded, so the forfeit can be EXPLAINED. A penalty nobody can see is
    // indistinguishable from a bug, and "you would have earned 12 this week" is the sentence that
    // turns it back into a reason to log tomorrow.
    bonusForfeited: forfeited,
    bonusWithheld: forfeited ? earnedBonus : 0,
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
export function scoreOver(state, memberId, from, to, addDaysFn, today = null) {
  const daily = [];
  for (let d = from; d <= to; d = addDaysFn(d, 1)) {
    const score = dayScore(state, memberId, d, today || to);
    if (score.scored) daily.push(score);
  }
  const pct = daily.length
    ? Math.round(daily.reduce((sum, d) => sum + d.pct, 0) / daily.length)
    : null;
  // AVERAGED, exactly like the percentage beside it, and that is the whole reason this is not a
  // sum. A week's pct is a mean of daily hundreds; a summed bonus would run to a hundred and five
  // over seven days and be worth more than the entire base score it was meant to garnish. Averaged,
  // a week reads as pct + bonus out of 115 — fifteen per cent more available for beating targets,
  // which is what the cap was always supposed to mean.
  const bonus = daily.length
    ? Math.round(daily.reduce((sum, d) => sum + d.bonus, 0) / daily.length)
    : 0;
  // What a hold cost over this range, on the same averaged scale as the bonus itself.
  const withheld = daily.length
    ? Math.round(daily.reduce((sum, d) => sum + d.bonusWithheld, 0) / daily.length)
    : 0;
  return { pct, bonus, withheld, days: daily.length, daily };
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
    const bucket = categoryScores(state, memberId, d, to).get(category);
    if (!bucket || !bucket.eligible) continue;
    sum += Math.min(1, bucket.score);
    days += 1;
  }
  return { pct: days ? Math.round((sum / days) * 100) : null, days };
}

// ============================================================================
// Leaderboard
// ============================================================================

/**
 * Completion across every SCORED habit, for the window [from, to].
 *
 * ---- Where the number comes from ----
 *
 * Not from here. Ranking is the category engine's job — every day is worth exactly a hundred,
 * shared across Core Fitness, Discipline, Rest and Money, renormalised over whichever of those a
 * person is actually running that day. This function assembles the bookkeeping around it: days
 * hit, grace tokens spent, best streak, and how many days a sensor said nothing.
 *
 * It used to do the scoring too, by reducing each habit to its own completion ratio and combining
 * those with a per-habit weight the user could set from 0.5x to 10x. The first half of that was
 * right and survives inside the categories; the second half was a dial on your own scoreline in a
 * group of three, and is gone.
 *
 * Two further rules keep the crown and the clown fair rather than an accident of hardware:
 *
 *   - EXEMPT and NO_DATA periods leave the denominator entirely. You are measured on the periods
 *     you were actually asked to show up for, and where we could tell whether you did.
 *   - The period still RUNNING contributes partial progress rather than a verdict. Without it a
 *     monthly goal would contribute nothing to this week's board until the month closed, which is
 *     both useless and discouraging.
 */
export function leaderboard(state, memberIds, from, to, today = to, addDaysFn = null) {
  const scored = [...state.habits.values()].filter((h) => h.scored);

  const rows = memberIds.map((memberId) => {
    let hits = 0, eligible = 0, noData = 0, spentTokens = 0, bestStreak = 0;
    const perHabit = [];

    for (const habit of scored) {
      const w = walk(state, habit.habitId, memberId, today, to);
      if (!w) continue;
      bestStreak = Math.max(bestStreak, w.streak);

      const keys = periodsBetween(from, to, habit.period);
      spentTokens += w.spent.filter((k) => keys.includes(k)).length;

      let scoreSum = 0, judged = 0;
      for (const key of keys) {
        const status = w.statuses.get(key);
        if (status === undefined || status === EXEMPT) continue; // before it existed, or excused
        if (status === NO_DATA) { noData += 1; continue; }

        if (key === w.currentKey) {
          scoreSum += progressFor(state, habit, memberId, key);
        } else {
          scoreSum += status === HIT ? 1 : 0;
          if (status === HIT) hits += 1;
          eligible += 1;
        }
        judged += 1;
      }

      if (judged > 0) {
        // Kept for the per-habit breakdown the board shows when you tap a row. It is NOT what
        // ranks anybody any more — see below.
        perHabit.push({ habitId: habit.habitId, name: habit.name, ratio: scoreSum / judged });
      }
    }

    const member = state.members.get(memberId);
    // The score itself comes from the category engine, which is the only thing that decides what a
    // day is worth. Everything above this line is the per-habit BOOKKEEPING the board displays —
    // days hit, tokens spent, streaks, and which sensors went quiet.
    const earned = scoreOver(state, memberId, from, to, addDaysFn || addDays, today);
    return {
      memberId,
      name: (member && member.name) || memberId,
      hits, eligible, noData, spentTokens, perHabit,
      streak: bestStreak,
      pct: earned.pct,
      bonus: earned.bonus,
      bonusWithheld: earned.withheld,
      scoredDays: earned.days,
    };
  });

  // Rank by completion. Someone with no measurable days ranks last but is never crowned or clowned.
  //
  // Ties break on days actually completed, then on streak. Percentage alone would hand the crown
  // to whoever had the fewest days measured — a week where three of five days were rest days or
  // travel is 100%, and it should not beat a perfect seven out of seven. Name is only ever the
  // last resort, so that ordering stays deterministic across devices.
  const ranked = rows.slice().sort((a, b) => {
    if (a.pct === null && b.pct === null) return a.name.localeCompare(b.name);
    if (a.pct === null) return 1;
    if (b.pct === null) return -1;
    if (a.pct !== b.pct) return b.pct - a.pct;
    if (a.hits !== b.hits) return b.hits - a.hits;
    if (a.streak !== b.streak) return b.streak - a.streak;
    return a.name.localeCompare(b.name);
  });
  ranked.forEach((r, i) => { r.rank = i + 1; });

  const measurable = ranked.filter((r) => r.pct !== null);
  const crown = measurable.length > 0 ? measurable[0] : null;

  // Nobody is the clown for coming bottom of a field of one. And when the bottom row had a silent
  // pipeline, the week produces NO clown at all — the tag is NOT promoted to the person above
  // them, who by definition did better. Suppressing upward would punish a good week to keep a
  // joke alive, which is precisely the unfairness this rule exists to remove.
  let clown = null, clownSuppressedFor = null;
  if (measurable.length > 1) {
    const last = measurable[measurable.length - 1];
    if (last.noData > 0) clownSuppressedFor = last.memberId;
    else if (!crown || last.memberId !== crown.memberId) clown = last;
  }

  for (const r of ranked) {
    r.crown = !!crown && r.memberId === crown.memberId;
    r.clown = !!clown && r.memberId === clown.memberId;
    // Why this row is NOT wearing the tag, so the UI can say so and offer the fix.
    r.clownSuppressed = r.memberId === clownSuppressedFor;
  }

  return ranked;
}
