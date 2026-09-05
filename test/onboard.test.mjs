// onboard.test.mjs — the six a new group starts with, against the six the board scores.
//
// ---- Why this is a test and not a comment ----
//
// These are two lists of the same thing, written in two files, with nothing connecting them. That
// arrangement had already drifted once: the board scored six, setup offered three, and a person
// joining a group was silently never scored on Discipline or Savings because the screen that could
// have offered them didn't. Nothing was broken and nothing said anything.
//
// A drift like that cannot show up in either file's diff, because each file is individually
// correct. It only exists between them, which is where this lives.

import assert from "node:assert/strict";
import { STARTERS } from "../js/ui/onboard.js";
import { replay } from "../js/habits.js";
import {
  ev, SCORED_METRICS, PERIOD, AT_LEAST, AT_MOST, METRIC, SOURCE,
} from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const metricsOffered = new Set(STARTERS.map((s) => s.fields.metric));

// ---------------------------------------------------------------------------
// The two lists
// ---------------------------------------------------------------------------

test("setup offers exactly what the board scores", () => {
  const missing = [...SCORED_METRICS].filter((m) => !metricsOffered.has(m));
  assert.deepEqual(
    missing, [],
    "scored by the board but not offered at setup, so somebody has to find the editor to be "
      + "judged on them: " + missing.join(", "),
  );

  const extra = [...metricsOffered].filter((m) => !SCORED_METRICS.has(m));
  assert.deepEqual(
    extra, [],
    "offered at setup but never scored, which is worse than not offering it — a group would pick "
      + "it on day one and wonder for weeks why it never appears: " + extra.join(", "),
  );
});

test("every starter is distinct", () => {
  // Two starters on one metric would give a group two habits competing for the same category
  // share, and each one's card would show the other's number depending on which replayed last.
  assert.equal(metricsOffered.size, STARTERS.length);
  assert.equal(new Set(STARTERS.map((s) => s.key)).size, STARTERS.length);
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test("each one is judged over the period it is actually spoken in", () => {
  // "Three workouts a week" is not "0.43 workouts a day", and a savings goal is one question asked
  // at the end of the month rather than a daily interrogation. Getting these wrong does not error;
  // it marks every rest day a failure and asks about savings every morning.
  const period = (metric) => STARTERS.find((s) => s.fields.metric === metric).fields.period;
  assert.equal(period(METRIC.SESSIONS), PERIOD.WEEK);
  assert.equal(period(METRIC.AMOUNT), PERIOD.MONTH);
  for (const m of [METRIC.STEPS, METRIC.SLEEP, METRIC.PUFFS, METRIC.SCREEN_MINUTES]) {
    assert.equal(period(m) ?? PERIOD.DAY, PERIOD.DAY, m + " is a daily habit");
  }
});

test("the two you are cutting down are ceilings, and the rest are floors", () => {
  const direction = (metric) => STARTERS.find((s) => s.fields.metric === metric).fields.direction;
  assert.equal(direction(METRIC.PUFFS), AT_MOST);
  assert.equal(direction(METRIC.SCREEN_MINUTES), AT_MOST);
  for (const m of [METRIC.STEPS, METRIC.SLEEP, METRIC.SESSIONS, METRIC.AMOUNT]) {
    assert.equal(direction(m), AT_LEAST, m + " is something you are building");
  }
});

test("every starter has a goal you could actually meet", () => {
  for (const s of STARTERS) {
    assert.ok(s.fields.target > 0, s.key + " starts at zero, which is met or failed on day one");
    assert.ok(typeof s.fromInput === "function" && typeof s.toInput === "function", s.key);
    // Round-trips, or the number typed in is not the number stored.
    assert.equal(s.fromInput(s.toInput(s.fields.target)), s.fields.target, s.key + " round-trip");
  }
});

test("money is not published by default", () => {
  // What everybody saved is a figure friends measure themselves against in a way steps are not,
  // and defaulting to publishing it is a decision nobody was asked to make.
  const savings = STARTERS.find((s) => s.fields.metric === METRIC.AMOUNT);
  assert.notEqual(savings.fields.visibility, "full");
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test("a group created from these is scored on all six", () => {
  // The claim that matters, made against the engine rather than against the list: replay a group
  // built exactly as createGroup() builds one, and every habit must come out on the board.
  let seq = 0;
  const events = [{ ...ev.member("m1", "Me"), eventId: "e" + ++seq, ts: 1, seq }];
  for (const s of STARTERS) {
    events.push({
      ...ev.habit(s.key, {
        name: s.name, icon: s.icon, ...s.fields,
        tz: "Africa/Johannesburg", dayStartHour: 4,
      }),
      eventId: "e" + ++seq, ts: 1, seq,
    });
    events.push({ ...ev.bind("m1", s.key, SOURCE.MANUAL), eventId: "e" + ++seq, ts: 1, seq });
  }

  const state = replay(events);
  assert.equal(state.habits.size, STARTERS.length);
  for (const s of STARTERS) {
    assert.equal(state.habits.get(s.key).scored, true, s.key + " must reach the board");
  }
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ onboarding: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ onboarding: " + passed + " tests passed");
