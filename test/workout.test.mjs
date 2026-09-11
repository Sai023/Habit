// workout.test.mjs — the decisions a session screen makes before it draws anything.
//
// The screen is a sheet full of +/- buttons and is not testable here. What it decides — which
// session today is, which week of the rope progression Ivan is in, what number a set opens on,
// what a finished session adds up to — is, and these are the decisions that make the feature
// usable mid-workout or not. A prefill that is wrong by one is a set that costs three taps
// instead of one, which nobody reports and everybody stops using.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { PROGRAMS, PROGRAM_LIST } from "../js/programs.js";
import {
  programFor, planFor, progressionWeek, intervalsFor, lastSession, prefill, prescription,
  summarise, isComplete, progress, unitOf,
} from "../js/workout.js";
import { ev, T, METRIC, AT_LEAST, AGGREGATE, SOURCE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const MON = "2026-09-07"; // a Monday
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T09:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "w" + ++seq, ts, seq, ...spec });

const ME = "m1";
const FIT = PROGRAMS["match-fit"];
const ROPE = PROGRAMS["rope-protocol"];

function state(events = []) {
  return replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sahil"), at(0)),
    ...events,
  ]);
}

// ---------------------------------------------------------------------------
// The data itself
// ---------------------------------------------------------------------------

test("both programs cover every weekday", () => {
  for (const p of PROGRAM_LIST) {
    for (let d = 1; d <= 7; d += 1) {
      assert.ok(d in p.schedule, p.name + " has nothing for weekday " + d);
    }
  }
});

test("every scheduled session exists, and every exercise has a prescription", () => {
  for (const p of PROGRAM_LIST) {
    for (const slot of Object.values(p.schedule)) {
      if (typeof slot !== "string") continue;
      const s = p.sessions[slot];
      assert.ok(s, p.name + " schedules " + slot + " which does not exist");
      for (const ex of s.exercises || []) {
        assert.ok(ex.reps || ex.seconds, ex.name + " has neither reps nor seconds");
        assert.ok(!(ex.reps && ex.seconds), ex.name + " has both");
        assert.ok(ex.sets >= 1, ex.name + " has no sets");
        const [lo, hi] = ex.reps || ex.seconds;
        assert.ok(lo <= hi, ex.name + " range is backwards");
      }
    }
  }
});

test("tennis is a rest day the schedule names and nothing can log against", () => {
  const thu = planFor(FIT, "2026-09-10");
  assert.equal(thu.rest, "Tennis");
  assert.equal(thu.session, undefined);
});

test("the rope progression is contiguous and ends open", () => {
  const stages = ROPE.sessions.rope.progression;
  assert.equal(stages[0].fromWeek, 1);
  for (let i = 1; i < stages.length; i += 1) {
    assert.equal(stages[i].fromWeek, stages[i - 1].toWeek + 1, "gap before stage " + i);
  }
  assert.equal(stages[stages.length - 1].toWeek, null);
});

// ---------------------------------------------------------------------------
// Which session today is
// ---------------------------------------------------------------------------

test("a member with no program has no plan", () => {
  const s = state();
  assert.equal(programFor(s, ME), null);
  assert.equal(planFor(null, day(0)), null);
});

test("choosing a program is one event, and the latest wins", () => {
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.program(ME, "rope-protocol"), at(1)),
  ]);
  assert.equal(programFor(s, ME).id, "rope-protocol");
});

test("choosing none takes you off a program", () => {
  const s = state([E(ev.program(ME, "match-fit"), at(0)), E(ev.program(ME, null), at(1))]);
  assert.equal(programFor(s, ME), null);
});

test("Monday on Match Fit is Push + Core, Friday is the circuit", () => {
  assert.equal(planFor(FIT, day(0)).session.name, "Push + Core");
  assert.equal(planFor(FIT, day(4)).session.name, "Metabolic Circuit");
  assert.equal(planFor(FIT, day(2)).rest, "Rest");
});

// ---------------------------------------------------------------------------
// The rope progression
// ---------------------------------------------------------------------------

test("week 1 is the start day and the six after it", () => {
  assert.equal(progressionWeek(ROPE, "2026-09-02"), 1);
  assert.equal(progressionWeek(ROPE, "2026-09-08"), 1);
  assert.equal(progressionWeek(ROPE, "2026-09-09"), 2);
});

test("before the start it is still week 1, not week zero or minus one", () => {
  assert.equal(progressionWeek(ROPE, "2026-08-20"), 1);
});

test("the prescription in force follows the week", () => {
  const rope = ROPE.sessions.rope;
  assert.equal(intervalsFor(ROPE, rope, "2026-09-02").name, "Rope prep — no jumping");
  assert.equal(intervalsFor(ROPE, rope, "2026-09-16").name, "First skipping intervals"); // week 3
  assert.equal(intervalsFor(ROPE, rope, "2026-11-04").week, 10);
  assert.equal(intervalsFor(ROPE, rope, "2026-11-04").name, "Extended intervals");
});

test("past the last stage it stays on the last stage", () => {
  const rope = ROPE.sessions.rope;
  const late = intervalsFor(ROPE, rope, "2027-06-01");
  assert.equal(late.name, "Continuous blocks");
  assert.ok(late.week > 15);
});

test("a sets session has no intervals", () => {
  assert.equal(intervalsFor(FIT, FIT.sessions["push-core"], day(0)), null);
});

// ---------------------------------------------------------------------------
// What a set opens on
// ---------------------------------------------------------------------------

const PUSHUP = FIT.sessions["push-core"].exercises[0];

test("the first time ever, a set opens on the low end of the range", () => {
  assert.equal(prefill(PUSHUP, null, 0), 8);
  assert.equal(prefill(PUSHUP, null, 2), 8);
});

test("after that, it opens on last time's number for that set", () => {
  const previous = { exercises: [{ id: "pushup", sets: [10, 9, 8] }] };
  assert.equal(prefill(PUSHUP, previous, 0), 10);
  assert.equal(prefill(PUSHUP, previous, 1), 9);
  assert.equal(prefill(PUSHUP, previous, 2), 8);
});

test("a set they did not reach last time opens on the last one they did", () => {
  const previous = { exercises: [{ id: "pushup", sets: [12, 11] }] };
  assert.equal(prefill(PUSHUP, previous, 2), 11, "not the floor of 8 — that reads as a regression");
});

test("an exercise not in last time's session opens on the floor", () => {
  const previous = { exercises: [{ id: "squat", sets: [15, 15, 15] }] };
  assert.equal(prefill(PUSHUP, previous, 0), 8);
});

test("last session means the most recent one BEFORE today, of the same kind", () => {
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(0), { exercises: [{ id: "pushup", sets: [8, 8, 8] }] }), at(0)),
    E(ev.workout(ME, "match-fit", "legs-pull", day(1), { exercises: [{ id: "squat", sets: [15, 15, 15] }] }), at(1)),
    E(ev.workout(ME, "match-fit", "push-core", day(7), { exercises: [{ id: "pushup", sets: [10, 10, 9] }] }), at(7)),
  ]);
  const last = lastSession(s, ME, "push-core", day(14));
  assert.equal(last.day, day(7));
  assert.deepEqual(last.exercises[0].sets, [10, 10, 9]);
  // Not the legs day, however recent.
  assert.equal(lastSession(s, ME, "legs-pull", day(14)).day, day(1));
});

test("today's own Finish is not last time", () => {
  // Reopening today after finishing must prefill from the session before, or a second Finish
  // sees itself in the mirror.
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(0), { exercises: [{ id: "pushup", sets: [8, 8, 8] }] }), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(7), { exercises: [{ id: "pushup", sets: [12, 12, 12] }] }), at(7)),
  ]);
  assert.equal(lastSession(s, ME, "push-core", day(7)).day, day(0));
});

// ---------------------------------------------------------------------------
// Replay rules
// ---------------------------------------------------------------------------

test("finishing the same session twice in a day corrects rather than duplicates", () => {
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(0), { exercises: [{ id: "pushup", sets: [8, 8, 8] }] }), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(0), { exercises: [{ id: "pushup", sets: [8, 8, 9] }] }), at(0) + 1000),
  ]);
  const list = s.workouts.get(ME);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].exercises[0].sets, [8, 8, 9]);
});

test("a workout written for last month is refused, like a log would be", () => {
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", "2026-08-01", { exercises: [] }), at(10)),
  ]);
  assert.equal((s.workouts.get(ME) || []).length, 0);
});

test("a workout is a real event type", () => {
  const spec = ev.workout(ME, "match-fit", "push-core", day(0), { exercises: [] });
  assert.equal(spec.type, T.WORKOUT);
  assert.equal(spec.payload.sessionId, "push-core");
});

// ---------------------------------------------------------------------------
// Words on the card
// ---------------------------------------------------------------------------

test("prescriptions read the way the document writes them", () => {
  const legs = FIT.sessions["legs-pull"].exercises;
  assert.equal(prescription(PUSHUP), "3 × 8–15");
  assert.equal(prescription(legs.find((e) => e.id === "reverse-lunge")), "3 × 10/side");
  assert.equal(prescription(legs.find((e) => e.id === "hollow-hold")), "3 × 20–30s");
  assert.equal(prescription(ROPE.sessions["strength-a"].exercises.find((e) => e.id === "rdl")), "3 × 10");
});

test("a hold counts seconds, a movement counts reps, and a tap counts taps", () => {
  assert.equal(unitOf(PUSHUP), "reps");
  assert.equal(unitOf(FIT.sessions["push-core"].exercises.find((e) => e.id === "plank")), "s");
  assert.equal(unitOf(FIT.sessions.circuit.exercises.find((e) => e.id === "shoulder-tap")), "taps");
});

// ---------------------------------------------------------------------------
// Adding up
// ---------------------------------------------------------------------------

test("a finished session summarises per exercise", () => {
  const session = FIT.sessions["push-core"];
  const logged = { exercises: [{ id: "pushup", sets: [12, 11, 10] }, { id: "plank", sets: [40, 40] }] };
  const rows = summarise(session, logged);
  const pushup = rows.find((r) => r.id === "pushup");
  assert.equal(pushup.total, 33);
  assert.equal(pushup.best, 12);
  assert.equal(pushup.done, 3);
  const plank = rows.find((r) => r.id === "plank");
  assert.equal(plank.done, 2);
  assert.equal(plank.of, 3);
  const dip = rows.find((r) => r.id === "dip");
  assert.equal(dip.done, 0);
  assert.equal(dip.best, null);
});

test("complete means every prescribed set banked", () => {
  const session = FIT.sessions["push-core"];
  const full = {};
  for (const ex of session.exercises) full[ex.id] = [1, 1, 1];
  assert.equal(isComplete(session, full), true);
  const partial = { ...full, plank: [30, 30] };
  assert.equal(isComplete(session, partial), false);
  assert.deepEqual(progress(session, partial), { done: 14, of: 15 });
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ workout: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ workout: " + passed + " tests passed");
