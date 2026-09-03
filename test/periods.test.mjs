// periods.test.mjs — habits that are not daily, and a board that can hold them side by side.
//
// "Exercise three times a week" is not "exercise 0.43 times a day", and a savings target is one
// question asked once a month. Once habits run on different cadences the interesting failures are
// all in how they are combined — so most of this file is about the leaderboard.

import assert from "node:assert/strict";
import {
  replay, walk, leaderboard, addDays, isoWeekKey, periodKey, periodStart, periodEnd,
  daysInPeriod, periodsBetween, rawPeriodStatus, valueForPeriod, progressFor,
  HIT, MISS, NO_DATA, EXEMPT,
} from "../js/habits.js";
import { ev, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, METRIC, PERIOD } from "../js/schema.js";

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
  return { eventId: "p" + String(_seq).padStart(4, "0"), ts, seq: _seq, ...spec };
}

// ===========================================================================
// Calendar
// ===========================================================================

test("ISO weeks, including the ones that straddle a year", () => {
  // The alternative convention ("the week containing 1 January") makes a one- or two-day stub week
  // that a weekly target physically cannot be met in — a guaranteed miss every new year.
  assert.equal(isoWeekKey("2026-03-02"), "2026-W10");
  assert.equal(isoWeekKey("2026-03-08"), "2026-W10"); // Sunday still belongs to its Monday
  assert.equal(isoWeekKey("2026-03-09"), "2026-W11");
  assert.equal(isoWeekKey("2025-12-29"), "2026-W01"); // December, but next year's first week
  assert.equal(isoWeekKey("2026-12-31"), "2026-W53"); // 2026 is a 53-week year
});

test("period keys, starts and ends", () => {
  assert.equal(periodKey("2026-03-02", PERIOD.DAY), "2026-03-02");
  assert.equal(periodKey("2026-03-02", PERIOD.WEEK), "2026-W10");
  assert.equal(periodKey("2026-03-02", PERIOD.MONTH), "2026-03");

  assert.equal(periodStart("2026-W10", PERIOD.WEEK), "2026-03-02");
  assert.equal(periodEnd("2026-W10", PERIOD.WEEK), "2026-03-08");
  assert.equal(periodStart("2026-03", PERIOD.MONTH), "2026-03-01");
  assert.equal(periodEnd("2026-03", PERIOD.MONTH), "2026-03-31");
  assert.equal(periodEnd("2026-02", PERIOD.MONTH), "2026-02-28");
  assert.equal(periodEnd("2028-02", PERIOD.MONTH), "2028-02-29"); // leap year
});

test("a period lists its days, and a range lists its periods", () => {
  assert.equal(daysInPeriod("2026-W10", PERIOD.WEEK).length, 7);
  assert.equal(daysInPeriod("2026-02", PERIOD.MONTH).length, 28);
  assert.deepEqual(
    periodsBetween("2026-03-02", "2026-03-16", PERIOD.WEEK),
    ["2026-W10", "2026-W11", "2026-W12"],
  );
  assert.deepEqual(
    periodsBetween("2026-01-15", "2026-03-05", PERIOD.MONTH),
    ["2026-01", "2026-02", "2026-03"],
  );
});

// ===========================================================================
// Weekly and monthly habits
// ===========================================================================

const weekly = {
  name: "Gym", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3,
  period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
  tz: TZ, dayStartHour: 4, scored: true,
};

function gymGroup(sessionDays) {
  const events = [
    E(ev.member("m1", "Alice"), at("2026-03-01", 7)),
    E(ev.habit("gym", weekly), at("2026-03-01", 7)),
  ];
  for (const d of sessionDays) events.push(E(ev.log("gym", "m1", d, 1, SOURCE.MANUAL), at(d)));
  return replay(events);
}

test("three sessions anywhere in the week is a hit; two is a miss", () => {
  // The point of a weekly habit: WHICH days do not matter, only that it happened enough times.
  const s = gymGroup(["2026-03-02", "2026-03-05", "2026-03-08", "2026-03-09", "2026-03-11"]);
  const gym = s.habits.get("gym");
  assert.equal(valueForPeriod(s, gym, "m1", "2026-W10"), 3);
  assert.equal(rawPeriodStatus(s, gym, "m1", "2026-W10"), HIT);
  assert.equal(valueForPeriod(s, gym, "m1", "2026-W11"), 2);
  assert.equal(rawPeriodStatus(s, gym, "m1", "2026-W11"), MISS);
});

test("a weekly streak counts weeks, not days", () => {
  const s = gymGroup([
    "2026-03-02", "2026-03-04", "2026-03-06", // W10: 3
    "2026-03-09", "2026-03-11", "2026-03-13", // W11: 3
    "2026-03-16", "2026-03-18", "2026-03-20", // W12: 3
  ]);
  const w = walk(s, "gym", "m1", "2026-03-24"); // W13, still running
  assert.equal(w.streak, 3, "three clean weeks");
  assert.equal(w.statuses.get("2026-W10"), HIT);
});

test("the week still running is never a miss", () => {
  // Judged on Monday morning, a weekly goal has had no chance yet. Marking it failed would reset
  // every streak in the group at the start of every week.
  const s = gymGroup(["2026-03-02", "2026-03-04", "2026-03-06"]);
  const w = walk(s, "gym", "m1", "2026-03-09"); // Monday of W11, nothing logged yet
  assert.equal(w.todayStatus, MISS);
  assert.equal(w.streak, 1, "last week's hit survives into the new week");
});

test("a savings balance is not summed across the month", () => {
  // Reporting 4000 then 5200 means you have 5200, not 9200. Summing would have everyone hitting
  // every target by reporting often enough.
  const s = replay([
    E(ev.member("m1", "Alice"), at("2026-02-01", 7)),
    E(ev.habit("save", {
      name: "Savings", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 5000,
      period: PERIOD.MONTH, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4, scored: true,
    }), at("2026-02-01", 7)),
    E(ev.log("save", "m1", "2026-02-10", 4000, SOURCE.MANUAL), at("2026-02-10")),
    E(ev.log("save", "m1", "2026-02-25", 5200, SOURCE.MANUAL), at("2026-02-25")),
  ]);
  const save = s.habits.get("save");
  assert.equal(valueForPeriod(s, save, "m1", "2026-02"), 5200);
  assert.equal(rawPeriodStatus(s, save, "m1", "2026-02"), HIT);
});

test("a month away does not excuse a weekly goal that had four other days in it", () => {
  const s = replay([
    E(ev.member("m1", "Alice"), at("2026-03-01", 7)),
    E(ev.habit("gym", weekly), at("2026-03-01", 7)),
    E(ev.exempt("m1", "2026-03-02", "2026-03-04", "travel"), at("2026-03-01", 9)),
  ]);
  const gym = s.habits.get("gym");
  assert.equal(rawPeriodStatus(s, gym, "m1", "2026-W10"), MISS, "three days off, four days left");

  const whole = replay([
    E(ev.member("m1", "Alice"), at("2026-03-01", 7)),
    E(ev.habit("gym", weekly), at("2026-03-01", 7)),
    E(ev.exempt("m1", "2026-03-02", "2026-03-08", "travel"), at("2026-03-01", 9)),
  ]);
  assert.equal(rawPeriodStatus(whole, whole.habits.get("gym"), "m1", "2026-W10"), EXEMPT);
});

test("grace scales with the cadence instead of staying a constant", () => {
  // One token per seven clean MONTHS is unreachable; per seven clean days applied to a weekly
  // habit would forgive a third of the year.
  const s = gymGroup([]);
  assert.equal(s.habits.get("gym").grace.earnEvery, 4);
  const daily = replay([
    E(ev.habit("d", { period: PERIOD.DAY, tz: TZ, dayStartHour: 4 }), at("2026-03-01", 7)),
  ]);
  assert.equal(daily.habits.get("d").grace.earnEvery, 7);
});

// ===========================================================================
// The weighted board — the reason any of this exists
// ===========================================================================

/**
 * One daily habit and one monthly habit, over a closed February.
 *
 * Alice does the daily one perfectly and ignores the monthly one. Bob does the exact opposite.
 * Pooled into one hits-over-eligible ratio, Alice scores about 97% and Bob about 3%, purely
 * because a daily habit produces 28 results in a month and a monthly one produces a single result.
 */
function mixedGroup(savingsWeight = 1) {
  const events = [
    E(ev.member("m1", "Alice"), at("2026-01-31", 7)),
    E(ev.member("m2", "Bob"), at("2026-01-31", 7)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      period: PERIOD.DAY, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4, scored: true,
    }), at("2026-01-31", 7)),
    E(ev.habit("save", {
      name: "Savings", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 5000,
      period: PERIOD.MONTH, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4, scored: true, weight: savingsWeight,
    }), at("2026-01-31", 7)),
  ];
  for (let d = "2026-02-01"; d <= "2026-02-28"; d = addDays(d, 1)) {
    events.push(E(ev.log("steps", "m1", d, 12000, SOURCE.MANUAL), at(d)));
    events.push(E(ev.log("steps", "m2", d, 3000, SOURCE.MANUAL), at(d)));
  }
  events.push(E(ev.log("save", "m2", "2026-02-25", 6000, SOURCE.MANUAL), at("2026-02-25")));
  return replay(events);
}

test("a monthly goal is not drowned by a daily one", () => {
  const rows = leaderboard(mixedGroup(), ["m1", "m2"], "2026-02-01", "2026-02-28", "2026-03-02");
  const alice = rows.find((r) => r.name === "Alice");
  const bob = rows.find((r) => r.name === "Bob");

  assert.equal(alice.pct, 50, "perfect on steps, nothing saved — half the goals met");
  assert.equal(bob.pct, 50, "nothing on steps, saved the target — also half");
  assert.equal(alice.pct, bob.pct, "28 results and 1 result must count the same");
});

test("weight is what tips a habit, now that the denominator is fair", () => {
  const rows = leaderboard(mixedGroup(3), ["m1", "m2"], "2026-02-01", "2026-02-28", "2026-03-02");
  const alice = rows.find((r) => r.name === "Alice");
  const bob = rows.find((r) => r.name === "Bob");
  assert.equal(alice.pct, 25); // steps only: 1 of 4 parts
  assert.equal(bob.pct, 75);   // savings, worth 3 of 4 parts
  assert.equal(bob.crown, true);
});

test("each habit's own ratio is reported, so the board can be broken down", () => {
  const rows = leaderboard(mixedGroup(), ["m1", "m2"], "2026-02-01", "2026-02-28", "2026-03-02");
  const alice = rows.find((r) => r.name === "Alice");
  const byHabit = Object.fromEntries(alice.perHabit.map((h) => [h.habitId, h.ratio]));
  assert.equal(byHabit.steps, 1);
  assert.equal(byHabit.save, 0);
});

test("the period still running contributes partial progress, not a verdict", () => {
  // Otherwise a month-long goal shows nothing on this week's board until the month closes.
  const s = replay([
    E(ev.member("m1", "Alice"), at("2026-03-01", 7)),
    E(ev.habit("save", {
      name: "Savings", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 5000,
      period: PERIOD.MONTH, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4, scored: true,
    }), at("2026-03-01", 7)),
    E(ev.log("save", "m1", "2026-03-10", 3000, SOURCE.MANUAL), at("2026-03-10")),
  ]);
  assert.equal(progressFor(s, s.habits.get("save"), "m1", "2026-03"), 0.6);
  const rows = leaderboard(s, ["m1"], "2026-03-09", "2026-03-15", "2026-03-11");
  assert.equal(rows[0].pct, 60, "three fifths of the way, showing on the board as such");
});

test("an untouched ceiling is a perfect score, not a zero", () => {
  // A reduce habit you have not spent against is being met, not failed.
  const s = replay([
    E(ev.member("m1", "Alice"), at("2026-03-01", 7)),
    E(ev.habit("puffs", {
      name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 20,
      period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4, scored: true,
    }), at("2026-03-01", 7)),
  ]);
  const puffs = s.habits.get("puffs");
  assert.equal(progressFor(s, puffs, "m1", "2026-03-02"), 1);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ periods & weighting: " + passed + " tests passed");
