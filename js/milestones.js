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
  { at: 7, key: "bronze", name: "Bronze", earned: "A full week" },
  { at: 20, key: "silver", name: "Silver", earned: "Twenty days" },
  { at: 50, key: "gold", name: "Gold", earned: "Fifty days" },
  { at: 100, key: "diamond", name: "Diamond", earned: "One hundred days" },
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
