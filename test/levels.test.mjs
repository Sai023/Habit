// levels.test.mjs — lifetime XP and levels.
//
// The curve is arithmetic and the walk is the engine's own day score, so most of what can go wrong
// is at the edges: the day a level begins, the last level, today not counting, a later joiner not
// being credited with days before they arrived. Each is pinned.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AGGREGATE, PERIOD } from "../js/schema.js";
import {
  LEVEL_MAX, FIRST_GAP, GAP_STEP, TITLES, gapTo, thresholdFor, titleFor, levelFor, lifetime,
} from "../js/levels.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

// ---------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------

test("each level asks 25 more than the last, from 300", () => {
  assert.equal(gapTo(1), 0);
  assert.equal(gapTo(2), FIRST_GAP);
  assert.equal(gapTo(3), FIRST_GAP + GAP_STEP);
  assert.equal(gapTo(100), FIRST_GAP + GAP_STEP * 98);
});

test("thresholds are the running sum of the gaps", () => {
  assert.equal(thresholdFor(1), 0);
  assert.equal(thresholdFor(2), 300);
  assert.equal(thresholdFor(3), 625);
  assert.equal(thresholdFor(10), 3600);
  assert.equal(thresholdFor(100), 150975, "the top, about five years at 85 a day");
  let sum = 0;
  for (let l = 2; l <= LEVEL_MAX; l += 1) { sum += gapTo(l); assert.equal(thresholdFor(l), sum); }
});

test("a level begins ON its threshold, not one past it", () => {
  assert.equal(levelFor(299).level, 1);
  assert.equal(levelFor(300).level, 2);
  assert.equal(levelFor(624).level, 2);
  assert.equal(levelFor(625).level, 3);
});

test("the bar and the sentence agree", () => {
  const l = levelFor(400);
  assert.equal(l.level, 2);
  assert.equal(l.at, 300);
  assert.equal(l.next, 625);
  assert.equal(l.into, 100);
  assert.equal(l.span, 325);
  assert.equal(l.need, 225, "what the screen states: 225 XP to Level 3");
  assert.equal(l.pct, 30);
});

test("level 100 is the top: full bar, nothing to need, and more XP changes nothing", () => {
  const top = levelFor(150975);
  assert.equal(top.level, 100);
  assert.equal(top.max, true);
  assert.equal(top.next, null);
  assert.equal(top.need, 0);
  assert.equal(top.pct, 100);
  assert.equal(levelFor(999999).level, 100);
});

test("titles change every ten levels and a level between keeps the lower", () => {
  assert.equal(titleFor(1), "Starter");
  assert.equal(titleFor(9), "Starter");
  assert.equal(titleFor(10), "Regular");
  assert.equal(titleFor(19), "Regular");
  assert.equal(titleFor(50), "Relentless");
  assert.equal(titleFor(100), "Legend");
  assert.equal(TITLES.length, 11);
});

test("garbage in reads as level 1, not a crash", () => {
  assert.equal(levelFor(null).level, 1);
  assert.equal(levelFor(-50).level, 1);
  assert.equal(levelFor("abc").level, 1);
});

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

const TZ = "UTC";
const MON = "2026-03-02";
const day = (n) => addDays(MON, n);
const at = (n, h = 12) => Date.parse(day(n) + "T" + String(h).padStart(2, "0") + ":00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "l" + ++seq, ts, seq, ...spec });

/** One steps habit, automatic, so an unlogged day is NO_DATA rather than a miss. */
const world = (extra = []) => replay([
  E(ev.meta({ tz: TZ }), at(0)),
  E(ev.member("me", "Me"), at(0)),
  E(ev.habit("steps", {
    name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
    period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT, tz: TZ, dayStartHour: 0,
  }), at(0)),
  E(ev.bind("me", "steps", SOURCE.HEALTH_CONNECT), at(0)),
  ...extra,
]);
const hit = (who, n) => E(ev.log("steps", who, day(n), 10000, SOURCE.HEALTH_CONNECT), at(n, 20));
const half = (who, n) => E(ev.log("steps", who, day(n), 5000, SOURCE.HEALTH_CONNECT), at(n, 20));

test("closed days bank; today rides along separately", () => {
  const s = world([hit("me", 0), hit("me", 1), hit("me", 2), half("me", 3)]);
  const l = lifetime(s, "me", day(3));
  assert.equal(l.banked, 300, "three perfect days");
  assert.equal(l.days, 3);
  assert.equal(l.today, 50, "half a day so far, not yet counted");
  assert.equal(l.level, 2, "300 is exactly level 2 — and it happened overnight");
  assert.equal(l.levelUpToday, false);
});

test("today alone can be a level-up in waiting", () => {
  const s = world([hit("me", 0), hit("me", 1), hit("me", 2)]);
  // Two closed days = 200. Today is perfect so far: 300 at midnight, which is Level 2.
  const l = lifetime(s, "me", day(2));
  assert.equal(l.banked, 200);
  assert.equal(l.level, 1);
  assert.equal(l.today, 100);
  assert.equal(l.levelUpToday, true);
});

test("an unreported day adds nothing and costs nothing", () => {
  const s = world([hit("me", 0), hit("me", 2)]);
  const l = lifetime(s, "me", day(3));
  assert.equal(l.banked, 200);
  assert.equal(l.days, 2, "the silent day is not a day played");
});

test("a bad day adds zero, never less — XP only goes up", () => {
  const s = world([hit("me", 0), E(ev.log("steps", "me", day(1), 100, SOURCE.HEALTH_CONNECT), at(1, 20))]);
  assert.equal(lifetime(s, "me", day(2)).banked, 101, "1% of a day is still 1 XP");
  assert.equal(lifetime(s, "me", day(2)).banked >= lifetime(s, "me", day(1)).banked, true);
});

test("a later joiner counts from the day they joined, not from the group's first day", () => {
  const s = world([
    hit("me", 0), hit("me", 1), hit("me", 2),
    E(ev.member("late", "Late"), at(2)),
    E(ev.bind("late", "steps", SOURCE.HEALTH_CONNECT), at(2)),
    hit("late", 2), hit("late", 3),
  ]);
  assert.equal(s.members.get("late").since, day(2), "the join day is on the member");
  const l = lifetime(s, "late", day(4));
  assert.equal(l.banked, 200);
  assert.equal(l.since, day(2));
  assert.equal(l.days, 2);
});

test("a rename does not move the join day", () => {
  const s = world([E(ev.member("me", "Renamed"), at(5))]);
  assert.equal(s.members.get("me").name, "Renamed");
  assert.equal(s.members.get("me").since, day(0));
});

test("nobody yet is level 1 with an empty bar, not an error", () => {
  const s = world();
  const l = lifetime(s, "me", day(0));
  assert.equal(l.level, 1);
  assert.equal(l.banked, 0);
  assert.equal(l.into, 0);
  assert.equal(l.need, 300);
});

test("the same state answers from cache; a new event answers afresh", () => {
  const s = world([hit("me", 0)]);
  const a = lifetime(s, "me", day(1));
  const b = lifetime(s, "me", day(1));
  assert.equal(a, b, "one object, one walk");
  const s2 = world([hit("me", 0), hit("me", 1)]);
  assert.equal(lifetime(s2, "me", day(2)).banked, 200);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ levels: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ levels: " + passed + " tests passed");
