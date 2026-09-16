// change-events.test.mjs — a habit's meaning changing over time, modelled rather than drifting:
// a dated unit, a dated name, and an analysis-exclusion marker.

import assert from "node:assert/strict";
import { replay, addDays, unitOn, nameOn, isExcluded } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, PERIOD } from "../js/schema.js";
import { dailyFacts, byWeekday, consistency, correlate } from "../js/dailyfacts.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const D0 = "2026-03-02";
const day = (n) => addDays(D0, n);
const at = (d, h = 20) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd, h - 2); };
let seq = 0;
const E = (spec, ts) => ({ eventId: "e" + String(++seq).padStart(4, "0"), ts, seq, author: "m1", ...spec });
const H = (s, id) => s.habits.get(id);

// ---------------------------------------------------------------------------
// Unit change, dated
// ---------------------------------------------------------------------------

test("a unit defaults to the metric, and a later def dates the change", () => {
  seq = 0;
  const s = replay([
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("water", { name: "Water", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 8, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    // switched to millilitres from D5
    E(ev.habit("water", { name: "Water", metric: METRIC.AMOUNT, unit: "ml", direction: AT_LEAST, target: 2000, period: PERIOD.DAY, tz: TZ }), at(day(4), 6)),
  ]);
  const h = H(s, "water");
  assert.equal(unitOn(h, day(0)), "amount", "before the change it is the metric default");
  assert.equal(unitOn(h, day(2)), "amount", "still, on the change day the old unit holds");
  assert.equal(unitOn(h, day(10)), "ml", "after, the new unit");
  assert.equal(h.history.length, 2);
});

test("the read-model never averages or correlates across a unit change", () => {
  seq = 0;
  const events = [
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("water", { name: "Water", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 8, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
  ];
  for (let n = 0; n < 5; n += 1) events.push(E(ev.log("water", "m1", day(n), 8, SOURCE.MANUAL), at(day(n)))); // glasses
  events.push(E(ev.habit("water", { name: "Water", metric: METRIC.AMOUNT, unit: "ml", direction: AT_LEAST, target: 2000, period: PERIOD.DAY, tz: TZ }), at(day(4), 22)));
  for (let n = 5; n < 12; n += 1) events.push(E(ev.log("water", "m1", day(n), 2000, SOURCE.MANUAL), at(day(n)))); // ml
  const s = replay(events);
  const facts = dailyFacts(s, { me: "m1", to: day(11) });
  // The raw table keeps both units, dated.
  assert.equal(facts.find((f) => f.day === day(0)).unit, "amount");
  assert.equal(facts.find((f) => f.day === day(11)).unit, "ml");
  // But a per-habit reduction stays inside the CURRENT unit — averaging 8 glasses with 2000 ml
  // would be nonsense. consistency/byWeekday see only the ml days.
  const c = consistency(facts, "water");
  assert.equal(c.reportedDays, 7, "only the seven ml days, not the five glass days");
});

// ---------------------------------------------------------------------------
// Rename, dated
// ---------------------------------------------------------------------------

test("a rename is dated in the history", () => {
  seq = 0;
  const s = replay([
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("v", { name: "Vape urges", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.habit("v", { name: "Vape puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, tz: TZ }), at(day(6), 6)),
  ]);
  const h = H(s, "v");
  assert.equal(nameOn(h, day(0)), "Vape urges");
  assert.equal(nameOn(h, day(10)), "Vape puffs");
});

// ---------------------------------------------------------------------------
// Exclusion, dated
// ---------------------------------------------------------------------------

function group() {
  seq = 0;
  const events = [
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.habit("test", { name: "Test habit", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 1, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
  ];
  for (let n = 0; n < 6; n += 1) {
    events.push(E(ev.log("steps", "m1", day(n), 12000, SOURCE.MANUAL), at(day(n))));
    events.push(E(ev.log("test", "m1", day(n), 1, SOURCE.MANUAL), at(day(n))));
  }
  return events;
}

test("an excluded habit drops out of the read-model but stays on the log", () => {
  const s0 = replay(group());
  assert.ok(dailyFacts(s0, { me: "m1", to: day(5) }).some((f) => f.habitId === "test"));
  const s1 = replay([...group(), E(ev.exclude({ habitId: "test" }), at(day(6), 6))]);
  assert.equal(isExcluded(s1, { habitId: "test" }), true);
  assert.equal(dailyFacts(s1, { me: "m1", to: day(5) }).some((f) => f.habitId === "test"), false, "gone from analysis");
  assert.ok(s1.habits.has("test"), "but still a real habit");
});

test("un-excluding puts it back (latest write wins)", () => {
  const s = replay([...group(),
    E(ev.exclude({ habitId: "test" }), at(day(6), 6)),
    E(ev.exclude({ habitId: "test" }, false), at(day(7), 6)),
  ]);
  assert.equal(isExcluded(s, { habitId: "test" }), false);
  assert.ok(dailyFacts(s, { me: "m1", to: day(5) }).some((f) => f.habitId === "test"));
});

test("an excluded member has no facts to mine (still tracked, just not analysed)", () => {
  const s = replay([...group(), E(ev.exclude({ memberId: "m1", reason: "gaming" }), at(day(6), 6))]);
  assert.equal(isExcluded(s, { memberId: "m1" }), true);
  assert.deepEqual(dailyFacts(s, { me: "m1", to: day(5) }), []);
  assert.ok(s.members.has("m1"), "still on the board");
});

test("exclusion follows a merge — excluding a folded-in id excludes the person", () => {
  const s = replay([...group(),
    E(ev.member("m1b", "Sahil"), at(D0, 6)),
    E(ev.mergeMember("m1b", "m1"), at(day(6), 6)),
    E(ev.exclude({ memberId: "m1b" }), at(day(7), 6)),   // exclude via the alias
  ]);
  assert.equal(isExcluded(s, { memberId: "m1" }), true, "the canonical person is excluded");
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ change events (unit / rename / exclusion): " + passed + " tests passed");
