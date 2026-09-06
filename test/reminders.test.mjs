// reminders.test.mjs — whose alarm clock is it, and does the shell ever hear about the days?
//
// ---- Two bugs, one seam ----
//
// A reminder was stored on the HABIT. A habit definition is the group's: every device replays it
// and every device gets the same answer, which is exactly right for the metric, the cadence and the
// target, and exactly wrong for a time of day. Set yours for six in the morning and you set
// everybody's, silently, and whoever opened the editor last won. Nothing errored; three phones just
// quietly agreed on one alarm clock.
//
// And `remindDays` — added so a weekly habit could nudge on the days you actually train — was
// written by the editor, parsed by HabitModel.kt, and used by HabitReminder.kt. It was never put on
// the wire between them. The shell read an absent field as an empty set, fell back to the days the
// habit is SCORED on, and for a weekly habit that is all seven. So the feature added to stop a
// workout reminder firing every morning fired every morning.
//
// Both halves worked. Neither test suite covered the join.

import assert from "node:assert/strict";
import { replay, addDays, latestGoal } from "../js/habits.js";
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
const E = (spec, ts) => ({ eventId: "r" + ++seq, ts, seq, ...spec });

/** Two people and one weekly habit — the shape the day-list bug needs. */
const base = () => [
  E(ev.member("a", "A"), at(0)),
  E(ev.member("b", "B"), at(0)),
  E(ev.habit("gym", {
    name: "Workouts", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3,
    period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
    tz: TZ, dayStartHour: 4,
  }), at(0)),
];

const remind = (s, who) => latestGoal(s, "gym", who);

/** A fake shell that records what the page hands it. */
async function shell() {
  const calls = [];
  globalThis.window = globalThis;
  globalThis.PauseNative = new Proxy({}, {
    get: (_, name) => (typeof name === "string" ? (json) => calls.push([name, json]) : undefined),
    has: () => true,
  });
  const bridge = await import("../js/bridge.js");
  bridge.installBridge({});
  return { calls, setSyncConfig: bridge.setSyncConfig };
}

const lastConfig = (calls) =>
  JSON.parse(calls.filter(([n]) => n === "setSyncConfig").pop()[1]).habits[0];

// ---------------------------------------------------------------------------
// Whose reminder is it
// ---------------------------------------------------------------------------

test("my reminder is mine, and does not become yours", () => {
  const s = replay([
    ...base(),
    E(ev.goal("a", "gym", { remindAt: 6 * 60, remindDays: [1, 3, 5] }), at(1)),
  ]);
  assert.equal(remind(s, "a").remindAt, 360);
  assert.equal(remind(s, "b"), null, "B has no goal at all, let alone A's alarm");
});

test("two people can hold different times for the same habit", () => {
  // The whole point. Before this, the second write simply overwrote the first for both of them.
  const s = replay([
    ...base(),
    E(ev.goal("a", "gym", { remindAt: 6 * 60 }), at(1)),
    E(ev.goal("b", "gym", { remindAt: 20 * 60 }), at(2)),
  ]);
  assert.equal(remind(s, "a").remindAt, 360);
  assert.equal(remind(s, "b").remindAt, 1200);
});

test("setting a target does not switch off a reminder", () => {
  // The two live on the same event and are written by two different screens, so each sends only
  // its own half. Without the carry-forward, saving a goal would silently clear the alarm.
  const s = replay([
    ...base(),
    E(ev.goal("a", "gym", { remindAt: 7 * 60, remindDays: [2, 4] }), at(1)),
    E(ev.goal("a", "gym", { target: 4, active: true }), at(2)),
  ]);
  assert.equal(remind(s, "a").remindAt, 420, "the alarm survived a target change");
  assert.deepEqual(remind(s, "a").remindDays, [2, 4]);
  assert.equal(remind(s, "a").target, 4);
});

test("setting a reminder does not reset a target", () => {
  const s = replay([
    ...base(),
    E(ev.goal("a", "gym", { target: 5, active: true }), at(1)),
    E(ev.goal("a", "gym", { remindAt: 7 * 60 }), at(2)),
  ]);
  assert.equal(remind(s, "a").target, 5);
  assert.equal(remind(s, "a").remindAt, 420);
});

// ---------------------------------------------------------------------------
// Three states, not two
// ---------------------------------------------------------------------------

test("never answered is not the same as answered no", () => {
  // The distinction the fallback rests on. A goal that has only ever set a target must stay
  // undefined so the habit's old group-wide value still applies; an explicit null must beat it,
  // or switching a reminder off would silently re-inherit the time it was just switched off from.
  const never = replay([...base(), E(ev.goal("a", "gym", { target: 3 }), at(1))]);
  assert.equal(remind(never, "a").remindAt, undefined, "nobody has answered");

  const off = replay([
    ...base(),
    E(ev.goal("a", "gym", { remindAt: 8 * 60 }), at(1)),
    E(ev.goal("a", "gym", { remindAt: null }), at(2)),
  ]);
  assert.equal(remind(off, "a").remindAt, null, "answered: no reminder");
});

test("a nonsense time cannot be stored", () => {
  const s = replay([...base(), E(ev.goal("a", "gym", { remindAt: 99999 }), at(1))]);
  assert.ok(remind(s, "a").remindAt <= 1439);
});

test("days outside a week are dropped", () => {
  const s = replay([
    ...base(),
    E(ev.goal("a", "gym", { remindAt: 60, remindDays: [0, 3, 8, 5] }), at(1)),
  ]);
  assert.deepEqual(remind(s, "a").remindDays, [3, 5]);
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

const wire = async () => {
  const { calls, setSyncConfig } = await shell();

  // The bug this file is named for. HabitReminder.kt reads `remindDays.ifEmpty { days }`, so a
  // field that never arrives is not a missing reminder — it is a reminder on the wrong days, every
  // day, for a habit whose whole point is that it does not happen every day.
  setSyncConfig({
    groupCode: "g", memberId: "a", supabaseUrl: "u", supabaseKey: "k",
    habits: [{
      habitId: "gym", metric: METRIC.SESSIONS, tz: TZ, dayStartHour: 4,
      name: "Workouts", days: [1, 2, 3, 4, 5, 6, 7], period: PERIOD.WEEK,
      remindAt: 360, remindDays: [1, 3, 5],
    }],
  });
  const habit = lastConfig(calls);
  assert.deepEqual(habit.remindDays, [1, 3, 5], "remindDays crossed the bridge");
  assert.equal(habit.remindAt, 360);
  assert.deepEqual(habit.days, [1, 2, 3, 4, 5, 6, 7], "and the scored days still travel too");
  passed += 1;

  // The outbound twin of bridge.test.mjs, which guards the announcement coming the other way.
  // HabitConfig.fromJson reads exactly these; a field it reads and this never sends is silently
  // defaulted, which is how remindDays spent a release as an empty set.
  const PARSED = [
    "habitId", "metric", "tz", "dayStartHour", "name", "days", "period",
    "remindAt", "remindDays",
  ];
  for (const field of PARSED) {
    assert.ok(field in habit, field + " is parsed by the shell but never sent");
  }
  passed += 1;
};

wire()
  .catch((err) => failures.push({ name: "the wire", err }))
  .then(() => {
    if (failures.length) {
      for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
      console.error("✗ reminders: " + failures.length + " failed, " + passed + " passed");
      process.exit(1);
    }
    console.log("✓ reminders: " + passed + " tests passed");
  });
