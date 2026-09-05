// milestones.js — the four streaks worth a badge, and what each one is called.
//
// ---- Which streak this counts ----
//
// The whole-app on-goal streak: every category you were asked about, met, every day. Not the best
// single habit — that one is cheap. Somebody running steps, sleep and the vape can hold a
// forty-day step streak while the vape goes over twice a week, and a badge earned that way is one
// nobody in the group would respect for long. "Every habit, on goal, fifty days" is rare, and rare
// is the entire mechanism.
//
// ---- Why four, and why these ----
//
// A badge at every round number is wallpaper by the third one. Seven is the first real week, and
// the one most people never get to. Twenty is where it stops being novelty. Fifty and a hundred
// are the ones you would actually mention to somebody.
//
// The tiers are metals rather than invented rank names because a metal needs no explaining — a
// person who has never opened this app knows gold beats silver — and because they read at the size
// a badge on a leaderboard row actually gets, which is about sixteen pixels. The top tier is the
// app's own teal rather than a fifth metal: it is the colour everything good in here is already
// drawn in, and arriving at it is the point.

/** Ordered ascending. `key` is the CSS class; `at` is the streak that earns it. */
export const TIERS = [
  {
    at: 7, key: "bronze", name: "Bronze", earned: "A full week",
    // Written to escalate. The first one reassures, because a week in is where most runs end; the
    // last one states the size of the thing and gets out of the way, because a hundred days needs
    // no help from an adjective.
    line: "Seven days with every habit on goal. That is the hard part done.",
  },
  {
    at: 20, key: "silver", name: "Silver", earned: "Twenty days",
    line: "Twenty days. Three weeks where nothing slipped — that is not luck any more.",
  },
  {
    at: 50, key: "gold", name: "Gold", earned: "Fifty days",
    line: "Fifty days with every habit on goal. Fifty. Whatever you are doing, keep doing it.",
  },
  {
    at: 100, key: "diamond", name: "Diamond", earned: "One hundred days",
    line: "One hundred days. Every habit, every day, for over three months.",
  },
];

/** The streak lengths worth interrupting somebody for. Derived, so there is one list. */
export const MILESTONES = TIERS.map((t) => t.at);

/**
 * The tier a streak currently holds, or null below the first one.
 *
 * The HIGHEST reached, not the nearest: a streak of 60 is Gold until it reaches 100, rather than
 * dropping back to something between. It is a rank held while the run is alive — lose the streak
 * and the badge goes with it, which is what makes it worth protecting rather than worth collecting.
 */
export function tierFor(streak) {
  let held = null;
  for (const tier of TIERS) {
    if ((streak || 0) >= tier.at) held = tier;
  }
  return held;
}

/**
 * The next one up and how far away it is, or null once the last is held.
 *
 * "18 days" is a fact. "Two days to Silver" is a reason to log tonight, and it is the same fact.
 */
export function nextTier(streak) {
  const n = streak || 0;
  const next = TIERS.find((t) => n < t.at);
  return next ? { tier: next, away: next.at - n } : null;
}

// ============================================================================
// Minor — one habit, held on its own
// ============================================================================

/**
 * The per-habit streaks worth a quiet word, by the period that habit is judged in.
 *
 * ---- Why these are not the same four numbers ----
 *
 * A single habit is far easier than all of them. Seven days of steps is a good week; seven days of
 * EVERY category is the thing the major badges exist for. Reusing 7/20/50/100 here would fire six
 * times as often for a sixth of the achievement, and the major ones would drown in it.
 *
 * ---- Why they are keyed on period ----
 *
 * A streak counts PERIODS, not days: weeks for a weekly habit, months for a monthly one. Fifty of
 * anything looks like a sensible number until it is applied to savings and means fifty months. So
 * each cadence gets thresholds that are a real span in its own rhythm — a fortnight, a month, two
 * months, four months of daily; a month, a quarter, half a year, a year of weekly.
 */
export const HABIT_TIERS = {
  day: [
    { at: 14, span: "a fortnight" },
    { at: 30, span: "a month" },
    { at: 60, span: "two months" },
    { at: 120, span: "four months" },
  ],
  week: [
    { at: 4, span: "a month" },
    { at: 12, span: "three months" },
    { at: 26, span: "half a year" },
    { at: 52, span: "a year" },
  ],
  month: [
    { at: 3, span: "three months" },
    { at: 6, span: "half a year" },
    { at: 12, span: "a year" },
    { at: 24, span: "two years" },
  ],
};

/** Just the numbers, for the level maths. */
export const habitSteps = (period) => (HABIT_TIERS[period] || HABIT_TIERS.day).map((t) => t.at);

/**
 * What a count actually means in weeks and months.
 *
 * "60" is a number somebody has to convert before it means anything. "Two months" is the same fact
 * already converted, and it is the half that makes a person stop and reread it — which is the
 * entire job of the sentence it appears in.
 */
export function habitSpan(streak, period = "day") {
  const step = (HABIT_TIERS[period] || HABIT_TIERS.day).find((t) => t.at === streak);
  return step ? step.span : null;
}

/**
 * The level a single habit's streak has reached: 1..4, or 0 for none.
 *
 * A LEVEL rather than a named tier, deliberately. The four majors are called Bronze through
 * Diamond and get announced by name; if a habit badge claimed the same words, "Gold" would mean
 * fifty days of everything in one place and sixty days of steps in another. The minor badge shows
 * its number and its colour and stays quiet about rank, which is also the honest description of
 * what it is worth.
 */
export function habitLevel(streak, period = "day") {
  let level = 0;
  for (const at of habitSteps(period)) {
    if ((streak || 0) >= at) level += 1;
  }
  return level;
}

/** The colour key for a level, shared with the major badges so the two read as one family. */
export const LEVEL_KEY = ["", "bronze", "silver", "gold", "diamond"];

/** Is this streak exactly on one of a habit's thresholds today? */
export function habitCrossed(streak, period = "day") {
  return habitSteps(period).includes(streak);
}
