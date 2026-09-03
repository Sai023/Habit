// goals.test.mjs — each person's own target for a habit the group shares.
//
// The group agrees on WHAT it tracks; the number is personal. Scoring three people against one
// figure measures fitness rather than effort, which is not what anybody joins a habit tracker for.

import assert from "node:assert/strict";
import {
  replay, leaderboard, targetFor, isTracking, rawDayStatus, walk,
  HIT, MISS, EXEMPT,
} from "../js/habits.js";
import { ev, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, METRIC } from "../js/schema.js";

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
  return { eventId: "g" + String(_seq).padStart(4, "0"), ts, seq: _seq, ...spec };
}

const D0 = "2026-03-02";
const stepsHabit = {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
  source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4, scored: true,
};

/** Two people, one shared habit, and whatever goals/logs the case needs. */
function group(extra = []) {
  return replay([
    E(ev.member("m1", "Sahil"), at("2026-03-01", 7)),
    E(ev.member("m2", "Ivan"), at("2026-03-01", 7)),
    E(ev.habit("steps", stepsHabit), at("2026-03-01", 7)),
    ...extra,
  ]);
}

test("a member's own target beats the group's", () => {
  const s = group([E(ev.goal("m2", "steps", { target: 6000 }), at("2026-03-01", 8))]);
  const steps = s.habits.get("steps");
  assert.equal(targetFor(s, steps, "m1", D0), 10000, "no goal set — the group's number");
  assert.equal(targetFor(s, steps, "m2", D0), 6000);
});

test("the same day is a hit for one person and a miss for the other", () => {
  // The entire point. 7,000 steps is a good day against a 6,000 goal and a bad one against 10,000.
  const s = group([
    E(ev.goal("m2", "steps", { target: 6000 }), at("2026-03-01", 8)),
    E(ev.log("steps", "m1", D0, 7000, SOURCE.MANUAL), at(D0)),
    E(ev.log("steps", "m2", D0, 7000, SOURCE.MANUAL), at(D0)),
  ]);
  const steps = s.habits.get("steps");
  assert.equal(rawDayStatus(s, steps, "m1", D0), MISS);
  assert.equal(rawDayStatus(s, steps, "m2", D0), HIT);
});

test("opting out is EXEMPT, not a miss", () => {
  // Not doing a habit has to be sayable. Otherwise a group cannot track five things unless
  // everyone signs up for all five.
  const s = group([E(ev.goal("m2", "steps", { active: false }), at("2026-03-01", 8))]);
  const steps = s.habits.get("steps");
  assert.equal(isTracking(s, steps, "m2"), false);
  assert.equal(rawDayStatus(s, steps, "m2", D0), EXEMPT);
  assert.equal(isTracking(s, steps, "m1"), true);
});

test("an opted-out habit leaves the board score untouched rather than sinking it", () => {
  const s = group([
    E(ev.goal("m2", "steps", { active: false }), at("2026-03-01", 8)),
    E(ev.habit("read", {
      name: "Read", direction: AT_LEAST, target: 1, aggregate: AGGREGATE.SUM,
      source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4, scored: true,
    }), at("2026-03-01", 7)),
    E(ev.log("read", "m2", D0, 1, SOURCE.MANUAL), at(D0)),
    E(ev.log("read", "m1", D0, 1, SOURCE.MANUAL), at(D0)),
    E(ev.log("steps", "m1", D0, 12000, SOURCE.MANUAL), at(D0)),
  ]);
  const rows = leaderboard(s, ["m1", "m2"], D0, D0, D0);
  const ivan = rows.find((r) => r.name === "Ivan");
  assert.equal(ivan.pct, 100, "judged only on the one habit he actually signed up for");
  assert.equal(ivan.perHabit.length, 1);
});

test("a taper applies to the member's own number, not the group's", () => {
  const s = replay([
    E(ev.member("m1", "Sahil"), at("2026-03-01", 7)),
    E(ev.habit("puffs", {
      name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 20,
      aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
      taper: { amount: 1, everyDays: 7, floor: 0 },
    }), at("2026-03-01", 7)),
    E(ev.goal("m1", "puffs", { target: 12 }), at("2026-03-01", 8)),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(targetFor(s, puffs, "m1", "2026-03-01"), 12);
  assert.equal(targetFor(s, puffs, "m1", "2026-03-08"), 11, "their 12 tapers, not the group's 20");
  assert.equal(targetFor(s, puffs, "m1", "2026-04-19"), 5);
});

test("changing only the target keeps me opted in, and vice versa", () => {
  // Edits send what changed. A goal update that omitted `active` must not quietly opt someone out,
  // and pausing a habit must not wipe the target they set.
  const s = group([
    E(ev.goal("m1", "steps", { target: 8000 }), at("2026-03-01", 8)),
    E(ev.goal("m1", "steps", { active: false }), at("2026-03-01", 9)),
  ]);
  const steps = s.habits.get("steps");
  assert.equal(isTracking(s, steps, "m1"), false);
  assert.equal(targetFor(s, steps, "m1", D0), 8000, "the target survived being paused");

  const back = group([
    E(ev.goal("m1", "steps", { target: 8000 }), at("2026-03-01", 8)),
    E(ev.goal("m1", "steps", { active: false }), at("2026-03-01", 9)),
    E(ev.goal("m1", "steps", { active: true }), at("2026-03-01", 10)),
  ]);
  assert.equal(isTracking(back, back.habits.get("steps"), "m1"), true);
  assert.equal(targetFor(back, back.habits.get("steps"), "m1", D0), 8000);
});

test("a nonsense target falls back to the group's rather than making every day impossible", () => {
  const s = group([E(ev.goal("m1", "steps", { target: 0 }), at("2026-03-01", 8))]);
  assert.equal(targetFor(s, s.habits.get("steps"), "m1", D0), 10000);
});

test("streaks run on the member's own target", () => {
  const s = group([
    E(ev.goal("m2", "steps", { target: 5000 }), at("2026-03-01", 8)),
    E(ev.log("steps", "m2", "2026-03-02", 6000, SOURCE.MANUAL), at("2026-03-02")),
    E(ev.log("steps", "m2", "2026-03-03", 6000, SOURCE.MANUAL), at("2026-03-03")),
    E(ev.log("steps", "m2", "2026-03-04", 6000, SOURCE.MANUAL), at("2026-03-04")),
  ]);
  assert.equal(walk(s, "steps", "m2", "2026-03-05").streak, 3);
  // The same numbers against the group's default would be three straight misses.
  const other = group([
    E(ev.log("steps", "m1", "2026-03-02", 6000, SOURCE.MANUAL), at("2026-03-02")),
    E(ev.log("steps", "m1", "2026-03-03", 6000, SOURCE.MANUAL), at("2026-03-03")),
    E(ev.log("steps", "m1", "2026-03-04", 6000, SOURCE.MANUAL), at("2026-03-04")),
  ]);
  assert.equal(walk(other, "steps", "m1", "2026-03-05").streak, 0);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ personal goals: " + passed + " tests passed");
