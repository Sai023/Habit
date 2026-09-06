// clock.test.mjs — what a wrong device clock can and cannot buy.
//
// ---- The hole ----
//
// Every guard in replay that asks "when was this written" read the device's own claim: the
// backfill window, the no-backdating rule on travel, when a goal change starts counting, a habit's
// birthday. All of them believed a number the phone chose, and a phone with its clock moved is
// answering a different question from every other phone in the group.
//
// The material to check it was already there and already synced. The server stamps arrival on
// every row, `planMerge` keeps it as `serverTs`, and `orderKey` has always used min(claim, arrival)
// for SORT order. Nothing else did, so ordering was clock-hardened and every rule built on top of
// it was not.
//
// ---- Which direction is closed ----
//
// Forward. It is the more useful lie — it wins last-write-wins races, makes "today" a day that has
// not happened, moves a goal change onto a day nobody has played, and pushes a habit's birthday
// later so fewer past days are judged.
//
// Backward is not closed and cannot be from here: an event claiming to be older than its arrival
// is precisely what a week offline looks like. That matters more than it first sounds, because the
// two guards somebody would actually attack — the backfill window and the no-backdating rule on
// travel — both need a BACKWARD clock, and both are therefore untouched by this. Two tests below
// say so out loud rather than leaving the gap to be rediscovered.
//
// Closing it means choosing arrival over the claim, which refuses a deliberately backdated log and
// an honest one written offline in exactly the same breath. T.LOG already states which of those
// the app protects.

import assert from "node:assert/strict";
import { replay, addDays, authoredAt, orderKey } from "../js/habits.js";
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

/** An event with a claimed time and, optionally, the time the server actually saw it. */
const E = (spec, ts, serverTs) => ({
  eventId: "k" + ++seq, ts, serverTs, seq, ...spec,
});

const HABIT = {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 100,
  period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
  tz: TZ, dayStartHour: 4, grace: { earnEvery: 0, cap: 0 },
};
const base = () => [E(ev.member("me", "Me"), at(0)), E(ev.habit("h", HABIT), at(0))];
const logged = (s, n) => (s.logs.get("h|me|" + day(n)) || []).length;

// ---------------------------------------------------------------------------
// The bound itself
// ---------------------------------------------------------------------------

test("a claim later than arrival is clamped to arrival", () => {
  assert.equal(authoredAt({ ts: at(10), serverTs: at(4) }), at(4));
});

test("a claim earlier than arrival is kept", () => {
  // The offline case, and the reason this only ever clamps DOWN.
  assert.equal(authoredAt({ ts: at(2), serverTs: at(9) }), at(2));
});

test("no arrival stamp means the claim stands", () => {
  // Everything is in this state between being written and being synced, including on a device
  // that has never been online.
  assert.equal(authoredAt({ ts: at(5) }), at(5));
  assert.equal(authoredAt({ ts: at(5), serverTs: 0 }), at(5));
});

test("ordering asks the same question through the same function", () => {
  // These were two copies of one rule about trusting clocks, and only one of them was applied to
  // anything that scores.
  const e = { ts: at(10), serverTs: at(4) };
  assert.equal(orderKey(e), authoredAt(e));
});

// ---------------------------------------------------------------------------
// A clock set back — the direction this does NOT close
// ---------------------------------------------------------------------------

test("a clock set BACK still backfills, and that is not an oversight", () => {
  // Written down because it is the obvious thing to expect this change to fix, and it does not.
  //
  // To reach day 4 from day 9 with a two-day window you move the clock BACK, so the claim is
  // EARLIER than arrival — and the bound only ever clamps DOWN, so the claim stands. Choosing
  // arrival instead would refuse this, and would refuse the identical event from somebody who
  // logged on the day with no signal and synced a week later. The two are indistinguishable in the
  // log, and T.LOG says in as many words which one it protects.
  //
  // So the backfill window remains what it always was: a bound on honest lateness, not a defence
  // against a deliberately wrong clock.
  const s = replay([
    ...base(),
    E(ev.log("h", "me", day(4), 500, SOURCE.MANUAL), at(5), at(9)),
  ]);
  assert.equal(logged(s, 4), 1);
});

test("and travel booked on a clock set back is likewise still accepted", () => {
  // Same shape, same reason. The no-backdating rule compares the period's start against the
  // authoring day, and an earlier claim survives the clamp. Worth a test so nobody reads the
  // travel rule as clock-proof when it is only log-proof.
  const s = replay([
    ...base(),
    E(ev.exempt("me", day(8), day(11), "travel", null, "x1"), at(8), at(12)),
  ]);
  assert.equal(s.exemptions.length, 1);
});

// ---------------------------------------------------------------------------
// A clock set forward — the direction it does
// ---------------------------------------------------------------------------

test("a fast clock cannot move a habit's birthday forward", () => {
  // Later birthday means fewer past days judged. Claiming day 10 while the server saw day 3 would
  // quietly delete a week of scoring for everybody, since createdDay is the group's.
  const s = replay([
    E(ev.member("me", "Me"), at(0)),
    E(ev.habit("h", HABIT), at(10), at(3)),
  ]);
  assert.equal(s.habits.get("h").createdDay, day(3));
});

test("a fast clock cannot start a goal change on a day nobody has played", () => {
  // A goal counts from the day AFTER it was set, so claiming a later day pushes an easier target
  // into the future rather than into the past — which sounds harmless until it is a HIGHER target
  // being deferred past a week somebody wants scored on the old one.
  const s = replay([
    ...base(),
    E(ev.goal("me", "h", { target: 50 }), at(0), at(0)),
    E(ev.goal("me", "h", { target: 9000 }), at(12), at(5)),
  ]);
  const list = s.goals.get("me|h");
  assert.equal(list[list.length - 1].from, day(6), "counts from the day after ARRIVAL, not the claim");
});

// ---------------------------------------------------------------------------
// What must keep working
// ---------------------------------------------------------------------------

test("a week offline still backfills correctly", () => {
  // The promise the clamp must not break, and the reason it only goes one way. Logged on the day,
  // on a phone with no signal, synced a week later: the claim is EARLIER than arrival, so it
  // stands, and the log lands on the day it was actually made.
  const s = replay([
    ...base(),
    E(ev.log("h", "me", day(4), 500, SOURCE.MANUAL), at(4), at(11)),
  ]);
  assert.equal(logged(s, 4), 1, "an honest offline log survived");
});

test("travel booked offline and synced later still holds", () => {
  const s = replay([
    ...base(),
    E(ev.exempt("me", day(6), day(8), "travel", null, "x1"), at(5), at(14)),
  ]);
  assert.equal(s.exemptions.length, 1);
  assert.equal(s.exemptions[0].from, day(6));
});

test("the clamp does not depend on which device is replaying", () => {
  // Every phone replays the same log and must derive the same answers. The bound uses only fields
  // carried on the event, so it cannot come out differently anywhere.
  const events = [
    ...base(),
    E(ev.log("h", "me", day(4), 500, SOURCE.MANUAL), at(5), at(9)),
    E(ev.log("h", "me", day(6), 500, SOURCE.MANUAL), at(6), at(6)),
  ];
  const a = replay(events);
  const b = replay([...events].reverse());
  assert.equal(logged(a, 4), logged(b, 4));
  assert.equal(logged(a, 6), logged(b, 6));
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ clock: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ clock: " + passed + " tests passed");
