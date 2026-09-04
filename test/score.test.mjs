// score.test.mjs — the fairness properties, as executable claims.
//
// Most of these are not examples, they are invariants. The loopholes in a weighted scoring system
// are never "this sum is wrong"; they are "there is a way to be rewarded for doing less", and you
// find those by asserting that a thing can never happen rather than by checking one case.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import {
  dayScore, categoryScores, habitScore, categoryFor, scoreOver, categoryOver, expectedBy,
  CATEGORY, CATEGORY_WEIGHT, BONUS_CAP,
} from "../js/score.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, AGGREGATE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MONDAY = "2026-03-02";
const day = (n) => addDays(MONDAY, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "s" + ++seq, ts, seq, ...spec });

const HABITS = {
  steps: {
    name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
    aggregate: AGGREGATE.LAST, period: PERIOD.DAY, source: SOURCE.HEALTH_CONNECT, scored: true,
  },
  gym: {
    name: "Workouts", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3,
    aggregate: AGGREGATE.SUM, period: PERIOD.WEEK, source: SOURCE.HEALTH_CONNECT, scored: true,
  },
  screen: {
    name: "Screen time", metric: METRIC.SCREEN_MINUTES, direction: AT_MOST, target: 120,
    aggregate: AGGREGATE.LAST, period: PERIOD.DAY, source: SOURCE.PAUSE, scored: true,
  },
  puffs: {
    name: "Vape puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 200,
    aggregate: AGGREGATE.LAST, period: PERIOD.DAY, source: SOURCE.MANUAL, scored: true,
  },
  sleep: {
    name: "Sleep", metric: METRIC.SLEEP, direction: AT_LEAST, target: 420,
    aggregate: AGGREGATE.LAST, period: PERIOD.DAY, source: SOURCE.HEALTH_CONNECT, scored: true,
  },
  reading: {
    name: "Reading", metric: null, direction: AT_LEAST, target: 1,
    aggregate: AGGREGATE.SUM, period: PERIOD.DAY, source: SOURCE.MANUAL, scored: true,
  },
  savings: {
    name: "Savings", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 2000,
    aggregate: AGGREGATE.LAST, period: PERIOD.MONTH, source: SOURCE.MANUAL, scored: true,
  },
};

/** Build a world from habit ids, plus logs as [habitId, dayOffset, value]. */
function world(ids, logs = [], extra = []) {
  const events = [E(ev.member("m1", "Me"), at(0))];
  for (const id of ids) {
    events.push(E(ev.habit(id, { ...HABITS[id], tz: TZ, dayStartHour: 0 }), at(0)));
    events.push(E(ev.bind("m1", id, HABITS[id].source), at(0)));
  }
  for (const [id, n, value] of logs) {
    events.push(E(ev.log(id, "m1", day(n), value, HABITS[id].source), at(n)));
  }
  return replay([...events, ...extra]);
}

const scoreOf = (s, n) => dayScore(s, "m1", day(n));
const habitIn = (s, id, n) => habitScore(s, s.habits.get(id), "m1", day(n));

// ===========================================================================
// The invariants
// ===========================================================================

test("a perfect day is exactly 100, whichever categories a person runs", () => {
  // The claim in the brief: somebody running two categories is measured out of a hundred exactly
  // like somebody running four. Without renormalisation the two-category person tops out at 55.
  const everything = world(["steps", "screen", "sleep", "savings"],
    [["steps", 0, 10000], ["screen", 0, 100], ["sleep", 0, 420], ["savings", 0, 2000]]);
  const justTwo = world(["steps", "screen"], [["steps", 0, 10000], ["screen", 0, 100]]);
  assert.equal(scoreOf(everything, 0).pct, 100);
  assert.equal(scoreOf(justTwo, 0).pct, 100);
});

test("tracking MORE never lowers your ceiling", () => {
  // The loophole the whole design exists to close. If adding a habit could cost you, the winning
  // move is to track one easy thing, and the leaderboard becomes a contest in scope.
  const one = world(["steps"], [["steps", 0, 10000]]);
  const four = world(["steps", "screen", "sleep", "reading"],
    [["steps", 0, 10000], ["screen", 0, 60], ["sleep", 0, 420], ["reading", 0, 1]]);
  assert.equal(scoreOf(one, 0).pct, 100);
  assert.equal(scoreOf(four, 0).pct, 100);
});

test("a rest day is neutral — it never RAISES the score", () => {
  // The naive reading of "shift the weight to their other habits" pays you for resting: the weight
  // moves onto things you are already smashing and the bonus carries you past where you were.
  const logs = [["steps", 0, 10000], ["screen", 0, 200]]; // screen blown, so the day is not full
  const normal = world(["steps", "screen"], logs);
  const resting = world(["steps", "screen"], logs,
    [E(ev.exempt("m1", day(0), day(0), "travel", "screen"), at(0))]);
  assert.ok(scoreOf(normal, 0).pct < 100);
  assert.ok(
    scoreOf(resting, 0).pct >= scoreOf(normal, 0).pct,
    "resting may excuse, which is the point",
  );
  // But it cannot beat actually doing it.
  const done = world(["steps", "screen"], [["steps", 0, 10000], ["screen", 0, 0]]);
  assert.ok(scoreOf(resting, 0).pct <= scoreOf(done, 0).pct);
});

test("a silent sensor is neutral, not a bonus and not a failure", () => {
  // A broken watch must not score zero, and must not pay either. Under redistribution-with-bonus
  // a dead pipeline is a raise, which is the worst possible incentive.
  const quiet = world(["steps", "screen"], [["screen", 0, 60]]); // steps said nothing
  const s = scoreOf(quiet, 0);
  const fitness = s.categories.find((c) => c.category === CATEGORY.FITNESS);
  assert.equal(fitness.eligible, false, "nothing to judge");
  assert.equal(s.pct, 100, "and the rest of the day is still out of a hundred");
});

test("the day is capped at 100 however much is overachieved", () => {
  const s = world(["steps", "screen", "sleep"],
    [["steps", 0, 40000], ["screen", 0, 0], ["sleep", 0, 700]]);
  assert.equal(scoreOf(s, 0).pct, 100);
});

test("the bonus buys a buffer INSIDE a category and cannot cross out of one", () => {
  // Steps rescuing a soft sleep is the point. Steps rescuing a blown screen-time day is not: the
  // categories would be decorative and one runaway metric could buy the board.
  const withinFitness = world(["steps", "gym"], [["steps", 0, 30000]]);
  const fit = categoryScores(withinFitness, "m1", day(0)).get(CATEGORY.FITNESS);
  assert.ok(fit.score > 0.5, "a huge step day lifts its own category");

  const across = world(["steps", "screen"], [["steps", 0, 40000], ["screen", 0, 400]]);
  const s = scoreOf(across, 0);
  const discipline = s.categories.find((c) => c.category === CATEGORY.DISCIPLINE);
  assert.equal(discipline.score, 0, "a blown ceiling is zero");
  assert.ok(s.pct < 100, "and no amount of walking buys it back");
});

// ===========================================================================
// Each habit type, on its own terms
// ===========================================================================

test("a daily floor scores in proportion, and over-delivery earns the cap", () => {
  const half = world(["steps"], [["steps", 0, 5000]]);
  assert.equal(habitIn(half, "steps", 0).score, 0.5);
  const over = world(["steps"], [["steps", 0, 20000]]);
  assert.equal(habitIn(over, "steps", 0).score, BONUS_CAP);
});

test("a ceiling: at the limit passes, under it pays, over it is zero at once", () => {
  const at200 = world(["puffs"], [["puffs", 0, 200]]);
  assert.equal(habitIn(at200, "puffs", 0).score, 1, "exactly at the limit is a pass");

  const at100 = world(["puffs"], [["puffs", 0, 100]]);
  assert.ok(at100 && habitIn(at100, "puffs", 0).score > 1, "cutting down pays");

  const clean = world(["puffs"], [["puffs", 0, 0]]);
  assert.equal(habitIn(clean, "puffs", 0).score, BONUS_CAP, "a zero day is the maximum");

  const over = world(["puffs"], [["puffs", 0, 201]]);
  assert.equal(habitIn(over, "puffs", 0).score, 0, "one over the limit is zero, not 99%");
});

test("a manual ceiling with nothing logged is a miss, not a free perfect day", () => {
  // Settled earlier and it has to survive the new scoring: the vape keeps the count, so silence is
  // an unreported day rather than an unknowable one.
  const s = world(["puffs"]);
  assert.equal(habitIn(s, "puffs", 0).eligible, true);
  assert.equal(habitIn(s, "puffs", 0).score, 0);
});

test("the weekly expectation is a whole number, because nobody does 0.43 of a workout", () => {
  // Three a week reads 1, 1, 2, 2, 3, 3, 3 from Monday to Sunday. A fraction is the right maths
  // and the wrong thing to show somebody: "you are behind by 0.43" is not a sentence anyone can
  // act on, and the score is computed against exactly the figure the card displays.
  const s = world(["gym"]);
  const gym = s.habits.get("gym");
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((n) => expectedBy(gym, day(n))),
    [1, 1, 2, 2, 3, 3, 3],
  );
});

test("weekly workouts are graded against that pace from Monday", () => {
  // Explicitly asked for: the week is a race you can fall behind in, and being told so on Monday
  // night is the point of running one.
  const none = world(["gym"]);
  assert.equal(habitIn(none, "gym", 0).score, 0, "Monday with none done is behind");
  assert.equal(habitIn(none, "gym", 0).expected, 1, "and the card says one was expected");

  // One by Monday night is exactly on pace — a pass, not a bonus.
  const one = world(["gym"], [["gym", 0, 1]]);
  assert.equal(habitIn(one, "gym", 0).score, 1);
  assert.equal(habitIn(one, "gym", 1).score, 1, "still on pace on Tuesday");
  // Two by Wednesday keeps it; one does not.
  assert.equal(habitIn(one, "gym", 2).expected, 2);
  assert.equal(habitIn(one, "gym", 2).score, 0.5);
});

test("finishing the week early locks the maximum for the rest of it", () => {
  const s = world(["gym"], [["gym", 0, 1], ["gym", 1, 1], ["gym", 2, 1]]);
  assert.equal(habitIn(s, "gym", 2).score, BONUS_CAP);
  assert.equal(habitIn(s, "gym", 5).score, BONUS_CAP, "still done on Saturday");
});

test("the week resets, so last week's three do not pay for this week", () => {
  const s = world(["gym"], [["gym", 0, 1], ["gym", 1, 1], ["gym", 2, 1]]);
  assert.equal(habitIn(s, "gym", 8).score, 0, "next Tuesday starts again at nothing");
});

test("an untouched month in progress is NOT JUDGED, rather than judged generously", () => {
  // The honest version of "no penalty before payday". Handing out full marks for a goal nobody has
  // started is a free fifteen per cent: a month with nothing saved would score perfectly on
  // twenty-seven days and fail on one, so missing the target entirely cost a single day.
  //
  // Not eligible is the neutral state this design already has everywhere else, and it is what
  // "you cannot be behind on something you have not been paid for yet" actually means.
  const nothing = world(["savings"]);
  assert.equal(habitIn(nothing, "savings", 0).eligible, false);
  assert.equal(scoreOf(nothing, 0).pct, null, "nothing else tracked, so nothing to score");
});

test("once there is money in it, the month shows where you stand", () => {
  const part = world(["savings"], [["savings", 3, 1000]]);
  const h = habitIn(part, "savings", 5);
  assert.equal(h.eligible, true);
  assert.equal(h.score, 0.5, "half the target is half the credit");

  const paid = world(["savings"], [["savings", 20, 2000]]);
  assert.equal(habitIn(paid, "savings", 22).score, BONUS_CAP, "hit the target, hold the maximum");
});

test("but the month is judged when it can no longer be saved", () => {
  // 2026-03-31 is the last day of the month.
  const missed = world(["savings"], [["savings", 20, 500]]);
  const last = addDays(MONDAY, 29); // 2026-03-31
  const h = habitScore(missed, missed.habits.get("savings"), "m1", last);
  assert.equal(last, "2026-03-31");
  assert.equal(h.eligible, true);
  assert.equal(h.score, 0.25, "a quarter saved is a quarter of the credit");
});

// ===========================================================================
// Categories
// ===========================================================================

test("reading and meditation land in Rest & Recovery", () => {
  assert.equal(categoryFor({ metric: null, name: "Reading" }), CATEGORY.REST);
  assert.equal(categoryFor({ metric: METRIC.SLEEP }), CATEGORY.REST);
  assert.equal(categoryFor({ metric: METRIC.STEPS }), CATEGORY.FITNESS);
  assert.equal(categoryFor({ metric: METRIC.PUFFS }), CATEGORY.DISCIPLINE);
  assert.equal(categoryFor({ metric: METRIC.AMOUNT }), CATEGORY.MONEY);
  // And an explicit choice always wins over the guess.
  assert.equal(categoryFor({ metric: METRIC.STEPS, category: CATEGORY.REST }), CATEGORY.REST);
});

test("two habits in one category share it rather than doubling it", () => {
  // Adding a second fitness habit must split Core Fitness, not dilute the whole day. Otherwise
  // adding habits is a punishment and the brief's objective is lost.
  const s = world(["steps", "gym", "screen"],
    [["steps", 0, 10000], ["screen", 0, 60]]);
  const day0 = scoreOf(s, 0);
  const fitness = day0.categories.find((c) => c.category === CATEGORY.FITNESS);
  // Steps perfect, gym at nothing on a Monday: the category is the mean of the two.
  assert.ok(fitness.score > 0.4 && fitness.score < 0.6);
  assert.equal(Math.round(fitness.share), 57, "40 of 70 once Rest and Money are absent");
});

test("the weights are the group's and cannot be moved by a member", () => {
  // The old per-habit weight ran 0.5x to 10x and was set by whoever made the habit. It is ignored
  // now: putting 10x on your easiest habit is not a preference, it is a dial on your own scoreline.
  const plain = world(["steps", "screen"], [["steps", 0, 5000], ["screen", 0, 60]]);
  const rigged = replay([
    E(ev.member("m1", "Me"), at(0)),
    E(ev.habit("steps", { ...HABITS.steps, weight: 10, tz: TZ, dayStartHour: 0 }), at(0)),
    E(ev.habit("screen", { ...HABITS.screen, weight: 0.5, tz: TZ, dayStartHour: 0 }), at(0)),
    E(ev.bind("m1", "steps", SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.bind("m1", "screen", SOURCE.PAUSE), at(0)),
    E(ev.log("steps", "m1", day(0), 5000, SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.log("screen", "m1", day(0), 60, SOURCE.PAUSE), at(0)),
  ]);
  assert.equal(scoreOf(plain, 0).pct, scoreOf(rigged, 0).pct);
});

test("category weights are the ones the group agreed", () => {
  assert.equal(CATEGORY_WEIGHT[CATEGORY.FITNESS], 40);
  assert.equal(CATEGORY_WEIGHT[CATEGORY.DISCIPLINE], 30);
  assert.equal(CATEGORY_WEIGHT[CATEGORY.REST], 15);
  assert.equal(CATEGORY_WEIGHT[CATEGORY.MONEY], 15);
  assert.equal(Object.values(CATEGORY_WEIGHT).reduce((a, b) => a + b, 0), 100);
});

// ===========================================================================
// Over a range, and by category
// ===========================================================================

test("a range averages the days that counted, and says how many that was", () => {
  const s = world(["steps"], [["steps", 0, 10000], ["steps", 1, 5000]]);
  const over = scoreOver(s, "m1", day(0), day(1), addDays);
  assert.equal(over.days, 2);
  assert.equal(over.pct, 75);
});

test("days nobody was asked about are skipped, not counted as zero", () => {
  // A week away must not read as a week of failure.
  const s = world(["steps"], [["steps", 0, 10000]],
    [E(ev.exempt("m1", day(1), day(2), "travel"), at(0))]);
  const over = scoreOver(s, "m1", day(0), day(2), addDays);
  assert.equal(over.days, 1);
  assert.equal(over.pct, 100);
});

test("a category can be scored on its own, for the board's filter", () => {
  const s = world(["steps", "screen"],
    [["steps", 0, 10000], ["steps", 1, 5000], ["screen", 0, 60], ["screen", 1, 60]]);
  assert.equal(categoryOver(s, "m1", day(0), day(1), CATEGORY.FITNESS, addDays).pct, 75);
  assert.equal(categoryOver(s, "m1", day(0), day(1), CATEGORY.DISCIPLINE, addDays).pct, 100);
  // A category nobody runs has no score rather than a zero.
  assert.equal(categoryOver(s, "m1", day(0), day(1), CATEGORY.MONEY, addDays).pct, null);
});

test("somebody tracking nothing has no score, which is not the same as zero", () => {
  const s = world([]);
  assert.equal(scoreOf(s, 0).pct, null);
  assert.equal(scoreOf(s, 0).scored, false);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ category scoring: " + passed + " tests passed");
