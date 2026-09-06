// travel.test.mjs — booking days off, and the two ways that could be abused.
//
// ---- What travel is for ----
//
// Days you were away are left OUT of the score rather than counted against you, and streaks are
// held where they were. The engine has understood this since the four states were written; until
// now nothing could set one, so a holiday broke every streak in the group.
//
// ---- The two abuses ----
//
// An exemption DELETES days rather than adding them, which makes it the only thing in this app
// that can improve a week that has already happened. Two moves would do it:
//
//   1. booking a period that reaches backwards — "I was away last week"
//   2. ending one in a way that moves its start, or extends its end
//
// The first is refused outright. The second is why ending is expressed as "bring the last day
// forward" and nothing else: there is no shape of that edit which excuses a day it did not
// already cover.

import assert from "node:assert/strict";
import { replay, addDays, travelPeriod, rawDayStatus, streak, EXEMPT, MISS } from "../js/habits.js";
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
const at = (n) => Date.parse(day(n) + "T09:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "t" + ++seq, ts, seq, ...spec });

/** One person, one daily habit, logged every day up to `logged` and silent after. */
function world(extra = [], logged = 6) {
  const events = [
    E(ev.member("me", "Me"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 100,
      period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4, grace: { earnEvery: 0, cap: 0 },
    }), at(0)),
  ];
  for (let n = 0; n <= logged; n += 1) {
    events.push(E(ev.log("steps", "me", day(n), 500, SOURCE.MANUAL), at(n)));
  }
  return replay([...events, ...extra]);
}

const statusOn = (s, n) =>
  rawDayStatus(s, s.habits.get("steps"), "me", day(n), day(20));

// ---------------------------------------------------------------------------
// Booking it
// ---------------------------------------------------------------------------

test("days inside a booked period are exempt, not missed", () => {
  const s = world([E(ev.exempt("me", day(10), day(12), "travel", null, "x1"), at(9))]);
  for (const n of [10, 11, 12]) assert.equal(statusOn(s, n), EXEMPT, "day " + n);
});

test("the day before and the day after are not", () => {
  // The boundary, in both directions. An off-by-one here silently gives away a free day.
  const s = world([E(ev.exempt("me", day(10), day(12), "travel", null, "x1"), at(9))]);
  assert.equal(statusOn(s, 9), MISS);
  assert.equal(statusOn(s, 13), MISS);
});

test("a streak survives the trip it was interrupted by", () => {
  // The whole promise. Seven clean days, three away, and the run continues rather than restarting.
  const s = world([E(ev.exempt("me", day(7), day(9), "travel", null, "x1"), at(6))]);
  const before = streak(world(), "steps", "me", day(6));
  const after = streak(s, "steps", "me", day(9));
  assert.ok(after >= before, "streak went backwards over travel: " + before + " -> " + after);
});

test("booking today, for today, is allowed", () => {
  const s = world([E(ev.exempt("me", day(4), day(6), "travel", null, "x1"), at(4))]);
  assert.equal(statusOn(s, 4), EXEMPT);
});

// ---------------------------------------------------------------------------
// It cannot reach backwards
// ---------------------------------------------------------------------------

test("a period starting yesterday is refused outright", () => {
  // Not clamped, not shortened — dropped. A partially-honoured cheat is still a cheat, and the
  // person who tried it would be looking at a screen that showed them getting away with some of it.
  const s = world([E(ev.exempt("me", day(3), day(6), "travel", null, "x1"), at(4))]);
  // Days 3-6 were logged, so they are hits rather than misses — the point is that none of them is
  // EXEMPT. Asserting "not exempt" rather than "missed" is what makes this a test about the
  // exemption being dropped rather than about the fixture's logging.
  for (const n of [3, 5, 6]) assert.notEqual(statusOn(s, n), EXEMPT, "day " + n);
  assert.equal(travelPeriod(s, "me", day(4)), null);
});

test("a period starting last week is refused", () => {
  const s = world([E(ev.exempt("me", day(0), day(6), "travel", null, "x1"), at(6))]);
  for (const n of [0, 2, 4]) assert.notEqual(statusOn(s, n), EXEMPT, "day " + n);
});

// ---------------------------------------------------------------------------
// Ending it
// ---------------------------------------------------------------------------

test("coming home early re-judges the days after you are back", () => {
  const s = world([
    E(ev.exempt("me", day(8), day(14), "travel", null, "x1"), at(7)),
    // Home on day 11: the period is cut to end on day 10.
    E(ev.exempt("me", day(8), day(10), "travel", null, "x1"), at(11)),
  ], 6);
  assert.equal(statusOn(s, 9), EXEMPT, "still away");
  assert.equal(statusOn(s, 10), EXEMPT, "last day away");
  assert.equal(statusOn(s, 11), MISS, "back, and counted again");
});

test("cancelling one that has not started leaves nothing behind", () => {
  const s = world([
    E(ev.exempt("me", day(10), day(14), "travel", null, "x1"), at(6)),
    E(ev.exempt("me", day(10), day(9), "travel", null, "x1"), at(7)),
  ]);
  assert.equal(travelPeriod(s, "me", day(8)), null, "nothing booked any more");
  assert.equal(statusOn(s, 11), MISS);
});

test("ending one cannot EXTEND it", () => {
  // The obvious way to turn the end-early edit into a cheat: send the same id back with a later
  // `to` and quietly buy another week. Only a move forward is honoured.
  const s = world([
    E(ev.exempt("me", day(8), day(9), "travel", null, "x1"), at(7)),
    E(ev.exempt("me", day(8), day(20), "travel", null, "x1"), at(10)),
  ]);
  assert.equal(statusOn(s, 9), EXEMPT);
  assert.equal(statusOn(s, 12), MISS, "the extension was ignored");
});

test("ending one cannot move its start backwards", () => {
  // The other half. `from` is fixed at creation, so a supersede carrying an earlier one changes
  // nothing — otherwise "I came home early" would be a way to say "and I left earlier too".
  const s = world([
    E(ev.exempt("me", day(8), day(10), "travel", null, "x1"), at(7)),
    E(ev.exempt("me", day(2), day(10), "travel", null, "x1"), at(9)),
  ]);
  assert.notEqual(statusOn(s, 2), EXEMPT, "the earlier start was ignored");
  assert.equal(statusOn(s, 8), EXEMPT, "and the real period is untouched");
});

test("somebody else's id is not mine to end", () => {
  // The supersede is matched on member as well as id, so a crafted event cannot cancel a trip
  // belonging to another member.
  const s = replay([
    E(ev.member("me", "Me"), at(0)),
    E(ev.member("you", "You"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 100,
      period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4,
    }), at(0)),
    E(ev.exempt("me", day(8), day(12), "travel", null, "x1"), at(7)),
    E(ev.exempt("you", day(8), day(9), "travel", null, "x1"), at(8)),
  ]);
  const mine = travelPeriod(s, "me", day(10));
  assert.ok(mine, "my trip still exists");
  assert.equal(mine.to, day(12), "and was not cut short by somebody else's event");
});

// ---------------------------------------------------------------------------
// What the screens ask
// ---------------------------------------------------------------------------

test("travelPeriod finds the one running now", () => {
  const s = world([E(ev.exempt("me", day(8), day(12), "travel", null, "x1"), at(7))]);
  const p = travelPeriod(s, "me", day(10));
  assert.equal(p.from, day(8));
  assert.equal(p.to, day(12));
});

test("and the next one when none is running", () => {
  // So a screen can say "away from Friday" without asking a second question.
  const s = world([E(ev.exempt("me", day(15), day(18), "travel", null, "x1"), at(7))]);
  const p = travelPeriod(s, "me", day(10));
  assert.equal(p.from, day(15));
});

test("a finished trip is not offered as either", () => {
  const s = world([E(ev.exempt("me", day(2), day(4), "travel", null, "x1"), at(1))]);
  assert.equal(travelPeriod(s, "me", day(10)), null);
});

test("a per-habit exemption is not travel", () => {
  // Travel is whole-group by definition. A habit-scoped exemption is a different thing with no UI,
  // and showing "you are away" because of one would be a lie on the busiest screen in the app.
  const s = world([E(ev.exempt("me", day(8), day(12), "travel", "steps", "x1"), at(7))]);
  assert.equal(travelPeriod(s, "me", day(10)), null);
});

// ---------------------------------------------------------------------------
// A trip does not excuse a week
// ---------------------------------------------------------------------------

test("a weekly habit is NOT exempt when only part of its week is away", () => {
  // The thing the banner nearly lied about. "Three workouts a week" with three days abroad is
  // still three workouts a week — four days remain and the target is still reachable, so the
  // engine keeps asking. Pausing it would hand out a free week for a long weekend.
  const events = [
    E(ev.member("me", "Me"), at(0)),
    E(ev.habit("gym", {
      name: "Workouts", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3,
      period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4,
    }), at(0)),
    // MON is a Monday, so days 0-6 are one ISO week. Away for three of them.
    E(ev.exempt("me", day(1), day(3), "travel", null, "x1"), at(0)),
  ];
  const s = replay(events);
  const status = rawDayStatus(s, s.habits.get("gym"), "me", day(2), day(20));
  assert.notEqual(status, EXEMPT, "a partial week is still a week you can win");
});

test("but it IS exempt when the whole week is away", () => {
  // The other half, and the rule stated: every day of the period has to be covered.
  const events = [
    E(ev.member("me", "Me"), at(0)),
    E(ev.habit("gym", {
      name: "Workouts", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3,
      period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4,
    }), at(0)),
    E(ev.exempt("me", day(0), day(6), "travel", null, "x1"), at(0)),
  ];
  const s = replay(events);
  assert.equal(rawDayStatus(s, s.habits.get("gym"), "me", day(3), day(20)), EXEMPT);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ travel: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ travel: " + passed + " tests passed");
