// compare.test.mjs — the correlation between two habits.
//
// This is the payoff of putting screen time in the shared log rather than leaving it a private
// Pause statistic, and it is also the easiest place in the app to publish a confident lie. A
// comparison that quietly counts a broken pipeline as a bad day, or draws a conclusion from two
// days against one, produces a sentence people repeat. So the tests here are mostly about what it
// REFUSES to answer.

import { strict as assert } from "node:assert";
import { replay, compareDays, MIN_COMPARE_DAYS, addDays } from "../js/habits.js";
import { T, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, PERIOD, METRIC } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

let seq = 0;
const ev = (type, payload) => ({
  uuid: "e" + ++seq, type, author: "m1", ts: 1_700_000_000_000 + seq, payload,
});

const habitDef = (habitId, over) => ev(T.HABIT_DEF, {
  habitId,
  name: habitId,
  metric: METRIC.STEPS,
  aggregate: AGGREGATE.LAST,
  direction: AT_LEAST,
  target: 10000,
  period: PERIOD.DAY,
  scored: true,
  tz: "UTC",
  dayStartHour: 0,
  source: SOURCE.HEALTH_CONNECT,
  ...over,
});

const log = (habitId, day, value, source = SOURCE.HEALTH_CONNECT) =>
  ev(T.LOG, { habitId, memberId: "m1", day, value, source });

const bind = (habitId, source) => ev(T.BINDING, { habitId, memberId: "m1", source });

/**
 * The standard fixture: a screen-time gate and a steps subject, over `days` days from 2026-03-01.
 * `pattern` is one entry per day — [screenMinutes, steps] — and either may be null to mean the
 * source said nothing at all that day.
 */
function world(pattern, over = {}) {
  const events = [
    habitDef("screen", {
      metric: METRIC.SCREEN_MINUTES, direction: AT_MOST, target: 60, source: SOURCE.PAUSE,
      ...(over.screen || {}),
    }),
    habitDef("steps", over.steps || {}),
    // The BINDING is what the engine judges silence against, so an override of the habit's source
    // has to move it too — otherwise the fixture says "manual" and the engine still reads "pause".
    bind("screen", over.screen?.source || SOURCE.PAUSE),
    bind("steps", SOURCE.HEALTH_CONNECT),
  ];
  let day = "2026-03-01";
  for (const [screen, steps] of pattern) {
    if (screen !== null) events.push(log("screen", day, screen, over.screen?.source || SOURCE.PAUSE));
    if (steps !== null) events.push(log("steps", day, steps));
    day = addDays(day, 1);
  }
  return { state: replay(events), from: "2026-03-01", to: addDays(day, -1) };
}

const run = (w) => compareDays(w.state, "screen", "steps", "m1", w.from, w.to);

// ---------------------------------------------------------------------------
// The thing it is for
// ---------------------------------------------------------------------------

test("splits the subject's days by whether the gate was met", () => {
  // Four under the screen limit, four over. Steps are cleanly different across the split.
  const w = world([
    [30, 12000], [40, 14000], [20, 13000], [50, 13000],
    [90, 6000], [120, 4000], [200, 5000], [95, 5000],
  ]);
  const r = run(w);
  assert.equal(r.met.days, 4);
  assert.equal(r.missed.days, 4);
  assert.equal(r.met.average, 13000);
  assert.equal(r.missed.average, 5000);
});

test("delta is signed by the subject's own direction, not by arithmetic", () => {
  // Steps are a build habit: more on the good days is a positive delta.
  const up = run(world([
    [30, 12000], [30, 12000], [30, 12000], [30, 12000],
    [90, 8000], [90, 8000], [90, 8000], [90, 8000],
  ]));
  assert.equal(up.delta, 4000);

  // Vape puffs are a reduce habit: FEWER on the good days is also a positive delta. Reporting
  // that as -20 would have the card announcing an improvement as a decline.
  const down = run(world([
    [30, 10], [30, 10], [30, 10], [30, 10],
    [90, 30], [90, 30], [90, 30], [90, 30],
  ], { steps: { metric: METRIC.PUFFS, direction: AT_MOST, target: 20, aggregate: AGGREGATE.LAST } }));
  assert.equal(down.delta, 20);
});

test("ratio is null rather than Infinity when the bad days had nothing at all", () => {
  const r = run(world([
    [30, 8000], [30, 8000], [30, 8000], [30, 8000],
    [90, 0], [90, 0], [90, 0], [90, 0],
  ]));
  assert.equal(r.missed.average, 0);
  assert.equal(r.ratio, null);
});

// ---------------------------------------------------------------------------
// What it refuses to answer
// ---------------------------------------------------------------------------

test("refuses below the minimum on either side", () => {
  assert.equal(MIN_COMPARE_DAYS, 4);
  // Four good days, three bad. Plenty tempting, and not enough.
  const r = run(world([
    [30, 12000], [30, 12000], [30, 12000], [30, 12000],
    [90, 4000], [90, 4000], [90, 4000],
  ]));
  assert.equal(r, null);
});

test("a silent automatic gate is not a bad day", () => {
  // Screen time reported nothing for four days — the phone was off, or Pause was killed. With the
  // habit bound to an automatic source those days are NO_DATA, and folding them into the "missed"
  // side is precisely the mistake the four-state model exists to stop. Without them there are only
  // four judged days, so the honest answer is no answer.
  const w = world([
    [30, 12000], [30, 12000], [30, 12000], [30, 12000],
    [null, 4000], [null, 4000], [null, 4000], [null, 4000],
  ]);
  assert.equal(run(w), null);
});

test("a silent MANUAL FLOOR is a bad day, because that is what silence means there", () => {
  // The mirror of the case above, and the reason the gate here is a floor rather than a ceiling.
  // "Read for twenty minutes" is a thing you DO: a day with nothing recorded is a day it did not
  // happen, so those days are judged, and the comparison can be made. A ceiling gets the opposite
  // answer, which the next test pins.
  const events = [
    habitDef("reading", {
      metric: null, direction: AT_LEAST, target: 20, source: SOURCE.MANUAL,
    }),
    habitDef("steps"),
    bind("reading", SOURCE.MANUAL),
    bind("steps", SOURCE.HEALTH_CONNECT),
  ];
  let day = "2026-03-01";
  for (const [read, steps] of [
    [30, 12000], [30, 12000], [30, 12000], [30, 12000],
    [null, 4000], [null, 4000], [null, 4000], [null, 4000],
  ]) {
    if (read !== null) events.push(log("reading", day, read, SOURCE.MANUAL));
    events.push(log("steps", day, steps));
    day = addDays(day, 1);
  }
  const r = compareDays(replay(events), "reading", "steps", "m1", "2026-03-01", addDays(day, -1));
  assert.equal(r.missed.days, 4);
  assert.equal(r.missed.average, 4000);
});

test("a silent MANUAL ceiling is a bad day too, and can gate", () => {
  // Ceilings are not the exception they briefly looked like. Where somebody undertook to enter the
  // number themselves, a blank day is a day they did not, in either direction.
  const w = world([
    [30, 12000], [30, 12000], [30, 12000], [30, 12000],
    [null, 4000], [null, 4000], [null, 4000], [null, 4000],
  ], { screen: { source: SOURCE.MANUAL } });
  const r = run(w);
  assert.equal(r.missed.days, 4);
  assert.equal(r.missed.average, 4000);
});

test("days the subject reported nothing are dropped, not counted as zero", () => {
  // Four good days where the watch also died. Averaging those in as zero would invent a finding
  // out of an outage — and outages are not random, since a phone that is off reports neither.
  const w = world([
    [30, null], [30, null], [30, null], [30, null],
    [90, 4000], [90, 4000], [90, 4000], [90, 4000],
  ]);
  assert.equal(run(w), null);
});

test("refuses a gate that is not judged daily", () => {
  // "Three workouts a week" against Tuesday's steps is a category error. It has to refuse rather
  // than pair a week's verdict with each of its days.
  const w = world([
    [30, 12000], [30, 12000], [30, 12000], [30, 12000],
    [90, 4000], [90, 4000], [90, 4000], [90, 4000],
  ], { screen: { period: PERIOD.WEEK } });
  assert.equal(run(w), null);
});

test("refuses to compare a habit with itself", () => {
  const w = world([
    [30, 12000], [30, 12000], [30, 12000], [30, 12000],
    [90, 4000], [90, 4000], [90, 4000], [90, 4000],
  ]);
  assert.equal(compareDays(w.state, "steps", "steps", "m1", w.from, w.to), null);
  assert.equal(compareDays(w.state, "screen", "nope", "m1", w.from, w.to), null);
});

test("another member's days do not leak into yours", () => {
  // The comparison is per member. m2 living entirely differently must not move m1's average.
  const w = world([
    [30, 12000], [30, 12000], [30, 12000], [30, 12000],
    [90, 4000], [90, 4000], [90, 4000], [90, 4000],
  ]);
  const mine = run(w);
  const theirs = compareDays(w.state, "screen", "steps", "m2", w.from, w.to);
  assert.equal(mine.met.average, 12000);
  assert.equal(theirs, null);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ habit comparison: " + passed + " tests passed");
