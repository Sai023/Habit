// season-reset.test.mjs — clearing the scoreboard without clearing anything else.
//
// A group spends its first weeks getting the thing working, and those weeks are not a contest:
// they are a phone syncing as the wrong person, a metric being renamed, a taper being argued
// about. Carrying that into standings meant to last leaves the season opening with results nobody
// agrees with and no way to draw a line under them.
//
// So the line moves. The promise it makes is narrow and has to be exact, because "reset" is a word
// people have learned to read as "lose everything":
//
//   • weeks before the line stop being tallied
//   • every habit, target, taper, logged number and per-habit streak is untouched
//   • nothing is deleted — the log is append-only and this writes one group setting
//
// The second bullet is the one worth testing hardest. A reset that quietly took a streak with it
// would be discovered by somebody who had just lost twenty days of one.

import assert from "node:assert/strict";
import { replay, addDays, walk, targetFor, valueOn, rawDayStatus, HIT } from "../js/habits.js";
import { seasonStart, seasonTally, seasonWeeks } from "../js/season.js";
import { ev, SOURCE, AT_LEAST, AGGREGATE, METRIC } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MON = "2026-03-02"; // a Monday
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "r" + ++seq, ts, seq, ...spec });

const TODAY = day(28); // four full weeks later

/** Four weeks of a two-person group, both logging every day. */
function group(extra = []) {
  const events = [
    E(ev.member("a", "Alice"), at(0)),
    E(ev.member("b", "Bob"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
    }), at(0)),
  ];
  for (let n = 0; n <= 28; n += 1) {
    events.push(E(ev.log("steps", "a", day(n), 12000, SOURCE.MANUAL), at(n)));
    events.push(E(ev.log("steps", "b", day(n), 11000, SOURCE.MANUAL), at(n)));
  }
  return replay([...events, ...extra]);
}

// ---------------------------------------------------------------------------
// The scoreboard
// ---------------------------------------------------------------------------

test("without a line, the season runs from the first habit", () => {
  const s = group();
  assert.equal(seasonStart(s), MON);
  assert.ok(seasonTally(s, ["a", "b"], TODAY).weeks >= 3);
});

test("moving the line drops the weeks before it, and keeps the ones after", () => {
  // day(21) is a Monday, so the week it opens closes before TODAY and is legitimately the new
  // season's first week. What must be gone is everything BEFORE the line — the three weeks the
  // group spent getting the thing working.
  const before = seasonTally(group(), ["a", "b"], TODAY);
  const after = seasonTally(
    group([E(ev.meta({ seasonFrom: day(21) }), at(21))]), ["a", "b"], TODAY,
  );

  assert.equal(before.weeks, 4, "four completed weeks before the reset");
  assert.equal(after.weeks, 1, "and one after it — the week the line opened");

  for (const row of after.rows) {
    assert.ok(row.weeks <= 1, "nobody has played more weeks than the season has run");
    assert.ok(row.crowns <= 1, "and cannot have won more than it has held");
  }
  // The totals really did fall away rather than merely being relabelled.
  const oldTop = Math.max(...before.rows.map((r) => r.points));
  const newTop = Math.max(...after.rows.map((r) => r.points));
  assert.ok(newTop < oldTop / 2, "points start again: " + newTop + " against " + oldTop);
});

test("a line set today starts the season next week, not mid-week", () => {
  // seasonTally only counts COMPLETED weeks, so a line drawn inside this one leaves nothing
  // tallied until it closes — which is what "start a new season" should mean.
  const s = group([E(ev.meta({ seasonFrom: day(28) }), at(28))]);
  assert.equal(seasonStart(s), day(28));
  assert.equal(seasonTally(s, ["a", "b"], TODAY).weeks, 0);
});

test("the newest line wins, so a season can be restarted again", () => {
  const s = group([
    E(ev.meta({ seasonFrom: day(7) }), at(7)),
    E(ev.meta({ seasonFrom: day(21) }), at(21)),
  ]);
  assert.equal(seasonStart(s), day(21));
});

// ---------------------------------------------------------------------------
// What must survive it
// ---------------------------------------------------------------------------

test("every logged number is still there", () => {
  const s = group([E(ev.meta({ seasonFrom: day(21) }), at(21))]);
  const steps = s.habits.get("steps");
  // Including days from before the line — nothing was deleted, only untallied.
  assert.equal(valueOn(s, steps, "a", day(0)), 12000);
  assert.equal(valueOn(s, steps, "a", day(14)), 12000);
  assert.equal(rawDayStatus(s, steps, "a", day(3)), HIT);
});

test("a per-habit streak runs straight through the line", () => {
  // The one somebody would notice losing. A streak is about showing up, not about standings.
  const plain = walk(group(), "steps", "a", TODAY);
  const reset = walk(group([E(ev.meta({ seasonFrom: day(21) }), at(21))]), "steps", "a", TODAY);
  assert.equal(reset.streak, plain.streak);
  assert.ok(reset.streak > 21, "and it is longer than the new season is old");
});

test("habits, targets and tapers are untouched", () => {
  const s = group([
    E(ev.goal("a", "steps", { target: 8000 }), at(1)),
    E(ev.meta({ seasonFrom: day(21) }), at(21)),
  ]);
  const steps = s.habits.get("steps");
  assert.equal(steps.name, "Steps");
  assert.equal(steps.target, 10000, "the group's number");
  assert.equal(targetFor(s, steps, "a", day(25)), 8000, "and the personal one");
});

test("the group's other settings are not disturbed", () => {
  const s = group([
    E(ev.meta({ name: "The Accountability Club" }), at(0)),
    E(ev.meta({ seasonFrom: day(21) }), at(21)),
  ]);
  assert.equal(s.meta.name, "The Accountability Club", "meta merges rather than replaces");
  assert.equal(s.meta.seasonFrom, day(21));
});

// ---------------------------------------------------------------------------
// Refusing to make things worse
// ---------------------------------------------------------------------------

test("a line before the first habit is ignored, not obeyed", () => {
  // It would describe weeks that never existed, and pad the season with empty ones.
  const s = group([E(ev.meta({ seasonFrom: "2020-01-06" }), at(21))]);
  assert.equal(seasonStart(s), MON);
});

test("a malformed line never blanks the standings", () => {
  for (const bad of ["", "yesterday", "2026-3-2", 20260302, null, {}]) {
    const s = group([E(ev.meta({ seasonFrom: bad }), at(21))]);
    assert.equal(seasonStart(s), MON, "ignored: " + JSON.stringify(bad));
    assert.ok(seasonTally(s, ["a", "b"], TODAY).weeks >= 3);
  }
});

test("weeks are counted from the line, not from the first habit", () => {
  const s = group([E(ev.meta({ seasonFrom: day(14) }), at(14))]);
  const weeks = seasonWeeks(s, TODAY);
  assert.ok(weeks.every((w) => w >= "2026-W12"), "nothing older than the line: " + weeks.join(","));
});

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ season reset: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ season reset: " + passed + " tests passed");
