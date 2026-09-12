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
  summarise, isComplete, progress, unitOf, exerciseHistory, sessionsOf, restDaysOf,
  personalBests, beatsBest, workoutInsights, MIN_INSIGHT_SESSIONS,
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

// ---------------------------------------------------------------------------
// The hub: every session, any day
// ---------------------------------------------------------------------------

test("every session is listed once, in week order, with the days that suggest it", () => {
  const rows = sessionsOf(FIT);
  assert.deepEqual(rows.map((r) => r.session.name), ["Push + Core", "Legs + Pull", "Metabolic Circuit"]);
  assert.deepEqual(rows.map((r) => r.days), [["Mon"], ["Tue"], ["Fri"]]);
});

test("a session scheduled twice a week is one row with two days", () => {
  const rope = sessionsOf(ROPE).find((r) => r.session.id === "rope");
  assert.deepEqual(rope.days, ["Tue", "Fri"]);
  assert.equal(sessionsOf(ROPE).length, 3, "strength A, rope, strength B");
});

test("rest days are the rest of the week, named", () => {
  const rests = restDaysOf(FIT);
  assert.deepEqual(rests.map((r) => r.day + " " + r.label), ["Wed Rest", "Thu Tennis", "Sat Rest", "Sun Rest"]);
  assert.equal(rests.find((r) => r.day === "Thu").note, "Nothing to add here — that's the point.");
});

test("a session done on the wrong day is still that session", () => {
  // Monday's Push + Core, done on a Wednesday, is Push + Core on Wednesday. Prefill next Monday
  // reads it, because prefill keys on the session, not the weekday.
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(2), { exercises: [{ id: "pushup", sets: [11, 11, 11] }] }), at(2)),
  ]);
  assert.equal(planFor(FIT, day(2)).rest, "Rest", "Wednesday is a rest day on the schedule");
  const last = lastSession(s, ME, "push-core", day(7));
  assert.equal(last.day, day(2));
  assert.equal(prefill(PUSHUP, last, 0), 11);
});

// ---------------------------------------------------------------------------
// History, exercise by exercise
// ---------------------------------------------------------------------------

test("history lists every exercise the program defines, done or not", () => {
  const s = state([E(ev.program(ME, "match-fit"), at(0))]);
  const rows = exerciseHistory(s, ME, FIT);
  const names = rows.map((r) => r.name);
  assert.ok(names.includes("Push-up") && names.includes("Hollow body hold") && names.includes("Squat jump"));
  assert.ok(rows.every((r) => r.sessions.length === 0 && r.trend === null));
});

test("the circuit's push-ups are the same push-ups as Monday's", () => {
  // One exercise, two sessions that use it. The history is one row, with both days in it.
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(0), { exercises: [{ id: "pushup", sets: [10, 10, 9] }] }), at(0)),
    E(ev.workout(ME, "match-fit", "circuit", day(4), { exercises: [{ id: "pushup", sets: [12, 12, 12] }] }), at(4)),
  ]);
  const pushup = exerciseHistory(s, ME, FIT).find((r) => r.id === "pushup");
  assert.equal(pushup.sessions.length, 2);
  assert.equal(exerciseHistory(s, ME, FIT).filter((r) => r.id === "pushup").length, 1, "one row, not two");
});

test("sessions are in date order and the trend compares the last two totals", () => {
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(7), { exercises: [{ id: "pushup", sets: [10, 10, 10] }] }), at(7)),
    E(ev.workout(ME, "match-fit", "push-core", day(0), { exercises: [{ id: "pushup", sets: [8, 8, 8] }] }), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(14), { exercises: [{ id: "pushup", sets: [12, 11, 10] }] }), at(14)),
  ]);
  const pushup = exerciseHistory(s, ME, FIT).find((r) => r.id === "pushup");
  assert.deepEqual(pushup.sessions.map((x) => x.total), [24, 30, 33]);
  assert.equal(pushup.trend, "up");
});

test("trend is on the total, so adding a set is progress even if it is a short one", () => {
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(0), { exercises: [{ id: "pushup", sets: [12, 12] }] }), at(0)),
    E(ev.workout(ME, "match-fit", "push-core", day(7), { exercises: [{ id: "pushup", sets: [12, 12, 6] }] }), at(7)),
  ]);
  const pushup = exerciseHistory(s, ME, FIT).find((r) => r.id === "pushup");
  assert.equal(pushup.trend, "up", "24 -> 30; a best-set comparison would have said 'same'");
});

test("a rope day is one row, in rounds", () => {
  const s = state([
    E(ev.program(ME, "rope-protocol"), at(0)),
    E(ev.workout(ME, "rope-protocol", "rope", day(1), { exercises: [{ id: "plank", sets: [25, 25, 25] }], rounds: 8, work: 30, rest: 30 }), at(1)),
    E(ev.workout(ME, "rope-protocol", "rope", day(4), { exercises: [], rounds: 10, work: 30, rest: 30 }), at(4)),
  ]);
  const rows = exerciseHistory(s, ME, ROPE);
  const rope = rows.find((r) => r.id === "rope");
  assert.equal(rope.unit, "rounds");
  assert.deepEqual(rope.sessions.map((x) => x.total), [8, 10]);
  assert.equal(rope.trend, "up");
  // And the finisher's plank, stored inside the rope event, has its own row.
  const plank = rows.find((r) => r.id === "plank");
  assert.equal(plank.sessions.length, 1);
  assert.equal(plank.sessions[0].total, 75);
});

test("another program's workouts are not this program's history", () => {
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    E(ev.workout(ME, "rope-protocol", "strength-a", day(0), { exercises: [{ id: "table-row", sets: [10, 10, 10] }] }), at(0)),
  ]);
  const row = exerciseHistory(s, ME, FIT).find((r) => r.id === "table-row");
  assert.equal(row.sessions.length, 0, "Match Fit has a table row too, but this one was logged under Rope Protocol");
});

// ---------------------------------------------------------------------------
// Personal bests
// ---------------------------------------------------------------------------

/** A push-core session with just push-ups and a plank, for brevity. */
const pc = (n, pushup, plank) => E(ev.workout(ME, "match-fit", "push-core", day(n), {
  exercises: [{ id: "pushup", sets: pushup }, { id: "plank", sets: plank }],
}), at(n));

test("best set and best total are different records", () => {
  // One lucky set of 15 followed by two of 6 is the best SET. 12, 12, 12 is the best SESSION.
  const s = state([E(ev.program(ME, "match-fit"), at(0)), pc(0, [15, 6, 6], [30, 30, 30]), pc(7, [12, 12, 12], [40, 40, 40])]);
  const pb = personalBests(s, ME, FIT).get("pushup");
  assert.equal(pb.set.value, 15);
  assert.equal(pb.set.day, day(0));
  assert.equal(pb.total.value, 36);
  assert.equal(pb.total.day, day(7));
});

test("an exercise never done has no best", () => {
  const s = state([E(ev.program(ME, "match-fit"), at(0)), pc(0, [8, 8, 8], [30, 30, 30])]);
  const pbs = personalBests(s, ME, FIT);
  assert.equal(pbs.has("pushup"), true);
  assert.equal(pbs.has("squat"), false);
});

test("beating a best is strictly greater", () => {
  const s = state([E(ev.program(ME, "match-fit"), at(0)), pc(0, [10, 10, 10], [30, 30, 30])]);
  const pbs = personalBests(s, ME, FIT);
  assert.equal(beatsBest(pbs, "pushup", 11), true);
  assert.equal(beatsBest(pbs, "pushup", 10), false, "matching is not beating");
  assert.equal(beatsBest(pbs, "pushup", 9), false);
  assert.equal(beatsBest(pbs, "squat", 99), false, "no record to beat");
  assert.equal(beatsBest(null, "pushup", 99), false);
});

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

test("nothing logged is an honest zero, not a crash", () => {
  const s = state([E(ev.program(ME, "match-fit"), at(0))]);
  const ins = workoutInsights(s, ME, FIT, day(10));
  assert.equal(ins.sessions, 0);
  assert.equal(ins.favourite, null);
  assert.equal(ins.streakWeeks, 0);
  assert.equal(workoutInsights(s, ME, null, day(10)).sessions, 0);
});

test("favourite is the exercise finished in full most consistently; least is the one cut short", () => {
  // Enough sessions to clear the bar. Push-ups always complete; plank always one set short.
  const logs = [];
  for (let i = 0; i < MIN_INSIGHT_SESSIONS; i += 1) logs.push(pc(i * 7, [10, 10, 10], [30, 30]));
  const s = state([E(ev.program(ME, "match-fit"), at(0)), ...logs]);
  const ins = workoutInsights(s, ME, FIT, day(30));
  assert.equal(ins.favourite.id, "pushup");
  assert.equal(ins.favourite.rate, 1);
  assert.equal(ins.leastFavourite.id, "plank");
  assert.ok(ins.leastFavourite.rate < 1);
});

test("below the bar, no favourite is claimed", () => {
  const logs = [];
  for (let i = 0; i < MIN_INSIGHT_SESSIONS - 1; i += 1) logs.push(pc(i * 7, [10, 10, 10], [30, 30]));
  const s = state([E(ev.program(ME, "match-fit"), at(0)), ...logs]);
  const ins = workoutInsights(s, ME, FIT, day(30));
  assert.equal(ins.favourite, null);
  assert.equal(ins.leastFavourite, null);
});

test("when everything is always finished there is no least favourite", () => {
  const logs = [];
  for (let i = 0; i < MIN_INSIGHT_SESSIONS; i += 1) logs.push(pc(i * 7, [10, 10, 10], [30, 30, 30]));
  const s = state([E(ev.program(ME, "match-fit"), at(0)), ...logs]);
  const ins = workoutInsights(s, ME, FIT, day(30));
  assert.ok(ins.favourite, "a favourite can still be named");
  assert.equal(ins.leastFavourite, null, "naming one would be inventing a complaint");
});

test("volume keeps reps and seconds apart", () => {
  const s = state([E(ev.program(ME, "match-fit"), at(0)), pc(0, [10, 10, 10], [30, 30, 30])]);
  const ins = workoutInsights(s, ME, FIT, day(1));
  assert.equal(ins.volume.reps, 30);
  assert.equal(ins.volume.seconds, 90);
  assert.equal(ins.sets, 6);
});

test("most improved compares latest total to first, and needs a gain", () => {
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    pc(0, [8, 8, 8], [30, 30, 30]),     // pushup 24, plank 90
    pc(7, [12, 12, 12], [30, 30, 30]),  // pushup 36 (+50%), plank 90 (0%)
  ]);
  const ins = workoutInsights(s, ME, FIT, day(8));
  assert.equal(ins.mostImproved.id, "pushup");
  assert.equal(ins.mostImproved.from, 24);
  assert.equal(ins.mostImproved.to, 36);
  assert.ok(Math.abs(ins.mostImproved.gain - 0.5) < 1e-9);
});

test("busiest day is the weekday actually trained on, not the scheduled one", () => {
  // Push + Core is Monday's session. Done on Wednesdays.
  const s = state([
    E(ev.program(ME, "match-fit"), at(0)),
    pc(2, [8, 8, 8], [30, 30, 30]), pc(9, [8, 8, 8], [30, 30, 30]), pc(16, [8, 8, 8], [30, 30, 30]),
    E(ev.workout(ME, "match-fit", "legs-pull", day(1), { exercises: [{ id: "squat", sets: [15] }] }), at(1)),
  ]);
  const ins = workoutInsights(s, ME, FIT, day(17));
  assert.equal(ins.busiestDay.day, "Wed");
  assert.equal(ins.busiestDay.count, 3);
});

test("a tie for busiest day names nobody", () => {
  const s = state([E(ev.program(ME, "match-fit"), at(0)),
    pc(0, [8, 8, 8], [30, 30, 30]), pc(2, [8, 8, 8], [30, 30, 30]), pc(7, [8, 8, 8], [30, 30, 30]), pc(9, [8, 8, 8], [30, 30, 30])]);
  assert.equal(workoutInsights(s, ME, FIT, day(10)).busiestDay, null);
});

test("weeks in a row count back from this week and survive a week not yet trained", () => {
  // Sessions in weeks 0, 1, 2. Asked on the Tuesday of week 3 with nothing yet: the streak is
  // still 3 — this week has not had its session YET, which is not a gap.
  const s = state([E(ev.program(ME, "match-fit"), at(0)),
    pc(0, [8, 8, 8], [30, 30, 30]), pc(7, [8, 8, 8], [30, 30, 30]), pc(14, [8, 8, 8], [30, 30, 30])]);
  assert.equal(workoutInsights(s, ME, FIT, day(22)).streakWeeks, 3);
  // A whole missed week before that does break it.
  const gap = state([E(ev.program(ME, "match-fit"), at(0)),
    pc(0, [8, 8, 8], [30, 30, 30]), pc(14, [8, 8, 8], [30, 30, 30])]);
  assert.equal(workoutInsights(gap, ME, FIT, day(15)).streakWeeks, 1);
});

test("a rope program reports rounds, the longest interval and the week", () => {
  const s = state([
    E(ev.program(ME, "rope-protocol"), at(0)),
    E(ev.workout(ME, "rope-protocol", "rope", "2026-09-08", { exercises: [], rounds: 8, work: 30, rest: 30 }), Date.parse("2026-09-08T09:00:00Z")),
    E(ev.workout(ME, "rope-protocol", "rope", "2026-09-15", { exercises: [], rounds: 10, work: 45, rest: 30 }), Date.parse("2026-09-15T09:00:00Z")),
  ]);
  const ins = workoutInsights(s, ME, ROPE, "2026-09-16");
  assert.equal(ins.rope.rounds, 18);
  assert.equal(ins.rope.longestWork, 45);
  assert.equal(ins.rope.week, 3);
  assert.equal(workoutInsights(s, ME, FIT, "2026-09-16").rope, null, "not a rope program");
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ workout: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ workout: " + passed + " tests passed");
