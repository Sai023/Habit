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
  valueOn, valueForPeriod, targetFor, rawPeriodStatus, walk, isTracking,
  visibilityFor, publicValue,
  HIT, MISS, NO_DATA, EXEMPT,
} from "./habits.js";
import { PERIOD, AT_MOST, VISIBILITY } from "./schema.js";

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

/**
 * This window against the one before it.
 *
 * The single most useful thing a history screen can say, and the easiest to get backwards: for a
 * ceiling, DOWN is the good direction. So this reports the change and whether it is an improvement,
 * and leaves the wording to the caller — "better" and "worse" are the honest words, not "up" and
 * "down", which mean opposite things for steps and for puffs.
 *
 * Null rather than zero when either window has too little in it. Two days against one produces a
 * percentage that is arithmetically true and completely meaningless, and somebody will believe it —
 * the same reason MIN_COMPARE_DAYS exists next door.
 */
export const MIN_TREND_PERIODS = 3;

export function trend(state, habit, memberId, today) {
  const span = SPAN[habit.period || PERIOD.DAY] || SPAN[PERIOD.DAY];
  // Two windows of the same length, asked for in one go so the split cannot drift.
  const all = habitHistory(state, habit, memberId, today, span * 2);
  const closed = all.filter((e) => !e.open && Number.isFinite(e.value));
  if (closed.length < MIN_TREND_PERIODS * 2) return null;

  const half = Math.floor(closed.length / 2);
  const before = closed.slice(0, half);
  const now = closed.slice(half);
  const mean = (xs) => xs.reduce((t, e) => t + e.value, 0) / xs.length;

  const a = mean(before);
  const b = mean(now);
  if (!a) return null;

  const change = (b - a) / a;
  const reduce = habit.direction === AT_MOST;
  return {
    before: a,
    now: b,
    change,
    // Which way is up depends on the habit, and only the habit knows.
    better: reduce ? change < 0 : change > 0,
    // A window that moved less than this is noise wearing a percentage.
    flat: Math.abs(change) < 0.05,
    periods: now.length,
  };
}

/**
 * Everything, not just the window on screen.
 *
 * The chart is a fortnight because a fortnight is what a person can read at a glance. It is a bad
 * answer to "is this working" — two weeks is one bad flu — so this is the same questions asked of
 * the whole life of the habit: how often it has been met, and the best it has ever been.
 *
 * Bounded by the walk's own limit rather than by a date, so it can never turn into a scan of five
 * years of days on a phone.
 */
export function lifetime(state, habit, memberId, today) {
  const period = habit.period || PERIOD.DAY;
  const entries = habitHistory(state, habit, memberId, today, MAX_LOOKBACK[period]);
  const closed = entries.filter((e) => !e.open);
  const judged = closed.filter((e) => e.status === HIT || e.status === MISS);
  const withValue = judged.filter((e) => Number.isFinite(e.value));
  if (!judged.length) return null;

  const reduce = habit.direction === AT_MOST;
  // "Best" is the extreme in the direction the habit is trying to go, which is the low end for a
  // ceiling. Reporting the highest number as a personal best on a vape habit would be grim.
  const best = withValue.length
    ? withValue.reduce((b, e) => {
      if (!b) return e;
      return (reduce ? e.value < b.value : e.value > b.value) ? e : b;
    }, null)
    : null;

  return {
    judged: judged.length,
    hits: judged.filter((e) => e.status === HIT).length,
    best,
    since: closed.length ? closed[0].from : null,
  };
}

/**
 * How long a habit has to have gone unmissed before saying so means anything.
 *
 * A habit added on Monday and unmissed by Wednesday is not a fact about anybody. These are roughly
 * "long enough that it is clearly not luck", in each cadence's own units.
 */
export const UNBROKEN_MIN = {
  [PERIOD.DAY]: 14,
  [PERIOD.WEEK]: 6,
  [PERIOD.MONTH]: 3,
};

/**
 * Habits this member has never once missed, longest first.
 *
 * ---- Why this is shown and not scored ----
 *
 * A category is the mean of its habits, so a habit somebody cannot fail lifts the ones they can.
 * It is worse than it sounds: a ceiling scores its maximum bonus when you are furthest under it,
 * so a limit that costs you nothing pays the largest bonus available and then drags the category
 * up behind it. Measured, on two people failing the same real habit equally: 50% for the one who
 * spent his whole puff allowance, 57% for the one who has never touched a vape.
 *
 * The fix chosen was not to change the arithmetic. This row already does the same thing for the
 * mirror-image problem — "3 not reported" is shown beside a score it deliberately does not affect,
 * because silence was the cheapest way to avoid a bad week and the answer was to make it visible
 * rather than to punish it. Same answer here, same reason: the group can see it, and it is the
 * person's own to explain.
 *
 * ---- Why the wording has to stay neutral ----
 *
 * "Never missed in 47 days" is a boast and an accusation and the app cannot tell which. Somebody
 * who actually quit vaping has exactly the record of somebody who never started, and reading it as
 * a cheat would be the single most insulting thing this app could do to the person it helped most.
 * So it reports the fact and stops. Anybody who knows the group knows which it is.
 *
 * ---- What it deliberately does not show ----
 *
 * Values. "Never missed, averaging 0 of 80" is far more telling and is not ours to publish — what
 * of their numbers the group sees is each person's own choice, and this would route around it. A
 * count of periods is already public: the board has always shown "5/7 days".
 */
export function neverMissed(state, memberId, today) {
  const out = [];
  for (const habit of state.habits.values()) {
    // Their own habits only, and only the ones the group competes on — an unscored habit cannot
    // lift anybody's category, so naming it here would be gossip rather than information.
    if (!habit.scored) continue;
    if (!isTracking(state, habit, memberId)) continue;

    const life = lifetime(state, habit, memberId, today);
    if (!life) continue;
    const min = UNBROKEN_MIN[habit.period || PERIOD.DAY] || UNBROKEN_MIN[PERIOD.DAY];
    if (life.judged < min) continue;
    if (life.hits < life.judged) continue;

    out.push({ habit, periods: life.judged, period: habit.period || PERIOD.DAY });
  }
  return out.sort((a, b) => b.periods - a.periods);
}

/** How far back "everything" reaches, per cadence. Bounded so a long history stays cheap. */
const MAX_LOOKBACK = {
  [PERIOD.DAY]: 120,
  [PERIOD.WEEK]: 52,
  [PERIOD.MONTH]: 24,
};

/**
 * Which days of the week actually go well, and which do not.
 *
 * Daily habits only — "your worst Sunday" is meaningless for a weekly target, which is silent
 * about which days it happens on by design.
 *
 * Returns Monday-first, each with how many times that weekday has been judged and how many it was
 * met. A weekday nobody has enough of is left with `judged` small and the caller decides whether
 * that is enough to say anything, because "you always fail on Tuesdays" off two Tuesdays is the
 * kind of claim somebody changes their week for.
 */
export const MIN_WEEKDAY_SAMPLES = 3;

export function byWeekday(state, habit, memberId, today) {
  if ((habit.period || PERIOD.DAY) !== PERIOD.DAY) return null;

  const entries = habitHistory(state, habit, memberId, today, MAX_LOOKBACK[PERIOD.DAY]);
  const days = Array.from({ length: 7 }, () => ({ judged: 0, hits: 0 }));

  for (const e of entries) {
    if (e.open || (e.status !== HIT && e.status !== MISS)) continue;
    // ISO weekday, Monday first, from the day key rather than a local Date — the same convention
    // the engine schedules on.
    const idx = (new Date(e.from + "T12:00:00Z").getUTCDay() + 6) % 7;
    days[idx].judged += 1;
    if (e.status === HIT) days[idx].hits += 1;
  }
  return days;
}

/**
 * The weekday that stands out, or null when nothing does.
 *
 * Only speaks when there is a real gap: a weekday with enough samples whose hit rate is well below
 * the rest. Every day being roughly equal is the normal case and deserves silence rather than a
 * sentence naming whichever one happened to be lowest.
 */
export function worstWeekday(days) {
  if (!days) return null;
  const enough = days
    .map((d, i) => ({ ...d, index: i, rate: d.judged ? d.hits / d.judged : null }))
    .filter((d) => d.judged >= MIN_WEEKDAY_SAMPLES);
  if (enough.length < 4) return null;

  const worst = enough.reduce((w, d) => (d.rate < w.rate ? d : w));
  const rest = enough.filter((d) => d.index !== worst.index);
  const restRate = rest.reduce((t, d) => t + d.rate, 0) / rest.length;

  // A fifth of a day's worth of difference. Below that it is which day happened to be lowest.
  return restRate - worst.rate >= 0.2 ? { ...worst, restRate } : null;
}

/**
 * How everybody doing this habit is getting on, with each person's own privacy applied.
 *
 * ---- Where this could leak ----
 *
 * A comparison is the one screen where somebody's hidden number can escape. The three settings
 * mean exactly what they say and this is the place they have to hold:
 *
 *   FULL      the group sees the figure
 *   PROGRESS  the group sees how close they got, not the number
 *   PRIVATE   the group sees whether they hit it, and nothing else
 *
 * So the count of hits is shown for everybody — that is what PRIVATE permits, and it is the whole
 * point of a shared board — while the VALUE goes through publicValue, which is the same function
 * the activity feed uses. One rule, and a percentage computed against THEIR target rather than the
 * group's seed, or somebody on an easier goal reads as though they were failing.
 *
 * Your own row is never filtered. Hiding your numbers from yourself is the one reading of "private"
 * that nobody means.
 */
export function groupHistory(state, habit, me, today) {
  const rows = [];

  for (const member of state.members.values()) {
    const id = member.memberId;
    // Somebody who declined this habit is not competing on it, and a row of dashes for them is
    // noise on a screen about one habit.
    if (!isTracking(state, habit, id)) continue;

    const entries = habitHistory(state, habit, id, today);
    const sum = historySummary(entries);
    if (!sum.judged) continue;

    const mine = id === me;
    const seen = mine ? VISIBILITY.FULL : visibilityFor(state, habit, id);
    // Their own target, so a percentage means what it says.
    const target = targetFor(state, habit, id, today);

    rows.push({
      memberId: id,
      name: member.name || id,
      isMe: mine,
      judged: sum.judged,
      hits: sum.hits,
      rate: sum.judged ? sum.hits / sum.judged : 0,
      run: runs(state, habit, id, today).current,
      // null when they have chosen to show only ticks.
      shown: sum.average == null ? null : publicValue(habit, sum.average, seen, target),
    });
  }

  // Best hit rate first, then the longer run, then name — so the order cannot flicker between
  // repaints for two people who are level.
  return rows.sort((a, b) =>
    b.rate - a.rate || b.run - a.run || a.name.localeCompare(b.name));
}

/** Is this member even doing this habit? A history screen for one they declined is a blank. */
export function tracked(state, habit, memberId) {
  return isTracking(state, habit, memberId);
}

/**
 * What ANOTHER habit added up to over the same stretch of days.
 *
 * ---- What this is for ----
 *
 * "Under workouts, could we pull calories burnt per day from Health Connect if that data exists."
 * Two habits answering the same question from opposite ends — how often you trained, and how hard
 * — and the useful thing is seeing them together rather than two cards apart.
 *
 * ---- Why it is a lookup and not a new pipeline ----
 *
 * The obvious build is a side-channel: have the shell read calories whether or not anything asked
 * for them, and park the number somewhere the workouts screen can find it. That is a second store,
 * outside the log, holding data nothing replays — and every rule in this app is derived from the
 * log by replay, which is what keeps three phones agreeing.
 *
 * The cheap version needs none of that. If somebody is tracking calories, the numbers are already
 * in the log, already synced, already scoped to this member. So this asks the log, and asks for
 * nothing that is not there: no calories habit means no line, which is exactly the "if that data
 * exists" the request was careful to include.
 *
 * ---- Days, not periods ----
 *
 * Deliberately summed across a DATE RANGE rather than by period key, because the two habits do not
 * share a cadence. Workouts is weekly and calories is daily, and the whole point is a week of
 * workouts against the calories burned inside it.
 *
 * Null rather than zero when nothing reported, which is the distinction that cost a release
 * elsewhere: a watch that said nothing is not a day of burning nothing, and drawing "0 kcal" over
 * a week the sensor was quiet would be inventing a number.
 */
export function companionTotal(state, companion, memberId, from, to) {
  if (!companion || !from || !to) return null;
  // daysBetween, not a string compare and NOT habits.js's compareDays — which shares the name and
  // is a correlation between two habits, nothing to do with ordering two dates.
  const span = daysBetween(from, to);
  if (!Number.isFinite(span) || span < 0) return null;
  let total = null;
  let d = from;
  for (let i = 0; i <= span; i += 1) {
    const v = valueOn(state, companion, memberId, d);
    if (v != null) total = (total || 0) + v;
    d = addDays(d, 1);
  }
  return total;
}
