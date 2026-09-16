// vitals.test.mjs — what the watch said about the workouts, laid over the sets by the clock.
//
// The join is time: each stamped set owns the minutes since the one before it, the phone reads
// the watch for exactly those minutes, and a T.VITALS event brings the answer back. The failures
// worth catching: vitals landing on the wrong workout, a late read rolling back a fuller one, a
// ranking spoken from one Tuesday, and a workout with no clock being given numbers it cannot have.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { workoutLog, spansOf } from "../js/workout.js";
import { vitalsInsights, windowsToRead, MIN_VITALS_SESSIONS } from "../js/vitals.js";
import { ev, T, MAX_BACKFILL_DAYS } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const MON = "2026-09-07";
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T16:00:00Z");
const m = (base, n) => base + n * 60_000;
let seq = 0;
const E = (spec, ts) => ({ eventId: "v" + ++seq, ts, seq, ...spec });
const ME = "m1";

/** A stamped Push + Core on day n: push-ups over 6 minutes, planks over 6 more. */
function session(n, pushups = [10, 10, 9]) {
  const t0 = at(n);
  return E(ev.workout(ME, "match-fit", "push-core", day(n), {
    startedAt: t0, endedAt: m(t0, 12),
    exercises: [
      { id: "pushup", sets: pushups, at: [m(t0, 2), m(t0, 4), m(t0, 6)] },
      { id: "plank", sets: [40, 35], at: [m(t0, 9), m(t0, 12)] },
    ],
  }), m(t0, 12));
}

function vitals(n, fields, lateBy = 30) {
  return E(ev.vitals(ME, "push-core", day(n), fields), m(at(n), lateBy));
}

const world = (extra) => replay([
  E(ev.meta({ tz: TZ }), at(0)),
  E(ev.member(ME, "Sahil"), at(0)),
  E(ev.program(ME, "match-fit"), at(0)),
  ...extra,
]);

// ---------------------------------------------------------------------------
// Landing on the right workout
// ---------------------------------------------------------------------------

test("vitals lie on the workout with the same session and day, whichever arrived first", () => {
  const after = world([session(0), vitals(0, { kcal: 120, hrAvg: 128, hrMax: 161, samples: 140 })]);
  const w = after.workouts.get(ME)[0];
  assert.equal(w.vitals.kcal, 120);
  assert.equal(w.vitals.hrMax, 161);

  // The phone read the watch before the sync brought the workout across: same answer.
  const before = world([vitals(0, { kcal: 120, hrAvg: 128 }, -5), session(0)]);
  assert.equal(before.workouts.get(ME)[0].vitals.kcal, 120);
});

test("a later read replaces the earlier one — the watch's data arrives in pieces", () => {
  // First read, an hour on: a few samples. Next morning: the lot. Latest wins, in written order.
  const s = world([
    session(0),
    vitals(0, { kcal: 30, hrAvg: 110, samples: 12 }, 60),
    vitals(0, { kcal: 120, hrAvg: 128, hrMax: 161, samples: 140 }, 60 * 14),
  ]);
  const w = s.workouts.get(ME)[0];
  assert.equal(w.vitals.kcal, 120);
  assert.equal(w.vitals.samples, 140);
});

test("a second Finish keeps the vitals; a different day does not borrow them", () => {
  const s = world([
    session(0),
    vitals(0, { kcal: 120, hrAvg: 128 }),
    session(0, [10, 10, 10]),   // corrected the last set
    session(7),
  ]);
  const list = s.workouts.get(ME);
  assert.equal(list.find((w) => w.day === day(0)).vitals.kcal, 120);
  assert.equal(list.find((w) => w.day === day(7)).vitals, null);
});

test("junk in a vitals event is dropped field by field, never obeyed", () => {
  const s = world([session(0), vitals(0, { kcal: -4, hrAvg: "high", hrMax: 170, exercises: [{ id: "pushup", kcal: "x" }, null] })]);
  const v = s.workouts.get(ME)[0].vitals;
  assert.equal(v.kcal, null);
  assert.equal(v.hrAvg, null);
  assert.equal(v.hrMax, 170);
  assert.deepEqual(v.exercises, [{ id: "pushup", kcal: null, hrAvg: null, hrMax: null }]);
});

test("the vitals event is a real event type", () => {
  const spec = ev.vitals(ME, "push-core", day(0), { kcal: 1 });
  assert.equal(spec.type, T.VITALS);
});

// ---------------------------------------------------------------------------
// What the phone is told to read
// ---------------------------------------------------------------------------

test("the phone is handed the timed workouts of the last few days, with each exercise's windows", () => {
  const s = world([
    session(0), session(7),
    E(ev.workout(ME, "match-fit", "push-core", day(8), { exercises: [{ id: "pushup", sets: [8, 8, 8] }] }), at(8)),
  ]);
  const windows = windowsToRead(workoutLog(s, ME, day(9)), day(9), addDays, MAX_BACKFILL_DAYS);
  assert.deepEqual(windows.map((w) => w.day), [day(7)], "day 0 is too old; day 8 kept no clock");
  const [w] = windows;
  assert.equal(w.sessionId, "push-core");
  assert.equal(w.end - w.start, 12 * 60_000);
  assert.deepEqual(w.exercises.map((x) => x.id), ["pushup", "plank"]);
  assert.equal(w.exercises[0].spans.length, 3, "one span per stamped set");
});

// ---------------------------------------------------------------------------
// What it says about the person
// ---------------------------------------------------------------------------

const perExercise = { exercises: [{ id: "pushup", kcal: 54, hrAvg: 130, hrMax: 150 }, { id: "plank", kcal: 30, hrAvg: 118, hrMax: 135 }] };

test("nothing is claimed from fewer than three workouts with a watch on", () => {
  const two = world([session(0), vitals(0, { kcal: 84, hrAvg: 124, ...perExercise }), session(2), vitals(2, { kcal: 84, hrAvg: 124, ...perExercise })]);
  assert.equal(vitalsInsights(workoutLog(two, ME, day(3))), null);
  assert.equal(MIN_VITALS_SESSIONS, 3);
});

test("exercises are ranked by what they cost per minute, with the heart rate beside them", () => {
  const s = world([0, 2, 4].flatMap((n) => [session(n), vitals(n, { kcal: 84, hrAvg: 124, hrMax: 150, ...perExercise })]));
  const ins = vitalsInsights(workoutLog(s, ME, day(5)));
  assert.equal(ins.sessions, 3);
  // Push-ups: 54 kcal over 6 minutes = 9.0/min; plank: 30 over 6 = 5.0/min.
  assert.deepEqual(ins.exercises.map((x) => [x.name, x.kcalPerMin.toFixed(1)]), [["Push-up", "9.0"], ["Plank", "5.0"]]);
  assert.equal(ins.exercises[0].hrAvg, 130);
  assert.equal(ins.exercises[0].minutes, 18, "three sessions of six minutes");
  assert.equal(ins.totalKcal, 252);
  assert.equal(ins.hrAvg, 124);
  assert.ok(ins.line.startsWith("Push-up costs the most at 9.0 kcal a minute; Plank the least at 5.0"), ins.line);
});

test("recovery and the resting heart are averaged over the workouts that measured them", () => {
  const s = world([
    session(0), vitals(0, { kcal: 84, hrAvg: 124, hrRest: 118, recovery: 28, ...perExercise }),
    session(2), vitals(2, { kcal: 84, hrAvg: 124, hrRest: 122, recovery: 34, ...perExercise }),
    session(4), vitals(4, { kcal: 84, hrAvg: 124, ...perExercise }),   // an unguided one: no rest to speak of
  ]);
  const ins = vitalsInsights(workoutLog(s, ME, day(5)));
  assert.equal(ins.recovery, 31);
  assert.equal(ins.hrRest, 120);
  assert.ok(ins.line.endsWith("Your heart drops 31 bpm in the minute after a set."), ins.line);
  // Replay keeps both, and drops junk.
  const v = s.workouts.get(ME).find((w) => w.day === day(0)).vitals;
  assert.equal(v.recovery, 28);
  assert.equal(v.hrRest, 118);
});

test("a workout that kept no clock contributes nothing to the ranking, even with vitals", () => {
  // Vitals with no spans to lay them over: the session total counts, the per-exercise rate cannot.
  const s = world([
    ...[0, 2].flatMap((n) => [session(n), vitals(n, { kcal: 84, hrAvg: 124, ...perExercise })]),
    E(ev.workout(ME, "match-fit", "push-core", day(4), { exercises: [{ id: "pushup", sets: [8, 8, 8] }] }), at(4)),
    vitals(4, { kcal: 200, hrAvg: 140, ...perExercise }),
  ]);
  const log = workoutLog(s, ME, day(5));
  assert.deepEqual(spansOf(s.workouts.get(ME).find((w) => w.day === day(4))), []);
  const ins = vitalsInsights(log);
  assert.equal(ins.sessions, 3, "it is a workout with a watch on");
  assert.equal(ins.exercises[0].minutes, 12, "but only the stamped twelve minutes rank");
  assert.equal(ins.dearest.day, day(4), "and it can still be the dearest day");
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ vitals: " + passed + " tests passed");
