// dailyfacts.test.mjs — the analytical read-model and the patterns it unlocks.
//
// The fixture is a designed month: steps and puffs move together (fewer puffs on the days steps
// are hit), Fridays are the weak weekday, screen time is a flat control that correlates with
// nothing, and one day is exempt so we can prove a holiday is not counted as a collapse.

import assert from "node:assert/strict";
import { replay, addDays, HIT, MISS, EXEMPT } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, PERIOD, AGGREGATE } from "../js/schema.js";
import {
  dailyFacts, byWeekday, correlate, topCorrelations, consistency, MIN_PER_SIDE,
} from "../js/dailyfacts.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const D0 = "2026-03-02"; // a Monday
const day = (n) => addDays(D0, n);
const at = (d, h = 20) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd, h - 2); };
let seq = 0;
const E = (spec, ts) => ({ eventId: "e" + String(++seq).padStart(4, "0"), ts, seq, author: "m1", ...spec });

const MISS_DAYS = new Set([2, 4, 9, 11, 18]); // Wed D2, Fri D4, Wed D9, Fri D11, Fri D18

function build({ days = 21, exemptDay = 20 } = {}) {
  seq = 0;
  const events = [
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, period: PERIOD.DAY, aggregate: AGGREGATE.LAST, tz: TZ }), at(D0, 6)),
    E(ev.habit("puffs", { name: "Vape", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, aggregate: AGGREGATE.SUM, tz: TZ }), at(D0, 6)),
    E(ev.habit("screen", { name: "Screen", metric: METRIC.SCREEN_MINUTES, direction: AT_MOST, target: 90, period: PERIOD.DAY, aggregate: AGGREGATE.LAST, tz: TZ }), at(D0, 6)),
  ];
  for (let n = 0; n < days; n += 1) {
    const miss = MISS_DAYS.has(n);
    events.push(E(ev.log("steps", "m1", day(n), miss ? 6000 : 12000, SOURCE.MANUAL), at(day(n))));
    events.push(E(ev.log("puffs", "m1", day(n), miss ? 90 : 40, SOURCE.MANUAL), at(day(n))));
    events.push(E(ev.log("screen", "m1", day(n), 30, SOURCE.MANUAL), at(day(n))));
  }
  if (exemptDay != null) events.push(E(ev.exempt("m1", day(exemptDay), day(exemptDay), "travel"), at(D0, 7)));
  return replay(events);
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

test("dailyFacts projects one row per tracked day-habit per day, from the join day", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", to: day(20) });
  assert.equal(facts.length, 3 * 21, "three habits over twenty-one days");
  const d0 = facts.find((f) => f.habitId === "steps" && f.day === day(0));
  assert.equal(d0.status, HIT);
  assert.equal(d0.value, 12000);
  assert.equal(d0.met, true);
  assert.equal(d0.weekday, "Monday");
  assert.equal(d0.dow, 1);
  assert.equal(d0.method, "typed", "a typed number's provenance is 'typed'");
  assert.equal(d0.confidence, 0.6, "and it is weighted below a measurement");
});

test("a Friday miss lands as MISS, not NO_DATA, and carries the weekday", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", to: day(20) });
  const fri = facts.find((f) => f.habitId === "steps" && f.day === day(4));
  assert.equal(fri.weekday, "Friday");
  assert.equal(fri.status, MISS);
  assert.equal(fri.value, 6000);
});

test("an exempt day is marked exempt and is neither hit nor miss", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", to: day(20) });
  const ex = facts.find((f) => f.habitId === "steps" && f.day === day(20));
  assert.equal(ex.exempt, true);
  assert.equal(ex.status, EXEMPT);
});

test("a habit is absent before its birthday rather than a run of misses", () => {
  // Add a fourth habit born on D10; it should have facts only from D10.
  const events = [];
  const base = build();
  // Rebuild with an extra late habit.
  seq = 0;
  const evs = [
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.habit("late", { name: "Late", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, tz: TZ }), at(day(10), 6)),
  ];
  for (let n = 0; n <= 12; n += 1) evs.push(E(ev.log("steps", "m1", day(n), 12000, SOURCE.MANUAL), at(day(n))));
  for (let n = 10; n <= 12; n += 1) evs.push(E(ev.log("late", "m1", day(n), 5, SOURCE.MANUAL), at(day(n))));
  const s = replay(evs);
  const facts = dailyFacts(s, { me: "m1", to: day(12) });
  const late = facts.filter((f) => f.habitId === "late");
  assert.equal(late.length, 3, "only D10, D11, D12");
  assert.equal(late[0].day, day(10));
});

// ---------------------------------------------------------------------------
// Weekday pattern
// ---------------------------------------------------------------------------

test("byWeekday finds Friday as the weakest day and full days as strongest", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", to: day(20) });
  const wk = byWeekday(facts, "steps");
  assert.equal(wk.weakest.weekday, "Friday");
  assert.equal(wk.weakest.metRate, 0, "every Friday was a miss");
  assert.equal(wk.strongest.metRate, 1, "the strongest weekday was never missed");
});

test("byWeekday says nothing about a weekday below the sample floor", () => {
  const s = build();
  // Only the first 8 days: each weekday appears at most twice, under MIN_PER_WEEKDAY.
  const facts = dailyFacts(s, { me: "m1", from: day(0), to: day(7) });
  const wk = byWeekday(facts, "steps");
  assert.equal(wk.strongest, null, "no weekday has enough samples yet");
});

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

test("correlate reads the designed link: fewer puffs on the days steps were hit", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", to: day(20) });
  const r = correlate(facts, "steps", "puffs");
  assert.ok(r, "enough days each side");
  assert.equal(r.missed.days, 5, "five days steps were missed");
  assert.equal(r.missed.avg, 90);
  assert.equal(r.met.avg, 40);
  // Signed by the subject's direction: puffs is a ceiling, so "40 vs 90" is an improvement → +50.
  assert.equal(r.delta, 50);
  assert.equal(r.effect, 50);
});

test("correlate is directional and normalises effect for ranking", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", to: day(20) });
  const stepsGate = correlate(facts, "steps", "puffs"); // relative 50/90
  const puffsGate = correlate(facts, "puffs", "steps"); // relative 6000/6000 = 1
  assert.ok(puffsGate.relative > stepsGate.relative);
  assert.equal(puffsGate.delta, 6000, "steps higher on the days the vape stayed under");
});

test("correlate returns null below the per-side floor", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", from: day(0), to: day(4) }); // only 2 missed days
  assert.equal(correlate(facts, "steps", "puffs"), null);
});

test("topCorrelations ranks the real link above the flat control", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", to: day(20) });
  const top = topCorrelations(facts, { limit: 5 });
  assert.equal(top[0].gateHabitId, "puffs");
  assert.equal(top[0].subjectHabitId, "steps");
  // Screen time is constant, so no pair involving it moved anything and it cannot rank.
  assert.ok(!top.some((r) => r.gateHabitId === "screen" && r.effect > 0 && r.relative > 0.0001));
});

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

test("consistency reports met-rate, runs and gaps, excluding exempt days", () => {
  const s = build();
  const facts = dailyFacts(s, { me: "m1", to: day(20) });
  const c = consistency(facts, "steps");
  assert.equal(c.reportedDays, 20, "21 days minus the one exempt day");
  assert.equal(c.metDays, 15, "16 hits minus the exempt hit");
  assert.equal(Math.round(c.metRate * 100), 75);
  assert.ok(c.longestGap >= 1);
  assert.ok(c.longestStreak >= 3);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ daily facts read-model: " + passed + " tests passed");
