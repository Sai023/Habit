// legacy.test.mjs — metrics that have been retired, and the history filed under them.
//
// The log is append-only and every device replays all of it, so a metric cannot simply be deleted
// from the vocabulary: rows written under the old name are still in the room and always will be.
// Translating on READ migrates every phone at once, needs no write to the shared log, and leaves
// the history honest about what was actually recorded.
//
// `urges` is the first of these. It counted "times you gave in" and was built for single digits;
// the group used it as a puff counter, with a ceiling of eighty and seventy-eight logged on an
// ordinary day. Retiring it is a RENAME, not a unit change — the numbers already were puffs — so
// the test that matters is that nothing about a past day's score moves.

import assert from "node:assert/strict";
import { replay, rawDayStatus, targetFor, HIT, MISS } from "../js/habits.js";
import { dayScore, categoryFor, CATEGORY } from "../js/score.js";
import {
  ev, SOURCE, AT_MOST, AGGREGATE, METRIC, LEGACY_METRIC, isInterventionHabit,
} from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const DAY = "2026-03-02";
let seq = 0;
const at = (d, h = 12) => Date.parse(d + "T" + String(h).padStart(2, "0") + ":00:00Z");
const E = (spec, ts) => ({ eventId: "l" + ++seq, ts, seq, ...spec });

/** A vape habit exactly as the live room has it: filed under the retired metric name. */
function oldRoom(logged) {
  return replay([
    E(ev.member("me", "You"), at(DAY, 6)),
    E(ev.habit("vape", {
      name: "Vape urges", metric: "urges", direction: AT_MOST, target: 80,
      aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
    }), at(DAY, 6)),
    ...logged.map((v, i) => E(ev.log("vape", "me", DAY, v, SOURCE.MANUAL), at(DAY, 8 + i))),
  ]);
}

test("a habit filed under the old metric replays as the new one", () => {
  const habit = oldRoom([]).habits.get("vape");
  assert.equal(habit.metric, METRIC.PUFFS);
  assert.equal(LEGACY_METRIC.urges, METRIC.PUFFS);
});

test("it stays in Discipline, so the day's shares do not move", () => {
  // The failure that would have hurt most, and silently: an unrecognised metric falls back to
  // Rest & recovery, which would have moved the vape from a 30-point category to a 15-point one
  // and quietly rescored every day in the room.
  assert.equal(categoryFor(oldRoom([]).habits.get("vape")), CATEGORY.DISCIPLINE);
});

test("the breathing screen still recognises it", () => {
  // isInterventionHabit is what puts "I want to vape" on the card. Keyed on the metric, so a
  // rename that missed this would have removed the button from a habit that had it yesterday.
  assert.ok(isInterventionHabit(oldRoom([]).habits.get("vape")));
});

test("past logs keep their meaning, and the day scores identically", () => {
  // Seventy-eight against a ceiling of eighty: a hit before the rename and a hit after it, worth
  // the same. The values were always puff counts; only the word changed.
  const s = oldRoom([40, 30, 8]);
  const habit = s.habits.get("vape");
  assert.equal(targetFor(s, habit, "me", DAY), 80);
  assert.equal(rawDayStatus(s, habit, "me", DAY), HIT);
  assert.equal(dayScore(s, "me", DAY, DAY).pct, 100);
});

test("and going over is still going over", () => {
  const s = oldRoom([50, 40]);
  assert.equal(rawDayStatus(s, s.habits.get("vape"), "me", DAY), MISS);
  assert.equal(dayScore(s, "me", DAY, DAY).pct, 0);
});

test("a habit already using the new name is untouched", () => {
  const s = replay([
    E(ev.member("me", "You"), at(DAY, 6)),
    E(ev.habit("vape", {
      name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
      aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
    }), at(DAY, 6)),
  ]);
  assert.equal(s.habits.get("vape").metric, METRIC.PUFFS);
});

test("an unknown metric is left alone rather than guessed at", () => {
  // Forward compatibility: a metric a LATER build introduces must not be rewritten by this one.
  const s = replay([
    E(ev.member("me", "You"), at(DAY, 6)),
    E(ev.habit("x", {
      name: "Something new", metric: "hydration", direction: AT_MOST, target: 5,
      aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
    }), at(DAY, 6)),
  ]);
  assert.equal(s.habits.get("x").metric, "hydration");
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ legacy: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ legacy: " + passed + " tests passed");
