// taper.test.mjs — a ceiling that comes down on its own, and stops when you stop.
//
// The vape habit is the reason the reduce direction exists, and the taper is the reason it is a
// quit programme rather than a diary. Four things about it are easy to get wrong:
//
//   1. WHOSE schedule it is. A taper counting from the habit's birthday hands somebody joining a
//      six-month-old group a target already tapered twenty-six weeks down on their first day. That
//      is not a hard start, it is an impossible one, and it lands on the newest member — the person
//      with the least invested and the most reason to walk away.
//
//   2. WHETHER it ends. Ten per cent of the ORIGINAL each week is linear and reaches zero in ten.
//      Ten per cent of LAST week's is compounding: eighty becomes twenty-eight after ten weeks and
//      never arrives. Both are "10% a week"; only one of them is quitting.
//
//   3. That it STOPS for somebody who is not keeping up. Three missed days in a week hold the next
//      one, so the programme waits rather than asking more of somebody already struggling.
//
//   4. That holding COSTS something. Holding is easier than not holding, so without a price the
//      optimal play is to miss three days a week for ever and keep the opening allowance.

import assert from "node:assert/strict";
import {
  replay, targetFor, targetOn, addDays, isTaperHeld, bonusForfeited, TAPER_MISS_LIMIT,
} from "../js/habits.js";
import { dayScore } from "../js/score.js";
import { ev, SOURCE, AT_MOST, AT_LEAST, AGGREGATE, METRIC } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
let _seq = 0;
function at(day, hour = 20) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - 2);
}
function E(spec, ts) {
  _seq += 1;
  return { eventId: "t" + String(_seq).padStart(4, "0"), ts, seq: _seq, ...spec };
}

const BASE_DAY = "2026-03-02"; // a Monday

/** The vape habit as the group actually runs it: a ceiling of 80, tapering a tenth a week. */
function puffHabit(taper = { percent: 10, everyDays: 7, floor: 0 }) {
  return ev.habit("puffs", {
    name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
    aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4, taper,
  });
}

/**
 * Days logged comfortably under the ceiling.
 *
 * Every fixture here needs them. A tapering habit only steps down for somebody actually running
 * it — an unlogged manual day is a miss, and three of those hold the week — so a fixture with no
 * logs would be testing the hold rule by accident rather than whatever it is named for.
 */
function clean(memberId, from, days, value = 0, habitId = "puffs") {
  return Array.from({ length: days }, (_, n) => {
    const d = addDays(from, n);
    return E(ev.log(habitId, memberId, d, value, SOURCE.MANUAL), at(d));
  });
}

/** One member, running the vape habit cleanly from their baseline. */
function runningCleanly(days = 90, taper = undefined) {
  return replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(taper === undefined ? puffHabit() : puffHabit(taper), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...clean("m1", BASE_DAY, days),
  ]);
}

// ---------------------------------------------------------------------------
// Ten per cent a week, of the original
// ---------------------------------------------------------------------------

test("a tenth of the baseline comes off every week", () => {
  const s = runningCleanly();
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", BASE_DAY), 80, "week one is the baseline");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-08"), 80, "still week one on day seven");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 72, "week two");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-16"), 64, "week three");
  assert.equal(targetFor(s, puffs, "m1", "2026-04-13"), 32, "week seven");
});

test("it reaches zero in ten weeks, and stays there", () => {
  // The whole point. A compounding taper would be at 28 here and would never arrive.
  const s = runningCleanly();
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-05-04"), 8, "week ten");
  assert.equal(targetFor(s, puffs, "m1", "2026-05-11"), 0, "week eleven — quit");
  assert.equal(targetFor(s, puffs, "m1", "2026-05-25"), 0, "and it does not go negative");
});

test("the floor holds it above zero when one is set", () => {
  const s = runningCleanly(90, { percent: 10, everyDays: 7, floor: 20 });
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-05-11"), 20);
  assert.equal(targetFor(s, puffs, "m1", "2026-05-25"), 20);
});

test("the reduction is rounded once, against the original, so the steps do not drift", () => {
  // A baseline that does not divide evenly. 35 at ten per cent is 3.5 a week, and the TOTAL
  // reduction is what gets rounded — 3.5, 7, 10.5 → 4, 7, 11 — so the ceiling steps 4, 3, 4.
  //
  // Rounding each step instead would round 3.5 up every time and take 40 off across ten weeks
  // rather than 35, overshooting the baseline and hitting zero a week early.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 35 }), at(BASE_DAY, 8)),
    ...clean("m1", BASE_DAY, 80),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 31, "35 − 3.5 → 31");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-16"), 28, "35 − 7");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-23"), 24, "35 − 10.5 → 24");
  assert.equal(targetFor(s, puffs, "m1", "2026-05-11"), 0, "exactly ten weeks to zero, not nine");
});

// ---------------------------------------------------------------------------
// Whose schedule it is
// ---------------------------------------------------------------------------

test("a member joining a running habit starts at the top of their OWN taper", () => {
  // The bug this exists to prevent. The habit is six weeks old; m2 sets their baseline today and
  // must be on week one of their own schedule, not week seven of somebody else's.
  const JOIN = "2026-04-13";
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...clean("m1", BASE_DAY, 60),
    E(ev.member("m2", "Thabo"), at(JOIN, 7)),
    E(ev.goal("m2", "puffs", { target: 60 }), at(JOIN, 8)),
    ...clean("m2", JOIN, 30),
  ]);
  const puffs = s.habits.get("puffs");

  assert.equal(targetFor(s, puffs, "m2", JOIN), 60, "day one is their baseline, untapered");
  assert.equal(targetFor(s, puffs, "m2", "2026-04-20"), 54, "their week two");
  assert.equal(targetFor(s, puffs, "m1", "2026-04-20"), 24, "and m1 is unaffected by m2 joining");
});

test("two members taper independently, each from their own baseline", () => {
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(ev.member("m2", "Thabo"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...clean("m1", BASE_DAY, 40),
    E(ev.goal("m2", "puffs", { target: 40 }), at("2026-03-16", 8)),
    ...clean("m2", "2026-03-16", 30),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-23"), 56, "m1: week four of eighty");
  assert.equal(targetFor(s, puffs, "m2", "2026-03-23"), 36, "m2: week two of forty");
});

test("a later goal edit does not restart the taper", () => {
  // Only the FIRST goal is the baseline. Otherwise the schedule resets to week one by nudging the
  // number, which is the whole taper undone in two taps.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...clean("m1", BASE_DAY, 60),
    E(ev.goal("m1", "puffs", { target: 80 }), at("2026-04-06", 8)),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-04-13"), 32, "still week seven, not week one");
});

test("with no personal goal at all it falls back to the habit's own schedule", () => {
  // Every habit that predates personal goals has to keep scoring exactly as it did.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    ...clean("m1", BASE_DAY, 30),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", BASE_DAY), 80);
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 72);
  assert.equal(targetOn(puffs, "2026-03-09"), 72, "and the member-less reader agrees");
});

// ---------------------------------------------------------------------------
// Holding, when somebody is not keeping up
// ---------------------------------------------------------------------------

/** A week of logs where `over` of them blow the ceiling. */
function week(memberId, from, over, under = 0, blown = 999) {
  return Array.from({ length: 7 }, (_, n) => {
    const d = addDays(from, n);
    return E(ev.log("puffs", memberId, d, n < over ? blown : under, SOURCE.MANUAL), at(d));
  });
}

test("three missed days hold the next week at the same number", () => {
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...week("m1", BASE_DAY, 3),              // week 0: three days over
    ...clean("m1", "2026-03-09", 21),        // and clean thereafter
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 80, "week two holds at the baseline");
  assert.ok(isTaperHeld(s, puffs, "m1", "2026-03-09"));
  assert.equal(targetFor(s, puffs, "m1", "2026-03-16"), 72, "and resumes from where it paused");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-23"), 64);
});

test("two missed days do not hold it", () => {
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...week("m1", BASE_DAY, 2),
    ...clean("m1", "2026-03-09", 14),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 72, "the schedule marches on");
  assert.equal(isTaperHeld(s, puffs, "m1", "2026-03-09"), false);
  assert.equal(TAPER_MISS_LIMIT, 3);
});

test("holding repeatedly pushes the whole schedule back, rather than skipping steps", () => {
  // The programme waits; it does not lose its place. After two held weeks the fourth week is on
  // the step the second would have been.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...week("m1", BASE_DAY, 3),           // week 0 bad  → week 1 held
    ...week("m1", "2026-03-09", 3),       // week 1 bad  → week 2 held
    ...clean("m1", "2026-03-16", 28),     // clean from week 2 on
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 80, "week 1 held");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-16"), 80, "week 2 held too");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-23"), 72, "week 3 takes the first step");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-30"), 64, "and it carries on from there");
});

test("a member who never logs never tapers", () => {
  // Consistent with the engine everywhere else: an unlogged manual day is a miss, because the puff
  // count exists whether or not it is entered. So the programme never asks more of somebody who
  // has not started it — and the reminder, not a silent step down, is what chases them.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-05-11"), 80, "ten weeks later, still eighty");
});

test("days the habit does not run on cannot be missed", () => {
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(ev.habit("puffs", {
      name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
      aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
      days: [1, 2, 3, 4, 5], taper: { percent: 10, everyDays: 7, floor: 0 },
    }), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...clean("m1", BASE_DAY, 21),
  ]);
  const puffs = s.habits.get("puffs");
  // The weekend is not scheduled, so the two unlogged weekend days are not misses and the taper
  // steps normally.
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 72);
});

test("travel exempts a week rather than holding it", () => {
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    E(ev.exempt("m1", BASE_DAY, "2026-03-08", "travel"), at(BASE_DAY, 9)),
    ...clean("m1", "2026-03-09", 21),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 72, "the week away is not held against them");
});

// ---------------------------------------------------------------------------
// What holding costs
// ---------------------------------------------------------------------------

test("a held week forfeits the bonus, across every habit", () => {
  // The price that stops holding being a reward. Missing three days of the vape costs the bonus on
  // steps too — otherwise the cheapest way to keep a comfortable ceiling for ever is to miss three
  // days a week, every week.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
    }), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...week("m1", BASE_DAY, 3),
    ...clean("m1", "2026-03-09", 14),
    // Beating the step target handsomely throughout — normally worth the full bonus.
    ...clean("m1", BASE_DAY, 21, 20000, "steps"),
  ]);

  assert.ok(bonusForfeited(s, "m1", "2026-03-09"), "the held week earns none");
  assert.equal(dayScore(s, "m1", "2026-03-09").bonus, 0);
  // And the week after the hold, once the programme has resumed, pays again.
  assert.equal(bonusForfeited(s, "m1", "2026-03-16"), false);
  assert.ok(dayScore(s, "m1", "2026-03-16").bonus > 0, "the bonus comes back");
});

test("a member with no tapering habit at all forfeits nothing", () => {
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
    }), at(BASE_DAY, 7)),
    ...clean("m1", BASE_DAY, 21, 20000, "steps"),
  ]);
  assert.equal(bonusForfeited(s, "m1", "2026-03-16"), false);
  assert.equal(dayScore(s, "m1", "2026-03-16").bonus, 15);
});

// ---------------------------------------------------------------------------
// The plan is cached, and the cache must not be able to change the answer
// ---------------------------------------------------------------------------

test("asking for weeks out of order gives the same answers as asking in order", () => {
  // The bug this exists to prevent, and it was invisible to every test above.
  //
  // Holds accumulate week by week, so the schedule is walked forwards and memoised. The first
  // version cached a single running TOTAL of holds — which is only correct for the furthest week
  // ever asked about. Once the walk had reached week fifty, asking again about week three handed
  // back fifty weeks of holds, the step count went negative, and a ceiling meant to fall to zero
  // climbed past four hundred instead.
  //
  // Nothing caught it because each test used a fresh state and asked in increasing order. Real
  // callers do not: scoreOver walks a range, categoryOver walks it again, and the season re-walks
  // every week from the beginning.
  const days = ["2026-03-02", "2026-03-09", "2026-03-16", "2026-03-23", "2026-03-30", "2026-04-13"];

  const forwards = runningCleanly();
  const inOrder = days.map((d) => targetFor(forwards, forwards.habits.get("puffs"), "m1", d));

  const backwards = runningCleanly();
  const reversed = [...days].reverse()
    .map((d) => targetFor(backwards, backwards.habits.get("puffs"), "m1", d))
    .reverse();

  assert.deepEqual(reversed, inOrder, "the order they were asked in must not matter");
  assert.deepEqual(inOrder, [80, 72, 64, 56, 48, 32], "and both must be the real schedule");
});

test("a far-future question does not poison the answers behind it", () => {
  const s = runningCleanly();
  const puffs = s.habits.get("puffs");
  // Walk the plan out to week twenty first, then come back for week two.
  targetFor(s, puffs, "m1", "2026-07-20");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 72, "week two is still week two");
  assert.equal(targetFor(s, puffs, "m1", BASE_DAY), 80, "and the baseline is still the baseline");
});

test("scoring the same state twice gives an identical answer", () => {
  // Determinism across repeat reads, which the memo put at risk. Two devices replaying the same
  // log must agree, and so must one device asked the same question twice.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    ...week("m1", BASE_DAY, 3),
    ...clean("m1", "2026-03-09", 40),
  ]);
  const first = JSON.stringify(dayScore(s, "m1", "2026-04-06"));
  const second = JSON.stringify(dayScore(s, "m1", "2026-04-06"));
  assert.equal(first, second);
});

test("a hold cannot push the step count below zero", () => {
  // Every week held is a week whose step never landed, so steps can only ever be fewer than weeks
  // elapsed — never negative, which would run the ceiling UP instead of down.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit(), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 80 }), at(BASE_DAY, 8)),
    // Every single week blown, for three months.
    ...Array.from({ length: 13 }, (_, w) => week("m1", addDays(BASE_DAY, w * 7), 7)).flat(),
  ]);
  const puffs = s.habits.get("puffs");
  for (const n of [0, 7, 21, 49, 84]) {
    const target = targetFor(s, puffs, "m1", addDays(BASE_DAY, n));
    assert.equal(target, 80, "held at the baseline on day " + n + ", never above it");
  }
});

// ---------------------------------------------------------------------------
// The absolute form still works
// ---------------------------------------------------------------------------

test("a fixed amount per week is unchanged", () => {
  // Small ceilings still need this: ten per cent of eight rounds to one and reads as noise.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(puffHabit({ amount: 1, everyDays: 7, floor: 0 }), at(BASE_DAY, 7)),
    E(ev.goal("m1", "puffs", { target: 12 }), at(BASE_DAY, 8)),
    ...clean("m1", BASE_DAY, 80),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", BASE_DAY), 12);
  assert.equal(targetFor(s, puffs, "m1", "2026-03-09"), 11);
  assert.equal(targetFor(s, puffs, "m1", "2026-05-11"), 2);
});

test("percent wins when a habit somehow carries both", () => {
  const s = runningCleanly(30, { amount: 1, percent: 10, everyDays: 7, floor: 0 });
  assert.equal(targetFor(s, s.habits.get("puffs"), "m1", "2026-03-09"), 72);
});

test("a habit with no taper never moves, and never holds", () => {
  const s = runningCleanly(90, null);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-05-11"), 80);
  assert.equal(isTaperHeld(s, puffs, "m1", "2026-05-11"), false);
});

test("an at_least habit tapers UPWARDS", () => {
  // The same machinery pointed the other way: a step count that climbs 10% of baseline a week.
  const s = replay([
    E(ev.member("m1", "Sahil"), at(BASE_DAY, 7)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 5000,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
      taper: { percent: 10, everyDays: 7 },
    }), at(BASE_DAY, 7)),
    E(ev.goal("m1", "steps", { target: 5000 }), at(BASE_DAY, 8)),
    ...clean("m1", BASE_DAY, 30, 40000, "steps"),
  ]);
  const steps = s.habits.get("steps");
  assert.equal(targetFor(s, steps, "m1", "2026-03-09"), 5500);
  assert.equal(targetFor(s, steps, "m1", "2026-03-16"), 6000);
});

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ taper: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ taper: " + passed + " tests passed");
