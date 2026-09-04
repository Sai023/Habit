// bonus.test.mjs — the second currency, and the three things that must stay true about it.
//
// Overachievement used to be worth nothing beyond its own category. A habit could score 1.15, the
// category cap threw the surplus away, and somebody who had been perfect for a fortnight had no
// way at all to close a gap on the person ahead. The season was decided by who was ahead first.
//
// So the surplus is banked instead of discarded. Three properties hold, and each is a hole that
// would otherwise be found:
//
//   • A DAY is still worth exactly a hundred. The bonus is a separate number and never inflates
//     the percentage — the moment it does, "out of 100" stops meaning anything.
//   • A week's bonus is AVERAGED, not summed. Summed over seven days it would reach 105 and be
//     worth more than the entire base score it was meant to garnish.
//   • Rest & recovery earns none. Otherwise the cheapest route up the board is a low sleep goal.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import {
  dayScore, scoreOver, leaderboard, BONUS_CAP, BONUS_CATEGORIES,
  CATEGORY, CATEGORY_ORDER, CATEGORY_WEIGHT, CATEGORY_LABEL, CATEGORY_ICON,
} from "../js/score.js";
import { ev, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, METRIC } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MONDAY = "2026-03-02";
const day = (n) => addDays(MONDAY, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "b" + ++seq, ts, seq, ...spec });

const stepsHabit = (over = {}) => ev.habit("steps", {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
  aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0, ...over,
});
const sleepHabit = () => ev.habit("sleep", {
  name: "Sleep", metric: METRIC.SLEEP, direction: AT_LEAST, target: 420,
  aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
});
const puffHabit = () => ev.habit("puffs", {
  name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
  aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
});

/** One member, one day, whatever habits and values you name. */
function oneDay(habits, logs) {
  return replay([
    E(ev.member("a", "Alice"), at(0)),
    ...habits.map((h) => E(h, at(0))),
    ...logs.map(([habitId, value]) =>
      E(ev.log(habitId, "a", day(0), value, SOURCE.MANUAL), at(0))),
  ]);
}

// ---------------------------------------------------------------------------
// The day is still worth exactly a hundred
// ---------------------------------------------------------------------------

test("beating a target pays bonus without inflating the percentage", () => {
  const s = oneDay([stepsHabit()], [["steps", 12000]]);
  const d = dayScore(s, "a", day(0));
  assert.equal(d.pct, 100, "the day is capped, as it always was");
  assert.equal(d.bonus, 15, "and the surplus is banked beside it");
});

test("exactly meeting a target earns none", () => {
  const s = oneDay([stepsHabit()], [["steps", 10000]]);
  const d = dayScore(s, "a", day(0));
  assert.equal(d.pct, 100);
  assert.equal(d.bonus, 0, "meeting is not beating");
});

test("falling short earns none, and cannot go negative", () => {
  const s = oneDay([stepsHabit()], [["steps", 4000]]);
  const d = dayScore(s, "a", day(0));
  assert.equal(d.pct, 40);
  assert.equal(d.bonus, 0);
});

test("the bonus is capped however far past the target you go", () => {
  // Ten times the target is worth the same fifteen as 1.15x. A single enormous day must not be
  // able to buy a week, which is what "capped" has to mean if it means anything.
  const s = oneDay([stepsHabit()], [["steps", 100000]]);
  const d = dayScore(s, "a", day(0));
  assert.equal(d.pct, 100);
  assert.equal(d.bonus, 15);
});

// ---------------------------------------------------------------------------
// Where it can be earned
// ---------------------------------------------------------------------------

test("Rest & recovery earns no bonus, however far past the target", () => {
  // Sleeping fifteen per cent past target is a lie-in, not an achievement — and paying for it
  // would make "set a low sleep goal" the cheapest route up the board.
  const s = oneDay([sleepHabit()], [["sleep", 600]]);
  const d = dayScore(s, "a", day(0));
  assert.equal(d.pct, 100, "it still scores the day in full");
  assert.equal(d.bonus, 0, "it just cannot pay a bonus");
  assert.ok(!BONUS_CATEGORIES.has(CATEGORY.REST));
});

test("a ceiling held well under pays bonus, because that is a decision", () => {
  const s = oneDay([puffHabit()], [["puffs", 0]]);
  const d = dayScore(s, "a", day(0));
  assert.equal(d.pct, 100);
  assert.equal(d.bonus, 15, "nothing at all is the full bonus on a ceiling");
});

test("bonus is shared out by category weight, not handed out per habit", () => {
  // Fitness 40 and Discipline 30 of a 70-point live total: 57% and 43% of the day. Beating BOTH
  // pays the full fifteen; beating one pays its share of it.
  const both = oneDay([stepsHabit(), puffHabit()], [["steps", 12000], ["puffs", 0]]);
  assert.equal(dayScore(both, "a", day(0)).bonus, 15);

  const onlySteps = oneDay([stepsHabit(), puffHabit()], [["steps", 12000], ["puffs", 80]]);
  const d = dayScore(onlySteps, "a", day(0));
  assert.equal(d.pct, 100, "at the ceiling is still a pass");
  assert.equal(d.bonus, 9, "40/70 of fifteen — fitness's share of it, and no more");
});

test("a day that is all Rest can earn nothing at all", () => {
  const s = oneDay([sleepHabit()], [["sleep", 900]]);
  assert.equal(dayScore(s, "a", day(0)).bonus, 0);
});

// ---------------------------------------------------------------------------
// A week averages it, and never sums it
// ---------------------------------------------------------------------------

test("a week of beaten targets is worth fifteen, not a hundred and five", () => {
  // The scale error this exists to prevent. Summed, seven perfect-plus days would be worth 105 —
  // more than the entire base score it is meant to garnish, and the percentage beside it becomes
  // decoration.
  const s = replay([
    E(ev.member("a", "Alice"), at(0)),
    E(stepsHabit(), at(0)),
    ...[0, 1, 2, 3, 4, 5, 6].map((n) =>
      E(ev.log("steps", "a", day(n), 12000, SOURCE.MANUAL), at(n))),
  ]);
  const week = scoreOver(s, "a", day(0), day(6), addDays, day(6));
  assert.equal(week.pct, 100);
  assert.equal(week.bonus, 15, "averaged across the days, exactly like the percentage");
  assert.equal(week.days, 7);
});

test("one strong day in a weak week moves the bonus a little, not a lot", () => {
  const s = replay([
    E(ev.member("a", "Alice"), at(0)),
    E(stepsHabit(), at(0)),
    E(ev.log("steps", "a", day(0), 20000, SOURCE.MANUAL), at(0)),
    ...[1, 2, 3, 4, 5, 6].map((n) =>
      E(ev.log("steps", "a", day(n), 10000, SOURCE.MANUAL), at(n))),
  ]);
  const week = scoreOver(s, "a", day(0), day(6), addDays, day(6));
  assert.equal(week.pct, 100);
  assert.equal(week.bonus, 2, "fifteen on one day of seven");
});

test("the leaderboard carries the bonus onto the row", () => {
  const s = replay([
    E(ev.member("a", "Alice"), at(0)),
    E(ev.member("b", "Bob"), at(0)),
    E(stepsHabit(), at(0)),
    ...[0, 1, 2, 3, 4, 5, 6].flatMap((n) => [
      E(ev.log("steps", "a", day(n), 12000, SOURCE.MANUAL), at(n)),
      E(ev.log("steps", "b", day(n), 10000, SOURCE.MANUAL), at(n)),
    ]),
  ]);
  const rows = leaderboard(s, ["a", "b"], day(0), day(6), day(6));
  const alice = rows.find((r) => r.name === "Alice");
  const bob = rows.find((r) => r.name === "Bob");

  assert.equal(alice.pct, 100);
  assert.equal(bob.pct, 100, "both had a perfect week on the base score");
  assert.equal(alice.bonus, 15);
  assert.equal(bob.bonus, 0, "and the bonus is what separates them");
});

test("the cap is a constant the rest of the app can read", () => {
  assert.equal(BONUS_CAP, 1.15);
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// What the Transparency Panel promises the group
// ---------------------------------------------------------------------------

test("the four weights add up to a hundred", () => {
  // The panel tells the group a day is worth exactly 100 and then prints these four numbers
  // beside each other. If they stop summing to a hundred the explanation becomes a lie that
  // nobody would think to check.
  const total = CATEGORY_ORDER.reduce((sum, c) => sum + CATEGORY_WEIGHT[c], 0);
  assert.equal(total, 100);
});

test("every category has a weight, a name and an icon to print", () => {
  for (const c of CATEGORY_ORDER) {
    assert.ok(CATEGORY_WEIGHT[c] > 0, c + " has a weight");
    assert.ok(CATEGORY_LABEL[c], c + " has a label");
    assert.ok(CATEGORY_ICON[c], c + " has an icon");
  }
  assert.equal(CATEGORY_ORDER.length, Object.keys(CATEGORY_WEIGHT).length);
});

test("bonus is earnable everywhere except Rest & recovery", () => {
  // The panel says so in as many words, and the rule it describes lives in one Set. Anything
  // added to the categories later has to make this decision deliberately.
  for (const c of CATEGORY_ORDER) {
    assert.equal(
      BONUS_CATEGORIES.has(c), c !== CATEGORY.REST,
      c + " bonus eligibility",
    );
  }
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ bonus: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ bonus: " + passed + " tests passed");
