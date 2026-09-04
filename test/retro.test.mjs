// retro.test.mjs — you cannot change the past.
//
// Every rule in this app that decides whether a day counted was, until now, read from the LATEST
// value of something a member controls: their goal, whether they were signed up, the group's
// target, an exemption. Replay applied all of them to the whole of history, so a bad week could be
// fixed on Sunday night from the settings screen, and nothing anywhere recorded that it had been.
//
// These are the cheats, written down and run. Each has the shape "do the bad week, then reach for
// the lever" — and the assertion is that the week is still bad.

import assert from "node:assert/strict";
import {
  replay, walk, rawDayStatus, rawPeriodStatus, leaderboard, targetFor, targetOn, isTracking,
  goalOn, latestGoal, periodKey, addDays, HIT, MISS, EXEMPT,
} from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, AGGREGATE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const START = "2026-03-02"; // Monday
const day = (n) => addDays(START, n);
/** Noon on a given day, so nothing lands near a boundary by accident. */
const at = (n) => Date.parse(day(n) + "T12:00:00Z");

let seq = 0;
const E = (spec, ts) => ({ eventId: "r" + ++seq, ts, seq, ...spec });

const HABIT = {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
  aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, scored: true, tz: TZ, dayStartHour: 0,
};

/** A member who logged 6,000 steps every day of a week against a 10,000 goal. A bad week. */
function badWeek(extra = []) {
  const events = [
    E(ev.member("m1", "Me"), at(0)),
    E(ev.habit("h", HABIT), at(0)),
    E(ev.bind("m1", "h", SOURCE.MANUAL), at(0)),
  ];
  for (let n = 0; n < 7; n += 1) {
    events.push(E(ev.log("h", "m1", day(n), 6000, SOURCE.MANUAL), at(n)));
  }
  return replay([...events, ...extra]);
}

const statusOn = (s, n) => rawDayStatus(s, s.habits.get("h"), "m1", day(n));
const pct = (s) => leaderboard(s, ["m1"], day(0), day(6), day(7))[0].pct;

// ===========================================================================
// Lowering your own goal
// ===========================================================================

test("lowering a goal on Sunday does not turn the week into a good one", () => {
  // The whole point. 6,000 a day against a 10,000 goal is seven misses; setting the goal to 5,000
  // on Sunday used to make it seven hits, retroactively, in silence.
  const before = badWeek();
  assert.equal(pct(before), 0);

  const after = badWeek([
    E(ev.goal("m1", "h", { target: 10000 }), at(0)),   // the goal they actually committed to
    E(ev.goal("m1", "h", { target: 5000 }), at(6)),    // ...and the Sunday-night edit
  ]);
  assert.equal(pct(after), 0, "the week must not be rescued");
  for (let n = 0; n < 7; n += 1) assert.equal(statusOn(after, n), MISS, "day " + n);
});

test("but it does apply from the next day, exactly as promised", () => {
  const s = badWeek([
    E(ev.goal("m1", "h", { target: 10000 }), at(0)),
    E(ev.goal("m1", "h", { target: 5000 }), at(6)),
    E(ev.log("h", "m1", day(7), 6000, SOURCE.MANUAL), at(7)),
  ]);
  const h = s.habits.get("h");
  assert.equal(targetFor(s, h, "m1", day(6)), 10000, "the day it was set is still the old number");
  assert.equal(targetFor(s, h, "m1", day(7)), 5000, "and the next day is the new one");
  assert.equal(statusOn(s, 7), HIT);
});

test("a first goal counts from the day it is set, because that is not a change", () => {
  // A joiner picking their numbers on day one must be judged against what they chose, not against
  // the group's default for a day.
  const s = badWeek([E(ev.goal("m1", "h", { target: 5000 }), at(0))]);
  assert.equal(targetFor(s, s.habits.get("h"), "m1", day(0)), 5000);
  assert.equal(statusOn(s, 0), HIT);
});

test("the goal you last set is visible even before it starts counting", () => {
  // The screens show intent; the scoring shows what was in force. Both have to be readable or the
  // goals sheet would open showing a number the person had already changed.
  const s = badWeek([
    E(ev.goal("m1", "h", { target: 10000 }), at(0)),
    E(ev.goal("m1", "h", { target: 5000 }), at(6)),
  ]);
  assert.equal(latestGoal(s, "h", "m1").target, 5000);
  assert.equal(goalOn(s, "h", "m1", day(6)).target, 10000);
  assert.equal(goalOn(s, "h", "m1", day(7)).target, 5000);
});

// ===========================================================================
// Opting out — the cleaner version of the same cheat
// ===========================================================================

test("switching a habit off does not delete the days you already missed", () => {
  // Better than lowering the goal, and quieter: `active: false` made EVERY past day EXEMPT, and
  // the leaderboard skips exempt days. Off, then on again, and the week was gone.
  const s = badWeek([
    E(ev.goal("m1", "h", { target: 10000 }), at(0)),
    E(ev.goal("m1", "h", { target: 10000, active: false }), at(6)),
  ]);
  for (let n = 0; n < 6; n += 1) {
    assert.equal(statusOn(s, n), MISS, "day " + n + " must still count");
  }
  assert.equal(pct(s), 0);
});

test("opting out starts tomorrow, and then really does excuse you", () => {
  const s = badWeek([
    E(ev.goal("m1", "h", { target: 10000 }), at(0)),
    E(ev.goal("m1", "h", { target: 10000, active: false }), at(6)),
  ]);
  const h = s.habits.get("h");
  assert.equal(statusOn(s, 6), MISS, "the day it was switched off still counts");
  assert.equal(rawDayStatus(s, h, "m1", day(7)), EXEMPT);
  // And the screens reflect the decision immediately, because that is what was decided.
  assert.equal(isTracking(s, h, "m1"), false);
  assert.equal(isTracking(s, h, "m1", day(6)), true);
});

test("opting out on day one is honoured on day one", () => {
  const s = badWeek([E(ev.goal("m1", "h", { target: 10000, active: false }), at(0))]);
  assert.equal(statusOn(s, 0), EXEMPT);
});

// ===========================================================================
// Moving the group's number instead of your own
// ===========================================================================

test("editing the habit's target does not re-score history either", () => {
  // The same lever one level up, reachable by anybody, and it is the fallback for every member who
  // has not set a goal of their own.
  const s = badWeek([E(ev.habit("h", { ...HABIT, target: 5000 }), at(6))]);
  const h = s.habits.get("h");
  assert.equal(targetOn(h, day(3)), 10000);
  assert.equal(targetOn(h, day(6)), 10000);
  assert.equal(targetOn(h, day(7)), 5000);
  for (let n = 0; n < 7; n += 1) assert.equal(statusOn(s, n), MISS, "day " + n);
});

test("renaming a habit does not shift when its target started", () => {
  // Only the NUMBER opens a new chapter. An edit that changes an icon must not push the target's
  // start date forward, or every rename would quietly extend the old target by a day.
  const s = badWeek([E(ev.habit("h", { ...HABIT, name: "Daily steps" }), at(4))]);
  assert.equal(s.habits.get("h").targets.length, 1);
  assert.equal(targetOn(s.habits.get("h"), day(5)), 10000);
});

// ===========================================================================
// Excusing the week after the fact
// ===========================================================================

test("a week cannot be marked as travel once it is over", () => {
  // The cleanest cheat of all: no numbers to argue with, just a range of days declared away. It
  // gets the same window a log gets, and for the same reason.
  const s = badWeek([E(ev.exempt("m1", day(0), day(6), "travel"), at(6))]);
  for (let n = 0; n < 4; n += 1) {
    assert.equal(statusOn(s, n), MISS, "day " + n + " was too long ago to excuse");
  }
});

test("travel declared in advance, or just after, still works", () => {
  const ahead = badWeek([E(ev.exempt("m1", day(5), day(6), "travel"), at(2))]);
  assert.equal(statusOn(ahead, 5), EXEMPT);

  // Two days late is inside the backfill window, same as a log.
  const justAfter = badWeek([E(ev.exempt("m1", day(4), day(5), "travel"), at(6))]);
  assert.equal(statusOn(justAfter, 4), EXEMPT);
});

// ===========================================================================
// Longer periods, where "tomorrow" is not the whole answer
// ===========================================================================

test("a weekly target lowered mid-week does not re-score the week it is in", () => {
  // Next-day alone would not close this: Thursday is still inside the week that began on Monday,
  // so the goal has to be read as of the period's START.
  const weekly = { ...HABIT, name: "Workouts", metric: METRIC.SESSIONS, period: PERIOD.WEEK,
    aggregate: AGGREGATE.SUM, target: 5 };
  const events = [
    E(ev.member("m1", "Me"), at(0)),
    E(ev.habit("h", weekly), at(0)),
    E(ev.bind("m1", "h", SOURCE.MANUAL), at(0)),
    E(ev.goal("m1", "h", { target: 5 }), at(0)),
    E(ev.log("h", "m1", day(0), 1, SOURCE.MANUAL), at(0)),
    E(ev.log("h", "m1", day(1), 1, SOURCE.MANUAL), at(1)),
    // Two done, five promised, and it is Wednesday.
    E(ev.goal("m1", "h", { target: 2 }), at(2)),
  ];
  const s = replay(events);
  const h = s.habits.get("h");
  const thisWeek = periodKey(day(3), PERIOD.WEEK);
  assert.equal(rawPeriodStatus(s, h, "m1", thisWeek), MISS, "the week was promised at five");

  // The following week is theirs to set.
  const next = replay([...events, E(ev.log("h", "m1", day(7), 2, SOURCE.MANUAL), at(7))]);
  assert.equal(rawPeriodStatus(next, next.habits.get("h"), "m1", periodKey(day(7), PERIOD.WEEK)), HIT);
});

// ===========================================================================
// The honest cases still work
// ===========================================================================

test("a taper still steps down on its own schedule", () => {
  // A taper is a change agreed in advance, so it is not a change at all by this rule — and it must
  // not be pushed a day later every time it steps.
  const tapered = {
    ...HABIT, name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 20,
    aggregate: AGGREGATE.SUM, taper: { amount: 1, everyDays: 7, floor: 0 },
  };
  const s = replay([
    E(ev.member("m1", "Me"), at(0)),
    E(ev.habit("h", tapered), at(0)),
  ]);
  const h = s.habits.get("h");
  assert.equal(targetOn(h, day(0)), 20);
  assert.equal(targetOn(h, day(7)), 19);
  assert.equal(targetOn(h, day(70)), 10);
});

test("raising your own goal is not blocked, it just also waits a day", () => {
  // The rule is about WHEN, not about direction. Making it harder for yourself tomorrow is fine;
  // making yesterday easier is what was being stopped.
  const s = badWeek([
    E(ev.goal("m1", "h", { target: 8000 }), at(0)),
    E(ev.goal("m1", "h", { target: 20000 }), at(6)),
  ]);
  const h = s.habits.get("h");
  assert.equal(targetFor(s, h, "m1", day(6)), 8000);
  assert.equal(targetFor(s, h, "m1", day(7)), 20000);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ no rewriting history: " + passed + " tests passed");
