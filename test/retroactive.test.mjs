// retroactive.test.mjs — nothing that happens today may change what happened last week.
//
// ---- The bug this is built around ----
//
// Adding a habit re-scored the entire past. habitScore never looked at a habit's birthday, so a
// sixth habit created on a Tuesday appeared, retrospectively, on every day back to the beginning —
// unlogged, therefore missed, therefore dragging every one of those days down.
//
// It was invisible in ordinary use and ruinous in a group: finished weeks changed, crowns moved,
// and a season somebody was halfway through would rearrange itself because a friend added a habit.
// The board's entire claim is that a finished week is finished, and the one screen that would have
// shown the contradiction — the season standings — is also the one nobody checks against a
// screenshot from last Tuesday.
//
// Found by asking the question directly rather than by example: take a settled week, change
// something today, and read that week again.

import assert from "node:assert/strict";
import { replay, addDays, isoWeekKey } from "../js/habits.js";
import { weekStandings, seasonTally } from "../js/season.js";
import { dayScore } from "../js/score.js";
import { ev, METRIC, AT_LEAST, AGGREGATE, SOURCE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const MON = "2026-03-02";
const day = (n) => addDays(MON, n);
let seq = 0;
const E = (spec, ts) => ({ eventId: "R" + ++seq, ts, seq, ...spec });
const at = (n) => Date.parse(day(n) + "T09:00:00Z");

const habitOn = (id, born, over = {}) => E(ev.habit(id, {
  name: id, metric: METRIC.STEPS, direction: AT_LEAST, target: 100, period: PERIOD.DAY,
  aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
  grace: { earnEvery: 0, cap: 0 }, ...over,
}), at(born));

/** Four weeks of two people, both patchy in different rhythms so the weeks have real winners. */
function group(extra = []) {
  const events = [E(ev.member("a", "A"), at(0)), E(ev.member("b", "B"), at(0)), habitOn("steps", 0)];
  for (let n = 0; n < 28; n += 1) {
    events.push(E(ev.log("steps", "a", day(n), n % 5 ? 500 : 0, SOURCE.MANUAL), at(n)));
    events.push(E(ev.log("steps", "b", day(n), n % 3 ? 500 : 0, SOURCE.MANUAL), at(n)));
  }
  return replay([...events, ...extra]);
}

/** Weeks one and two, which were over and done with by day 13. */
const SETTLED = [isoWeekKey(day(0)), isoWeekKey(day(7))];
const readSettled = (state) => JSON.stringify(SETTLED.map((w) =>
  weekStandings(state, ["a", "b"], w).map((r) => ({ m: r.memberId, pct: r.pct, crown: !!r.crown }))));

const BEFORE = readSettled(group());

// ---------------------------------------------------------------------------
// The one that was broken
// ---------------------------------------------------------------------------

test("a habit added today does not re-score last week", () => {
  const after = readSettled(group([habitOn("sleep", 20, { metric: METRIC.SLEEP })]));
  assert.equal(after, BEFORE, "weeks one and two moved when a habit was added on day 20");
});

test("a habit cannot be failed on a day before it existed", () => {
  // The mechanism underneath, stated on its own so the reason survives if the test above is ever
  // rewritten. A habit nobody had yet is not a habit anybody missed.
  const s = group([habitOn("sleep", 20, { metric: METRIC.SLEEP })]);
  const early = dayScore(s, "a", day(5), day(27));
  const sleep = early.categories.flatMap((c) => c.habits || []).find((h) => h.habitId === "sleep");
  assert.ok(!sleep || !sleep.eligible, "sleep was judged on a day two weeks before it was created");
});

test("but it IS scored from the period it was born in", () => {
  // The other half, and the reason this is not simply "ignore new habits". A habit created on day
  // 20 counts from day 20 — the same rule walk() uses for streaks, so a card and the board cannot
  // disagree about when a habit started mattering.
  const s = group([habitOn("sleep", 20, { metric: METRIC.SLEEP })]);
  const later = dayScore(s, "a", day(24), day(27));
  const sleep = later.categories.flatMap((c) => c.habits || []).find((h) => h.habitId === "sleep");
  assert.ok(sleep && sleep.eligible, "sleep was still ignored four days after it was created");
});

// ---------------------------------------------------------------------------
// Everything else that happens later
// ---------------------------------------------------------------------------

test("changing a goal today does not re-score last week", () => {
  assert.equal(readSettled(group([E(ev.goal("a", "steps", { target: 9000 }), at(20))])), BEFORE);
});

test("opting out today does not re-score last week", () => {
  assert.equal(readSettled(group([E(ev.goal("b", "steps", { active: false }), at(20))])), BEFORE);
});

test("somebody joining today does not re-score last week", () => {
  assert.equal(readSettled(group([E(ev.member("c", "C"), at(20))])), BEFORE);
});

test("a log for a recent day does not re-score last week", () => {
  // Backfill is allowed within the window and must land only where it belongs.
  assert.equal(readSettled(group([E(ev.log("steps", "b", day(26), 500, SOURCE.MANUAL), at(26))])), BEFORE);
});

// ---------------------------------------------------------------------------
// And the standings built on those weeks
// ---------------------------------------------------------------------------

test("crowns already awarded are not taken back", () => {
  // The consequence a group would actually notice: not a percentage moving, but somebody losing a
  // week they had already won.
  const crownsIn = (state) => seasonTally(state, ["a", "b"], day(14)).rows
    .map((r) => r.memberId + ":" + r.crowns).sort().join(",");
  const before = crownsIn(group());
  for (const change of [
    habitOn("sleep", 20, { metric: METRIC.SLEEP }),
    E(ev.goal("a", "steps", { target: 9000 }), at(20)),
    E(ev.member("c", "C"), at(20)),
  ]) {
    assert.equal(crownsIn(group([change])), before, "a settled crown moved");
  }
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ retroactive: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ retroactive: " + passed + " tests passed");
