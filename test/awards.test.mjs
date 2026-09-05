// awards.test.mjs — the case counts what happened, not what is happening.
//
// The board shows a rank held while a run is alive: lose the streak, lose the badge. That is right
// there, and it is exactly wrong in a trophy case. Somebody who reached twenty days, lost it to one
// bad week and clawed back to twenty has done the hard thing twice — and a case that shows a single
// Silver, or worse none because today's run is short, is quietly telling them it did not happen.
//
// So every test here is about history rather than about today.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { awards, majorAwards, habitAwards } from "../js/awards.js";
import { ev, SOURCE, AT_LEAST, AGGREGATE, METRIC, PERIOD } from "../js/schema.js";
import { dayScore } from "../js/score.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MON = "2026-01-05";
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "a" + ++seq, ts, seq, ...spec });

/**
 * One member, one daily habit, logged for `days` days. `misses` are day indexes logged as a zero.
 *
 * Grace is switched off. The engine hands out a token every seven clean days and spends it to
 * absorb a miss, which is correct for a streak and useless for a fixture about broken runs — with
 * it on, the miss below is quietly forgiven and there is nothing to count.
 */
function world({ days = 60, misses = [], period = PERIOD.DAY, target = 10 } = {}) {
  const events = [
    E(ev.member("me", "You"), at(0)),
    E(ev.habit("h", {
      name: "Steps", icon: "👟", metric: METRIC.STEPS, direction: AT_LEAST, target,
      period, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
      grace: { earnEvery: 0, cap: 0 },
    }), at(0)),
  ];
  for (let n = 0; n <= days; n += 1) {
    events.push(E(ev.log("h", "me", day(n), misses.includes(n) ? 0 : 50, SOURCE.MANUAL), at(n)));
  }
  return replay(events);
}

// ---------------------------------------------------------------------------
// Earned more than once
// ---------------------------------------------------------------------------

test("a badge won, lost and won again is counted twice", () => {
  // Twenty clean days, one bad one, then twenty more. The fortnight badge was genuinely earned on
  // both sides of that miss.
  const s = world({ days: 45, misses: [20] });
  const steps = habitAwards(s, "me", day(45))[0];
  const fortnight = steps.levels.find((l) => l.at === 14);
  assert.equal(fortnight.times, 2, "earned on each side of the break");
});

test("an unbroken run counts each threshold once, not once per day past it", () => {
  // The count is of CROSSINGS. Counting "days at or above" would show a forty-day run as
  // twenty-seven fortnights.
  const s = world({ days: 40 });
  const steps = habitAwards(s, "me", day(40))[0];
  assert.equal(steps.levels.find((l) => l.at === 14).times, 1);
  assert.equal(steps.levels.find((l) => l.at === 30).times, 1);
  assert.equal(steps.levels.find((l) => l.at === 60).times, 0, "never reached");
});

test("a badge stays won after the streak that earned it is gone", () => {
  // The whole difference between this and the board. Today's run is four days; the fortnight
  // happened and is not up for review.
  const s = world({ days: 40, misses: [37, 38] });
  const steps = habitAwards(s, "me", day(40))[0];
  assert.ok(steps.streak < 14, "current run is short: " + steps.streak);
  assert.ok(steps.levels.find((l) => l.at === 14).times >= 1, "and the badge is still won");
});

// ---------------------------------------------------------------------------
// Everything that can be won is returned
// ---------------------------------------------------------------------------

test("all four majors come back, earned or not", () => {
  // The case draws the ceiling as well as the floor. A missing row is how somebody never finds out
  // a Diamond exists.
  const s = world({ days: 10 });
  const major = majorAwards(s, "me", day(10));
  assert.deepEqual(major.map((t) => t.name), ["Bronze", "Silver", "Gold", "Diamond"]);
  for (const t of major) assert.equal(typeof t.times, "number");
});

test("all four levels come back for every habit", () => {
  const s = world({ days: 3 });
  const steps = habitAwards(s, "me", day(3))[0];
  assert.equal(steps.levels.length, 4);
  assert.deepEqual(steps.levels.map((l) => l.at), [14, 30, 60, 120]);
  for (const l of steps.levels) assert.ok(l.span, "every level names its span");
});

test("a weekly habit is counted in weeks", () => {
  // Fifty of anything looks sensible until it is applied to a cadence longer than a day.
  const s = world({ days: 60, period: PERIOD.WEEK, target: 1 });
  const h = habitAwards(s, "me", day(60))[0];
  assert.deepEqual(h.levels.map((l) => l.at), [4, 12, 26, 52]);
});

// ---------------------------------------------------------------------------
// The whole case
// ---------------------------------------------------------------------------

test("the tally is every badge won across both halves", () => {
  const s = world({ days: 45, misses: [20] });
  const all = awards(s, "me", day(45));
  const counted = all.major.reduce((n, t) => n + t.times, 0)
    + all.habits.reduce((n, h) => n + h.levels.reduce((m, l) => m + l.times, 0), 0);
  assert.equal(all.earned, counted);
});

test("a group with no history does not throw and wins nothing", () => {
  // The state a new member is in for their first fortnight, which is when they are most likely to
  // go looking for this screen.
  const s = replay([E(ev.member("me", "You"), at(0))]);
  const all = awards(s, "me", day(0));
  assert.equal(all.earned, 0);
  assert.equal(all.habits.length, 0);
  assert.equal(all.major.length, 4);
});

// ---------------------------------------------------------------------------
// A habit you are not doing
// ---------------------------------------------------------------------------

test("a habit you opted out of is not in your case, and never earns you anything", () => {
  // The bug this replaces was not cosmetic. A day somebody has opted out of is EXEMPT, and EXEMPT
  // PRESERVES a streak rather than breaking it — right when it means a rest day, badly wrong when
  // it means "not doing this one". So declining a habit quietly accrued a run on it and the case
  // handed out badges for it: the group tracks six, you signed up for three, and the screen
  // congratulated you on the other three.
  //
  // Every other screen filters before it draws, which is why it had never surfaced anywhere else.
  const events = [E(ev.member("me", "You"), at(0))];
  for (const [id, name] of [["mine", "Steps"], ["theirs", "Vape puffs"]]) {
    events.push(E(ev.habit(id, {
      name, metric: METRIC.STEPS, direction: AT_LEAST, target: 10,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
    }), at(0)));
  }
  events.push(E(ev.goal("me", "theirs", { active: false }), at(0)));
  for (let n = 0; n < 20; n += 1) {
    events.push(E(ev.log("mine", "me", day(n), 50, SOURCE.MANUAL), at(n)));
  }

  const s = replay(events);
  const mine = habitAwards(s, "me", day(20));
  assert.deepEqual(mine.map((h) => h.name), ["Steps"], "only what this person is running");
  assert.equal(mine.length, 1);
});

// ---------------------------------------------------------------------------
// The walk's memo
// ---------------------------------------------------------------------------

test("a memoised score is the same score, asked in any order", () => {
  // A habit's score belongs to its PERIOD, not to the day you asked on, so a long walk can reuse
  // one answer for every day of a month instead of deriving it thirty times. That is only safe if
  // it is exact — and the last cache in this engine was not: it kept one running total, so asking
  // about an earlier week after a later one returned the later count and a ceiling walked UP.
  //
  // Hence both directions. A memo that is right forwards and wrong backwards is the exact shape of
  // that bug, and it would show up as a streak that depended on which screen you opened first.
  const s = world({ days: 60 });
  const today = day(60);

  const forward = new Map();
  const back = new Map();
  const plain = [];
  const memoF = [];
  for (let n = 0; n <= 60; n += 1) {
    plain.push(dayScore(s, "me", day(n), today).pct);
    memoF.push(dayScore(s, "me", day(n), today, forward).pct);
  }
  const memoB = [];
  for (let n = 60; n >= 0; n -= 1) memoB.unshift(dayScore(s, "me", day(n), today, back).pct);

  assert.deepEqual(memoF, plain, "forward");
  assert.deepEqual(memoB, plain, "reversed");
});

test("asking the same day twice through one memo gives the same answer", () => {
  const s = world({ days: 40 });
  const today = day(40);
  const memo = new Map();
  const first = dayScore(s, "me", day(12), today, memo).pct;
  const second = dayScore(s, "me", day(12), today, memo).pct;
  assert.equal(first, second);
  assert.equal(first, dayScore(s, "me", day(12), today).pct);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ awards: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ awards: " + passed + " tests passed");
