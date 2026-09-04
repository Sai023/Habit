// season.test.mjs — the long game, and the ways a tally goes wrong.
//
// A running total is the one number in this app that is expected to be believed for months, so the
// failures that matter are the quiet ones: a crown awarded twice, a week counted that nobody could
// have played, an order that two phones disagree about.

import assert from "node:assert/strict";
import { replay, addDays, isoWeekKey } from "../js/habits.js";
import { seasonStart, seasonWeeks, weekStandings, seasonTally, categoryBreakdown } from "../js/season.js";
import { CATEGORY } from "../js/score.js";
import { ev, SOURCE, METRIC, AT_LEAST, AGGREGATE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MONDAY = "2026-03-02"; // week 1 of the fixture
const day = (n) => addDays(MONDAY, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "z" + ++seq, ts, seq, ...spec });

const STEPS = {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
  aggregate: AGGREGATE.LAST, period: PERIOD.DAY, source: SOURCE.MANUAL, scored: true,
  tz: TZ, dayStartHour: 0,
};

/**
 * Three weeks, two members. `steps` is [memberId, dayOffset, value].
 * Alice wins weeks 1 and 2; Bob wins week 3.
 */
function season(extra = []) {
  const events = [
    E(ev.member("a", "Alice"), at(0)),
    E(ev.member("b", "Bob"), at(0)),
    E(ev.habit("steps", STEPS), at(0)),
    E(ev.bind("a", "steps", SOURCE.MANUAL), at(0)),
    E(ev.bind("b", "steps", SOURCE.MANUAL), at(0)),
  ];
  for (let n = 0; n < 21; n += 1) {
    const week = Math.floor(n / 7);
    const alice = week === 2 ? 4000 : 12000;
    const bob = week === 2 ? 12000 : 5000;
    events.push(E(ev.log("steps", "a", day(n), alice, SOURCE.MANUAL), at(n)));
    events.push(E(ev.log("steps", "b", day(n), bob, SOURCE.MANUAL), at(n)));
  }
  return replay([...events, ...extra]);
}

// Day 21 is the Monday of week 4, so weeks 1-3 are complete and week 4 is in play.
const TODAY = addDays(MONDAY, 21);

// ===========================================================================
// What a season is made of
// ===========================================================================

test("the season starts when the group did, not when a member joined", () => {
  // Dating it from a join would hand whoever joined last a shorter, easier season.
  const s = season();
  assert.equal(seasonStart(s), MONDAY);
  assert.equal(seasonWeeks(s, TODAY).length, 4, "three played and the one being played");
});

test("only completed weeks award a crown", () => {
  // Handing out this week's trophy on a Tuesday and taking it back on Thursday makes the tally
  // something to refresh rather than something to build.
  const { weeks, rows } = seasonTally(season(), ["a", "b"], TODAY);
  assert.equal(weeks, 3);
  const alice = rows.find((r) => r.name === "Alice");
  const bob = rows.find((r) => r.name === "Bob");
  assert.equal(alice.crowns, 2);
  assert.equal(bob.crowns, 1);
  assert.equal(alice.weeks, 3, "every week was played, not just the ones won");
});

test("the crown a week awards is the crown the board showed at the time", () => {
  // The season reuses the ordinary board rather than forming a second opinion about who won.
  const s = season();
  const week1 = weekStandings(s, ["a", "b"], isoWeekKey(MONDAY));
  assert.equal(week1[0].name, "Alice");
  assert.equal(week1[0].crown, true);
});

test("points accumulate and cannot be dented by one bad week", () => {
  // The number that makes it a long game: it only ever goes up, and rewards the person who kept
  // showing up over the person who had one enormous fortnight.
  const { rows } = seasonTally(season(), ["a", "b"], TODAY);
  const alice = rows.find((r) => r.name === "Alice");
  // Two perfect weeks plus a bad one: still well ahead of nothing.
  assert.ok(alice.points > 200);
  assert.equal(alice.avg, Math.round(alice.points / alice.weeks));
  // 115, not 100, and earned rather than inflated: she walks 12,000 against a 10,000 target every
  // day, which is 120% of it — clipped to the 1.15 ceiling. Steps are her only category, so the
  // whole hundred-point share sits in Core Fitness and the overshoot pays the full fifteen.
  assert.equal(alice.best.pct, 115, "a hundred for the day, fifteen for beating it");
});

test("a crown streak breaks when the crown does, and remembers its best", () => {
  const { rows } = seasonTally(season(), ["a", "b"], TODAY);
  const alice = rows.find((r) => r.name === "Alice");
  assert.equal(alice.bestCrownStreak, 2, "weeks one and two");
  assert.equal(alice.crownStreak, 0, "and week three broke it");

  const bob = rows.find((r) => r.name === "Bob");
  assert.equal(bob.crownStreak, 1, "his run is live");
});

// ===========================================================================
// The ways a tally goes wrong
// ===========================================================================

test("a week the WATCH could not answer for is not a week they lost", () => {
  // A phone that never synced. It must not count as a week played, or an average punishes an
  // outage — and the distinction is the four-state model doing its job: a silent sensor is
  // NO_DATA, while a manual habit nobody logged is a plain miss and rightly scores zero.
  const watch = { ...STEPS, source: SOURCE.HEALTH_CONNECT };
  const s = replay([
    E(ev.member("a", "Alice"), at(0)),
    E(ev.habit("steps", watch), at(0)),
    E(ev.bind("a", "steps", SOURCE.HEALTH_CONNECT), at(0)),
    // Week 1 only. Weeks 2 and 3 the watch said nothing at all.
    ...[0, 1, 2, 3, 4, 5, 6].map((n) =>
      E(ev.log("steps", "a", day(n), 12000, SOURCE.HEALTH_CONNECT), at(n))),
  ]);
  const { rows } = seasonTally(s, ["a"], TODAY);
  assert.equal(rows[0].weeks, 1, "one week played, not three");
  assert.equal(rows[0].avg, 115, "and the average is of what was played, bonus included");
});

test("but a week they simply did not log IS a week they lost", () => {
  // The other half, and the one that keeps the season honest: a manual habit with nothing entered
  // is a miss, so the weeks count and the average carries them.
  const s = replay([
    E(ev.member("a", "Alice"), at(0)),
    E(ev.habit("steps", STEPS), at(0)),
    E(ev.bind("a", "steps", SOURCE.MANUAL), at(0)),
    ...[0, 1, 2, 3, 4, 5, 6].map((n) =>
      E(ev.log("steps", "a", day(n), 12000, SOURCE.MANUAL), at(n))),
  ]);
  const { rows } = seasonTally(s, ["a"], TODAY);
  assert.equal(rows[0].weeks, 3, "three weeks played, two of them badly");
  // (115 + 0 + 0) / 3. The bonus rides on the week that was played and cannot rescue the two
  // that were not — which is the point: beating a target is worth something, and it is worth
  // much less than turning up.
  assert.equal(rows[0].avg, 38);
});

test("the standing is ranked on points, and crowns only break the tie", () => {
  // This was the other way round, and the change is deliberate. Crowns are all-or-nothing, so
  // three near-misses counted exactly as much as three terrible weeks and the season was decided
  // by a handful of Sundays — with nothing to play for once one person was clear. Points accrue
  // every week, so a strong run always closes ground.
  //
  // Crowns survive as the tie-break: a season of wins should still beat a season of seconds on
  // equal points, and the name decides last so two phones always agree on the order.
  const { rows } = seasonTally(season(), ["a", "b"], TODAY);
  assert.deepEqual(rows.map((r) => r.name), ["Alice", "Bob"]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
});

test("a member nothing can be scored for shows nothing, not a zero", () => {
  // Somebody who joined and whose watch has never reported. No weeks played is not an average of
  // zero — the difference between "hasn't started" and "is losing" matters most to the person it
  // is being said about.
  const watch = { ...STEPS, source: SOURCE.HEALTH_CONNECT };
  const s = replay([
    E(ev.member("a", "Alice"), at(0)),
    E(ev.member("ghost", "Ghost"), at(0)),
    E(ev.habit("steps", watch), at(0)),
    E(ev.bind("a", "steps", SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.bind("ghost", "steps", SOURCE.HEALTH_CONNECT), at(0)),
    ...[0, 1, 2].map((n) => E(ev.log("steps", "a", day(n), 12000, SOURCE.HEALTH_CONNECT), at(n))),
  ]);
  const { rows } = seasonTally(s, ["a", "ghost"], TODAY);
  const ghost = rows.find((r) => r.memberId === "ghost");
  assert.equal(ghost.weeks, 0);
  assert.equal(ghost.avg, null, "no weeks played is not an average of zero");
  assert.equal(ghost.crowns, 0);
});

test("nothing is stored, so a late day moves the season when it lands", () => {
  // The whole reason the tally is derived. A counter written down would have drifted the first
  // time a phone synced late, and then the standings and the days behind them would disagree with
  // nobody able to say which was right.
  const before = seasonTally(season(), ["a", "b"], TODAY);
  // Bob backfills the last day of week ONE, where he was short — inside the two-day window the
  // engine allows. A day he was already winning would prove nothing.
  const after = seasonTally(
    season([E(ev.log("steps", "b", day(6), 20000, SOURCE.MANUAL), at(7))]),
    ["a", "b"], TODAY,
  );
  const bobBefore = before.rows.find((r) => r.name === "Bob");
  const bobAfter = after.rows.find((r) => r.name === "Bob");
  assert.ok(bobAfter.points > bobBefore.points, "the season moved because the log did");
});

test("an empty group has a season of nothing, not a crash", () => {
  const s = replay([]);
  assert.equal(seasonStart(s), null);
  assert.deepEqual(seasonWeeks(s, TODAY), []);
  assert.equal(seasonTally(s, [], TODAY).weeks, 0);
});

// ===========================================================================
// Where the number came from
// ===========================================================================

test("a breakdown says which category carried the week and which sank it", () => {
  // The board says 68. It does not say that fitness carried it and discipline sank it, which is
  // the only part anybody can act on.
  const s = season();
  const parts = categoryBreakdown(s, "a", MONDAY, day(6));
  assert.deepEqual(parts.map((p) => p.category), [CATEGORY.FITNESS]);
  assert.equal(parts[0].pct, 100);
  assert.equal(parts[0].days, 7);
});

test("categories nobody runs are left out rather than shown as zero", () => {
  const parts = categoryBreakdown(season(), "a", MONDAY, day(6));
  assert.ok(!parts.some((p) => p.category === CATEGORY.MONEY));
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ season standings: " + passed + " tests passed");
