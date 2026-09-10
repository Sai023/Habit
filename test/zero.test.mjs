// zero.test.mjs — a clean day has to be sayable.
//
// ---- The bug ----
//
// Reported as "user cannot select 0 puffs for the day", which sounds like a stepper that would not
// go low enough. It went to zero perfectly well; the sheet threw the zero away on save, under a
// rule that reads as obviously correct: adding nothing is just cancelling.
//
// It is correct — when there is already a number to add nothing TO. Applied to an empty day it
// meant the one answer somebody most wants to give was the one answer the app would not take.
//
// ---- Why that is a scoring bug and not a UI bug ----
//
// A manual habit with no entry is a MISS, deliberately, and the reasoning is written out in
// habits.js: the vape keeps the count, so a quiet day is an unreported day rather than an
// unknowable one, and a habit you can score full marks on by never opening the app is not a habit.
//
// Every part of that holds. Its consequence here did not: somebody who actually managed zero got
// the identical verdict to somebody who could not face admitting to eighty. Broken streak,
// Discipline down, and — this is the part that matters — no way at all to say otherwise. The rule
// assumes a clean day is reportable. It was not.
//
// So these tests pin the distinction the engine has always been able to express and the UI could
// not: nothing logged is a miss, and a logged zero is a hit, and they are not the same day.

import assert from "node:assert/strict";
import { replay, addDays, rawPeriodStatus, valueOn, HIT, MISS, NO_DATA } from "../js/habits.js";
import { ev, METRIC, AT_LEAST, AT_MOST, AGGREGATE, SOURCE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const MON = "2026-03-02";
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T09:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "z" + ++seq, ts, seq, ...spec });

const ME = "m1";

/** The vape habit exactly as the editor's preset shapes it: a daily ceiling, counted as it happens. */
function state(logs = []) {
  return replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    E(ev.habit("puffs", {
      name: "Vape puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
      period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
    }), at(0)),
    ...logs,
  ]);
}

// ---------------------------------------------------------------------------
// The two days that used to be one day
// ---------------------------------------------------------------------------

test("saying nothing is a miss", () => {
  // Unchanged, and deliberately so. This is the rule the fix must not break: reporting is part of
  // what was agreed to, and a habit you can ace by never opening the app is not a habit.
  const s = state();
  assert.equal(valueOn(s, s.habits.get("puffs"), ME, day(1)), null);
  assert.equal(rawPeriodStatus(s, s.habits.get("puffs"), ME, day(1)), MISS);
});

test("saying zero is a hit", () => {
  // The whole bug, in one assertion. Nothing about the engine ever prevented this.
  const s = state([E(ev.log("puffs", ME, day(1), 0, "manual"), at(1))]);
  assert.equal(valueOn(s, s.habits.get("puffs"), ME, day(1)), 0);
  assert.equal(rawPeriodStatus(s, s.habits.get("puffs"), ME, day(1)), HIT);
});

test("a logged zero and an empty day are different days", () => {
  // Stated as its own test because this is the property, and the two above are only its halves.
  const quiet = state();
  const clean = state([E(ev.log("puffs", ME, day(1), 0, "manual"), at(1))]);
  assert.notEqual(
    rawPeriodStatus(quiet, quiet.habits.get("puffs"), ME, day(1)),
    rawPeriodStatus(clean, clean.habits.get("puffs"), ME, day(1)),
  );
});

// ---------------------------------------------------------------------------
// A zero survives the parts most likely to eat it
// ---------------------------------------------------------------------------

test("zero survives the event builder", () => {
  // `value: Number(value) || 0` is fine and `p({...})` keeps the key, but both are the shape of
  // code that drops zeros, and this path has three of them in a row.
  const built = ev.log("puffs", ME, day(1), 0, "manual");
  assert.equal(built.payload.value, 0);
});

test("zero survives replay", () => {
  const s = state([E(ev.log("puffs", ME, day(1), 0, "manual"), at(1))]);
  const entries = s.logs.get("puffs|" + ME + "|" + day(1));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, 0);
});

test("a zero followed by a real count adds up rather than being ignored", () => {
  // Declaring a clean morning and then having three in the evening is an ordinary sequence, and a
  // SUM habit must not treat the zero as an absence that resets anything.
  const s = state([
    E(ev.log("puffs", ME, day(1), 0, "manual"), at(1)),
    E(ev.log("puffs", ME, day(1), 3, "manual"), at(1) + 3600_000),
  ]);
  assert.equal(valueOn(s, s.habits.get("puffs"), ME, day(1)), 3);
});

test("two zeros are still zero", () => {
  const s = state([
    E(ev.log("puffs", ME, day(1), 0, "manual"), at(1)),
    E(ev.log("puffs", ME, day(1), 0, "manual"), at(1) + 3600_000),
  ]);
  assert.equal(valueOn(s, s.habits.get("puffs"), ME, day(1)), 0);
  assert.equal(rawPeriodStatus(s, s.habits.get("puffs"), ME, day(1)), HIT);
});

// ---------------------------------------------------------------------------
// The rule is about ceilings, not about zero being magic
// ---------------------------------------------------------------------------

test("zero against a floor is still a miss", () => {
  // Guards against fixing this by making zero special. Zero steps is not a clean day; it is no
  // steps. The direction of the habit is what decides, exactly as it does for every other number.
  const s = replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
      days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
    }), at(0)),
    E(ev.log("steps", ME, day(1), 0, "manual"), at(1)),
  ]);
  assert.equal(rawPeriodStatus(s, s.habits.get("steps"), ME, day(1)), MISS);
});

test("an automatic habit's silence is still not a miss", () => {
  // The other half of the rule in habits.js, asserted here so that a future change to how empty
  // days are read cannot quietly take it with it: a watch that said nothing is a pipeline being
  // quiet, not a person failing.
  const s = replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT,
      days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
    }), at(0)),
  ]);
  assert.equal(rawPeriodStatus(s, s.habits.get("steps"), ME, day(1)), NO_DATA);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ zero: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ zero: " + passed + " tests passed");
