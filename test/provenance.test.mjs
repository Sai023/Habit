// provenance.test.mjs — how a value got here (entryMethod), and the write-boundary validation
// that keeps a malformed event from ever reaching — or crashing — replay.

import assert from "node:assert/strict";
import { replay, addDays, methodOn, valueOn } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, PERIOD, T, validate, ENTRY_METHOD } from "../js/schema.js";
import { dailyFacts, CONFIDENCE } from "../js/dailyfacts.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const D0 = "2026-03-02";
const day = (n) => addDays(D0, n);
const at = (d, h = 20) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd, h - 2); };
let seq = 0;
const E = (spec, ts) => ({ eventId: "e" + String(++seq).padStart(4, "0"), ts, seq, author: "m1", ...spec });

function withHabits(extra = []) {
  seq = 0;
  return replay([
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.habit("puffs", { name: "Vape", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    ...extra,
  ]);
}
const H = (s, id) => s.habits.get(id);

// ---------------------------------------------------------------------------
// entryMethod: stamped, or derived for older events
// ---------------------------------------------------------------------------

test("an explicit entryMethod is kept", () => {
  const s = withHabits([E(ev.log("puffs", "m1", day(0), 20, SOURCE.MANUAL, null, 500, null, ENTRY_METHOD.METER), at(day(0)))]);
  assert.equal(methodOn(s, H(s, "puffs"), "m1", day(0)), "meter");
});

test("a typed manual number derives 'typed'", () => {
  const s = withHabits([E(ev.log("puffs", "m1", day(0), 20, SOURCE.MANUAL), at(day(0)))]);
  assert.equal(methodOn(s, H(s, "puffs"), "m1", day(0)), "typed");
});

test("an automatic source derives 'sensor'", () => {
  const s = withHabits([E(ev.log("steps", "m1", day(0), 12000, SOURCE.HEALTH_CONNECT), at(day(0)))]);
  assert.equal(methodOn(s, H(s, "steps"), "m1", day(0)), "sensor");
});

test("a manual reading with no explicit method derives 'meter'", () => {
  const s = withHabits([E(ev.log("puffs", "m1", day(0), 20, SOURCE.MANUAL, null, 500), at(day(0)))]);
  assert.equal(methodOn(s, H(s, "puffs"), "m1", day(0)), "meter");
});

test("a manual entry wins the method, same precedence as valueOn", () => {
  const s = withHabits([
    E(ev.log("steps", "m1", day(0), 9000, SOURCE.HEALTH_CONNECT), at(day(0), 8)),
    E(ev.log("steps", "m1", day(0), 12000, SOURCE.MANUAL), at(day(0), 20)),
  ]);
  assert.equal(valueOn(s, H(s, "steps"), "m1", day(0)), 12000, "manual overrides the sensor");
  assert.equal(methodOn(s, H(s, "steps"), "m1", day(0)), "typed", "and its method is what's reported");
});

// ---------------------------------------------------------------------------
// read-model surfaces method + confidence
// ---------------------------------------------------------------------------

test("the read-model carries method and a confidence weight", () => {
  const s = withHabits([
    E(ev.log("steps", "m1", day(0), 12000, SOURCE.HEALTH_CONNECT), at(day(0))),
    E(ev.log("puffs", "m1", day(0), 20, SOURCE.MANUAL), at(day(0))),
  ]);
  const facts = dailyFacts(s, { me: "m1", to: day(0) });
  const steps = facts.find((f) => f.habitId === "steps" && f.day === day(0));
  const puffs = facts.find((f) => f.habitId === "puffs" && f.day === day(0));
  assert.equal(steps.method, "sensor");
  assert.equal(steps.confidence, CONFIDENCE.sensor);
  assert.equal(puffs.method, "typed");
  assert.equal(puffs.confidence, CONFIDENCE.typed);
  assert.ok(steps.confidence > puffs.confidence, "a measurement outweighs a self-reported number");
});

// ---------------------------------------------------------------------------
// validation — the write boundary and the poison-event defence
// ---------------------------------------------------------------------------

test("validate accepts well-formed events and rejects malformed ones", () => {
  assert.equal(validate(T.LOG, { habitId: "steps", memberId: "m1", day: "2026-03-02", value: 10 }), true);
  assert.equal(validate(T.LOG, { habitId: "steps", memberId: "m1" }), false, "no day");
  assert.equal(validate(T.LOG, { habitId: "steps", memberId: "m1", day: "nope", value: 1 }), false, "day not a date");
  assert.equal(validate(T.MEMBER_MERGE, { from: "a", into: "b" }), true);
  assert.equal(validate(T.MEMBER_MERGE, { from: "a" }), false, "no target");
  assert.equal(validate(T.EXEMPT, { memberId: "m1", from: "2026-03-02", to: "2026-03-04" }), true);
  assert.equal(validate(T.META, {}), true);
});

test("replay skips a malformed event instead of letting it through", () => {
  // A right-typed but broken LOG injected straight at the log (the poison-event shape). It must
  // not land, and the good log beside it must be untouched.
  const poison = { eventId: "p1", ts: at(day(1)), seq: 999, author: "x", type: T.LOG, payload: { v: 1, habitId: "steps", memberId: "m1" /* no day, no value */ } };
  const s = withHabits([
    E(ev.log("steps", "m1", day(0), 12000, SOURCE.MANUAL), at(day(0))),
    poison,
  ]);
  assert.equal(valueOn(s, H(s, "steps"), "m1", day(0)), 12000, "the good day is intact");
  const facts = dailyFacts(s, { me: "m1", to: day(1) });
  assert.ok(facts.length > 0, "replay did not throw");
  assert.equal(facts.filter((f) => f.reported).every((f) => f.value != null), true);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ provenance + validation: " + passed + " tests passed");
