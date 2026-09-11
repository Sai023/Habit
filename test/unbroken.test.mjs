// unbroken.test.mjs — naming a habit nobody has ever missed.
//
// ---- What it is for ----
//
// A category is the MEAN of its habits, so a habit somebody cannot fail lifts the ones they can.
// It is worse than it first looks: a ceiling scores its maximum bonus when you are furthest under
// it, so a limit that costs nothing pays the largest bonus available and then drags the category up
// behind it. Measured on two people failing the same real habit equally — 200 minutes against a
// 120-minute ceiling, both of them — the one who also tracks a vape habit she has never used scored
// 57% on Discipline against 50% for the one who spent his whole puff allowance. Opting out would
// have taken her to 0%, so the app was paying her to keep it.
//
// ---- Why nothing here changes a score ----
//
// Because changing the arithmetic moves every day anybody has ever played, and this is a group of
// three people mid-season. The board already does exactly this for the mirror-image problem: "3 not
// reported" sits beside a percentage it deliberately does not affect, because silence was the
// cheapest way to avoid a bad week and the answer was to make it visible rather than to punish it.
//
// So the tests below are about honesty and restraint, not about points. What must hold is that it
// fires when the fact is real, stays quiet when it is not yet, and never says anything the group
// has not already agreed everybody can see.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { neverMissed, UNBROKEN_MIN } from "../js/history.js";
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
const E = (spec, ts) => ({ eventId: "n" + ++seq, ts, seq, ...spec });

const ME = "m1";

const PUFFS = ev.habit("puffs", {
  name: "Vape puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
  period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
  days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
});

const GYM = ev.habit("gym", {
  name: "Workouts", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3,
  period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
  days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
});

/** A habit the group does NOT compete on — calories, which SCORED_METRICS leaves out. */
const CALS = ev.habit("cals", {
  name: "Calories burned", metric: METRIC.ACTIVE_CALORIES, direction: AT_LEAST, target: 400,
  period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
  days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
});

function state(habits, logs = [], extra = []) {
  return replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    ...habits.map((h) => E(h, at(0))),
    ...logs,
    ...extra,
  ]);
}

/**
 * n clean days, starting at the habit's FIRST day.
 *
 * From day zero, not day one, and that is not a detail. The day a habit is created is judged like
 * any other, so a manual habit with nothing logged on the day it was made has already missed once
 * — permanently, as far as this function is concerned. My first draft of these tests started on
 * day one and every positive case failed, which is worth knowing about the real app too: somebody
 * who adds a habit in the evening and does not log it that night can never be "never missed".
 *
 * It logs days 0..n-1, so every test asks about day(n) — which leaves day n OPEN and therefore
 * unjudged, and everything before it closed and clean. Asking a day later adds one unlogged closed
 * day, which is a MISS, which is the same mistake wearing a different hat. Both drafts of this
 * fixture made one of the two.
 */
const clean = (n, id = "puffs", v = 0) => {
  const out = [];
  for (let d = 0; d < n; d += 1) out.push(E(ev.log(id, ME, day(d), v, "manual"), at(d)));
  return out;
};

const names = (list) => list.map((x) => x.habit.name);

// ---------------------------------------------------------------------------
// Saying it when it is true
// ---------------------------------------------------------------------------

test("a long clean run is named", () => {
  const s = state([PUFFS], clean(30));
  const found = neverMissed(s, ME, day(30));
  assert.deepEqual(names(found), ["Vape puffs"]);
  assert.equal(found[0].periods, 30);
});

test("one miss anywhere in the record silences it for good", () => {
  // Not "recently unmissed" — never missed. A run that broke once is a streak, and the board
  // already has streaks.
  const s = state([PUFFS], [
    ...clean(30),
    E(ev.log("puffs", ME, day(30), 500, "manual"), at(30)),
    ...(() => { const o = []; for (let d = 31; d < 60; d += 1) o.push(E(ev.log("puffs", ME, day(d), 0, "manual"), at(d))); return o; })(),
  ]);
  assert.deepEqual(names(neverMissed(s, ME, day(60))), []);
});

test("the longest comes first", () => {
  // Long enough that BOTH clear their own bar: 49 days is seven whole weeks, and the weekly bar
  // is six. Forty days looked like plenty and gave the gym only five, so only one habit came back.
  const s = state([PUFFS, GYM], [
    ...clean(49),
    ...(() => {
      const o = [];
      for (let d = 0; d < 49; d += 1) o.push(E(ev.log("gym", ME, day(d), 1, "manual"), at(d)));
      return o;
    })(),
  ]);
  const found = neverMissed(s, ME, day(49));
  assert.equal(found.length, 2, "both are unmissed");
  assert.ok(found[0].periods >= found[1].periods, "longest first");
  assert.equal(found[0].habit.name, "Vape puffs", "49 days beats 7 weeks");
});

// ---------------------------------------------------------------------------
// Staying quiet when it is not yet a fact
// ---------------------------------------------------------------------------

test("a few good days is not a fact about anybody", () => {
  const s = state([PUFFS], clean(UNBROKEN_MIN[PERIOD.DAY] - 1));
  assert.deepEqual(names(neverMissed(s, ME, day(UNBROKEN_MIN[PERIOD.DAY] - 1))), []);
});

test("and the day it crosses, it is", () => {
  const n = UNBROKEN_MIN[PERIOD.DAY];
  const s = state([PUFFS], clean(n));
  assert.deepEqual(names(neverMissed(s, ME, day(n))), ["Vape puffs"]);
});

test("a weekly habit is judged in weeks, not days", () => {
  // Six weeks of workouts is a long time; six DAYS of it is nothing. Using one threshold for both
  // would either shout about a fortnight-old weekly habit or never mention a daily one.
  const logs = [];
  for (let d = 0; d < 21; d += 1) logs.push(E(ev.log("gym", ME, day(d), 1, "manual"), at(d)));
  const s = state([GYM], logs);
  assert.deepEqual(names(neverMissed(s, ME, day(21))), [], "three whole weeks is under the bar");
  assert.ok(UNBROKEN_MIN[PERIOD.WEEK] > 3, "and the bar is where the test thinks it is");
});

test("a habit with nothing logged at all says nothing", () => {
  const s = state([PUFFS]);
  assert.deepEqual(names(neverMissed(s, ME, day(30))), []);
});

// ---------------------------------------------------------------------------
// Restraint
// ---------------------------------------------------------------------------

test("a habit they opted out of is not named", () => {
  // They are not competing on it. Naming it would be gossip about something that cannot affect
  // anybody's score.
  const s = state([PUFFS], clean(30), [E(ev.goal(ME, "puffs", { active: false }), at(29))]);
  assert.deepEqual(names(neverMissed(s, ME, day(30))), []);
});

test("an unscored habit is not named however clean it is", () => {
  // Calories sits outside all four categories by the group's own rule, so it cannot lift anything
  // and there is nothing for the board to explain.
  const s = state([CALS], clean(40, "cals", 900));
  assert.deepEqual(names(neverMissed(s, ME, day(40))), []);
});

test("nothing in the result carries a value", () => {
  // What the group sees of somebody's numbers is that person's own choice, and this must not route
  // around it. A COUNT of periods is already public — the board has always shown "5/7 days".
  const s = state([PUFFS], clean(30));
  const found = neverMissed(s, ME, day(30));
  assert.deepEqual(Object.keys(found[0]).sort(), ["habit", "period", "periods"]);
});

test("it answers the same way for every member, including the reader", () => {
  // Symmetry is what stops this being an accusation tool. A panel that only ever named other
  // people would be one.
  const s = replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    E(ev.member("m2", "Anj"), at(0)),
    E(PUFFS, at(0)),
    ...clean(30),
    ...(() => {
      const o = [];
      for (let d = 0; d < 30; d += 1) o.push(E(ev.log("puffs", "m2", day(d), 0, "manual"), at(d)));
      return o;
    })(),
  ]);
  assert.deepEqual(names(neverMissed(s, ME, day(30))), ["Vape puffs"]);
  assert.deepEqual(names(neverMissed(s, "m2", day(30))), ["Vape puffs"]);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ unbroken: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ unbroken: " + passed + " tests passed");
