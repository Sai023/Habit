// meter.test.mjs — a vape is a meter.
//
// The puff counter on a vape never resets: 1,002 tonight, 1,104 tomorrow night, and the day's
// puffs are the difference. The sheet asks for the counter and works the day out; the log still
// carries the day's puffs as its value, so nothing downstream learned a new rule. These pin the
// arithmetic at its edges — the first reading, a night skipped, a new device, a correction — and
// that the reading rides on the wire.

import assert from "node:assert/strict";
import {
  replay, addDays, rawDayStatus, valueOn, lastReading, meterEntry, HIT, MISS,
  looksLikeCounterReading, COUNTER_SUSPECT_FLOOR, COUNTER_SUSPECT_MULT,
} from "../js/habits.js";
import { ev, METRIC, AT_MOST, AGGREGATE, SOURCE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const MON = "2026-03-02";
const day = (n) => addDays(MON, n);
const at = (n, h = 21) => Date.parse(day(n) + "T" + String(h).padStart(2, "0") + ":00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "v" + ++seq, ts, seq, ...spec });
const ME = "m1";

const world = (extra = []) => replay([
  E(ev.member(ME, "Me"), at(0)),
  E(ev.habit("puffs", {
    name: "Vape puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 120,
    period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
  }), at(0)),
  E(ev.bind(ME, "puffs", SOURCE.MANUAL), at(0)),
  ...extra,
]);
/** A day's puffs, with the counter it was read off. */
const entry = (n, puffs, reading) => E(ev.log("puffs", ME, day(n), puffs, SOURCE.MANUAL, null, reading), at(n));
const habitOf = (s) => s.habits.get("puffs");

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

test("the example: 1,002 tonight, 1,104 tomorrow, 102 puffs tomorrow", () => {
  const plan = meterEntry(1104, { day: day(0), reading: 1002 }, day(1));
  assert.equal(plan.puffs, 102);
  assert.equal(plan.days, 1);
  assert.equal(plan.reset, false);
  assert.deepEqual(plan.perDay, [{ day: day(1), value: 102 }]);
});

test("the first reading is a baseline and counts nothing", () => {
  // The counter has been running for months; its number is not today's.
  const plan = meterEntry(1002, null, day(0));
  assert.equal(plan.baseline, true);
  assert.equal(plan.puffs, 0);
  assert.deepEqual(plan.perDay, [{ day: day(0), value: 0 }]);
});

test("a night skipped spreads the difference over the days, and the shares add up exactly", () => {
  // 1,002 on Monday, 1,205 on Thursday: 203 over three days.
  const plan = meterEntry(1205, { day: day(0), reading: 1002 }, day(3));
  assert.equal(plan.days, 3);
  assert.equal(plan.puffs, 203);
  assert.deepEqual(plan.perDay.map((d) => d.day), [day(1), day(2), day(3)]);
  assert.equal(plan.perDay.reduce((n, d) => n + d.value, 0), 203, "nothing lost to rounding");
  assert.deepEqual(plan.perDay.map((d) => d.value), [67, 67, 69], "the last day takes the remainder");
});

test("on the baseline's own day, a higher reading later is the puffs since it; a lower one is a correction", () => {
  const baseline = { day: day(0), reading: 367 };
  const evening = meterEntry(400, null, day(0), baseline);
  assert.equal(evening.sinceBaseline, true);
  assert.equal(evening.puffs, 33);
  assert.deepEqual(evening.perDay, [{ day: day(0), value: 33 }]);
  const corrected = meterEntry(360, null, day(0), baseline);
  assert.equal(corrected.baseline, true);
  assert.equal(corrected.puffs, 0);
  assert.equal(meterEntry(400, null, day(1), null).baseline, true);
});

test("a reading below the last one is a new device, charged with its own count", () => {
  const plan = meterEntry(40, { day: day(0), reading: 1002 }, day(1));
  assert.equal(plan.reset, true);
  assert.equal(plan.puffs, 40);
});

test("garbage in reads as zero, never negative", () => {
  assert.equal(meterEntry("abc", null, day(0)).puffs, 0);
  assert.equal(meterEntry(-5, null, day(0)).puffs, 0);
});

// ---------------------------------------------------------------------------
// On the wire and in the log
// ---------------------------------------------------------------------------

test("the reading rides on the log entry and the value is still the day's puffs", () => {
  const s = world([entry(0, 1002, 1002), entry(1, 102, 1104)]);
  assert.equal(valueOn(s, habitOf(s), ME, day(1)), 102, "scoring reads puffs, not the counter");
  assert.equal(rawDayStatus(s, habitOf(s), ME, day(1)), HIT, "102 is under the 120 ceiling");
  const last = lastReading(s, habitOf(s), ME, day(2));
  assert.equal(last.reading, 1104);
  assert.equal(last.day, day(1));
});

test("the last reading is the one before the day asked about, so a correction subtracts the right number", () => {
  const s = world([entry(0, 1002, 1002), entry(1, 102, 1104)]);
  // Correcting Tuesday's entry must work from Monday's reading, not from Tuesday's own.
  assert.equal(lastReading(s, habitOf(s), ME, day(1)).reading, 1002);
});

test("a log without a reading is ignored as a reading, not read as zero", () => {
  // A puff count typed the old way, before the sheet asked for the counter.
  const s = world([E(ev.log("puffs", ME, day(0), 90, SOURCE.MANUAL), at(0))]);
  assert.equal(lastReading(s, habitOf(s), ME, day(1)), null);
  assert.equal(valueOn(s, habitOf(s), ME, day(0)), 90, "and still counts as the day it was");
});

test("a sensor row never counts as a reading", () => {
  const s = world([E(ev.log("puffs", ME, day(0), 50, SOURCE.HEALTH_CONNECT, null, 999), at(0))]);
  assert.equal(lastReading(s, habitOf(s), ME, day(1)), null);
});

test("a corrected reading replaces the day's puffs, even on a habit that adds", () => {
  // The real habit aggregates as SUM. Saving a reading withdraws the day's typed entries first
  // (store.logMeter), so the corrected difference is the day's number and not a second helping.
  const sum = replay([
    E(ev.member(ME, "Me"), at(0)),
    E(ev.habit("puffs", {
      name: "Vape puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 120,
      period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
    }), at(0)),
    E(ev.bind(ME, "puffs", SOURCE.MANUAL), at(0)),
    entry(0, 1002, 1002),
    entry(1, 102, 1104),
    // Mistyped; the counter actually said 1,100. The sheet's save: withdraw, then write.
    E(ev.clearLog("puffs", ME, day(1), SOURCE.MANUAL), at(1, 22)),
    E(ev.log("puffs", ME, day(1), 98, SOURCE.MANUAL, null, 1100), at(1, 22) + 1),
  ]);
  assert.equal(valueOn(sum, habitOf(sum), ME, day(1)), 98, "replaced, not added");
  assert.equal(lastReading(sum, habitOf(sum), ME, day(2)).reading, 1100, "and tomorrow subtracts the corrected one");
});

test("an over-ceiling difference is still a miss — the counter does not soften the rule", () => {
  const s = world([entry(0, 1002, 1002), entry(1, 150, 1152)]);
  assert.equal(rawDayStatus(s, habitOf(s), ME, day(1)), MISS);
});

// ---------------------------------------------------------------------------
// The counter-vs-count guard: a counter number typed as a day's puffs is caught
// ---------------------------------------------------------------------------
//
// The trap a real friend hit: the vape counter reads 3,174, that number gets typed into "puffs
// today", and because puffs SUM it lands as one 3,174-puff day that re-entering cannot pull back
// down. looksLikeCounterReading is the pure tripwire the log sheet consults before saving a direct
// entry — a soft check for a confirm, so it must catch a counter and leave a real bad day alone.

test("a counter-sized number typed as today's puffs is flagged", () => {
  assert.equal(looksLikeCounterReading(3174, 80), true, "3,174 against a goal of 80 is the counter");
  assert.equal(looksLikeCounterReading(3348, 80), true);
});

test("a plausible day — even a bad one — is not flagged", () => {
  assert.equal(looksLikeCounterReading(8, 80), false, "a normal day");
  assert.equal(looksLikeCounterReading(200, 80), false, "a wretched day is still dozens, not thousands");
  assert.equal(looksLikeCounterReading(80, 80), false, "exactly on the ceiling");
});

test("the threshold is fifteen times the goal, with a floor for a tiny or unset goal", () => {
  const t = 80;
  assert.equal(looksLikeCounterReading(t * COUNTER_SUSPECT_MULT - 1, t), false, "just under trips nothing");
  assert.equal(looksLikeCounterReading(t * COUNTER_SUSPECT_MULT, t), true, "at the multiple it does");
  // A goal of zero/unset falls back to the absolute floor, so a lone counter still gets caught.
  assert.equal(looksLikeCounterReading(COUNTER_SUSPECT_FLOOR - 1, 0), false);
  assert.equal(looksLikeCounterReading(COUNTER_SUSPECT_FLOOR, 0), true);
  assert.equal(looksLikeCounterReading(COUNTER_SUSPECT_FLOOR, undefined), true, "unset goal uses the floor");
});

test("junk and nothing never flag", () => {
  assert.equal(looksLikeCounterReading(0, 80), false);
  assert.equal(looksLikeCounterReading(-5, 80), false);
  assert.equal(looksLikeCounterReading(NaN, 80), false);
  assert.equal(looksLikeCounterReading("", 80), false);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ meter: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ meter: " + passed + " tests passed");
