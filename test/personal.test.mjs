// personal.test.mjs — which answers about a habit are the group's, and which are yours.
//
// ---- The distinction ----
//
// A habit definition is the group's: the metric, the cadence, the direction, the category. Every
// device replays it and every device gets the same answer, which is exactly what you want for
// "we are tracking sleep" and exactly wrong for anything about one person.
//
// Three things were on the wrong side of that line, all of them stored on the habit and all of
// them therefore one answer for everybody. Two are fixed here; the third — the target — was
// already personal and is the model the other two now follow.
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
//
// And visibility: the group agreed to track sleep, and whoever created the habit decided on behalf
// of all three whether a number or a tick was published. Nobody was asked, and there was no screen
// on which to answer.

import assert from "node:assert/strict";
import { replay, addDays, latestGoal } from "../js/habits.js";
import { visibilityFor, targetFor } from "../js/habits.js";
import {
  ev, METRIC, AT_LEAST, AGGREGATE, SOURCE, PERIOD, VISIBILITY,
} from "../js/schema.js";

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
// And the other thing that was everybody's answer: what the group sees
// ---------------------------------------------------------------------------
//
// Same bug, same shape. Visibility sat on the habit, so the group agreed to track sleep and
// whoever created it decided on behalf of all three whether a number or a tick was published.
// Nobody was asked, and there was no screen on which to answer.

const HABIT = () => [...base()][2];
const withHabit = (extra, vis) => replay([
  E(ev.member("a", "A"), at(0)),
  E(ev.member("b", "B"), at(0)),
  E(ev.habit("gym", {
    name: "Workouts", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3,
    period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
    tz: TZ, dayStartHour: 4, visibility: vis || VISIBILITY.FULL,
  }), at(0)),
  ...extra,
]);
const habitOf = (s) => s.habits.get("gym");

test("what the group sees of me is my answer, not the habit's", () => {
  const s = withHabit([
    E(ev.goal("a", "gym", { visibility: VISIBILITY.PRIVATE }), at(1)),
  ], VISIBILITY.FULL);
  assert.equal(visibilityFor(s, habitOf(s), "a"), VISIBILITY.PRIVATE);
});

test("and it says nothing about anybody else", () => {
  // The half that makes it a personal setting rather than a renamed group one. Before this, A
  // choosing to hide a number hid B's too.
  const s = withHabit([
    E(ev.goal("a", "gym", { visibility: VISIBILITY.PRIVATE }), at(1)),
  ], VISIBILITY.FULL);
  assert.equal(visibilityFor(s, habitOf(s), "b"), VISIBILITY.FULL, "B never answered");
});

test("three people, three different answers", () => {
  const s = withHabit([
    E(ev.goal("a", "gym", { visibility: VISIBILITY.PRIVATE }), at(1)),
    E(ev.goal("b", "gym", { visibility: VISIBILITY.PROGRESS }), at(1)),
  ], VISIBILITY.FULL);
  assert.equal(visibilityFor(s, habitOf(s), "a"), VISIBILITY.PRIVATE);
  assert.equal(visibilityFor(s, habitOf(s), "b"), VISIBILITY.PROGRESS);
  assert.equal(visibilityFor(s, habitOf(s), "c"), VISIBILITY.FULL, "never answered, so the habit");
});

test("a row written before this falls back to the habit, not to a default", () => {
  // The one that matters on upgrade. Every habit in the log carries a visibility, and somebody who
  // set a habit to private did so expecting it to hold — defaulting to FULL here would republish
  // numbers that had been deliberately hidden, on the first sync after an update.
  const s = withHabit([
    E(ev.goal("a", "gym", { target: 4 }), at(1)),
  ], VISIBILITY.PRIVATE);
  assert.equal(visibilityFor(s, habitOf(s), "a"), VISIBILITY.PRIVATE);
});

test("setting a target does not republish a hidden number", () => {
  const s = withHabit([
    E(ev.goal("a", "gym", { visibility: VISIBILITY.PRIVATE }), at(1)),
    E(ev.goal("a", "gym", { target: 9 }), at(2)),
  ], VISIBILITY.FULL);
  assert.equal(visibilityFor(s, habitOf(s), "a"), VISIBILITY.PRIVATE);
  assert.equal(latestGoal(s, "gym", "a").target, 9);
});

test("a value that is not one of the three is ignored", () => {
  // A typo must not open a number up. Falling through to the previous answer keeps whatever was
  // already true rather than resolving to the most permissive thing in the enum.
  const s = withHabit([
    E(ev.goal("a", "gym", { visibility: VISIBILITY.PRIVATE }), at(1)),
    E(ev.goal("a", "gym", { visibility: "publik" }), at(2)),
  ], VISIBILITY.FULL);
  assert.equal(visibilityFor(s, habitOf(s), "a"), VISIBILITY.PRIVATE);
});

// ---------------------------------------------------------------------------
// And the oldest personal thing of all: the number
// ---------------------------------------------------------------------------
//
// Reported from a real group: "why does my goal change when Anj edits her goal?"
//
// Because the habit carries a target of its own and targetFor falls back to it for anybody who has
// not set one — which is everybody, until they open Your goals. The edit-habit screen wrote that
// field on every save, so one person adjusting their steps moved the whole group's number, and the
// only symptom was your figure being different from the one you remembered.
//
// The habit still carries a seed, because a new joiner needs a sensible default before they have
// chosen. What changed is that the seed is written once, when the habit is born, and the editor
// writes a personal goal alongside it — so nobody is left running on a number that belongs to
// everybody.

const goalWorld = (extra = []) => replay([
  E(ev.member("sahil", "Sahil"), at(0)),
  E(ev.member("anj", "Anj"), at(0)),
  E(ev.habit("steps", {
    name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
    period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
    tz: TZ, dayStartHour: 4,
  }), at(0)),
  ...extra,
]);
const targetOf = (s, who, n = 6) =>
  targetFor(s, s.habits.get("steps"), who, day(n));

test("Anj setting her own goal does not touch mine", () => {
  const s = goalWorld([E(ev.goal("anj", "steps", { target: 6000 }), at(1))]);
  assert.equal(targetOf(s, "anj"), 6000);
  assert.equal(targetOf(s, "sahil"), 10000, "mine is still the seed, not hers");
});

test("we can hold different numbers for the same habit", () => {
  const s = goalWorld([
    E(ev.goal("anj", "steps", { target: 6000 }), at(1)),
    E(ev.goal("sahil", "steps", { target: 14000 }), at(1)),
  ]);
  assert.equal(targetOf(s, "anj"), 6000);
  assert.equal(targetOf(s, "sahil"), 14000);
});

test("re-writing the habit's target moves everybody who has no goal of their own", () => {
  // The damage, stated as engine behaviour, because that is where it can be tested — the bug
  // itself lived in the editor's write path and these tests cannot reach a form.
  //
  // The fallback is correct and stays. What was wrong was the edit-habit screen writing this field
  // on every save, so one person's adjustment landed on everyone who had never opened Your goals.
  // If that line ever comes back, this test does not fail — but it says exactly what it costs, and
  // the comment on the editor's `target` field points here.
  const before = goalWorld();
  assert.equal(targetOf(before, "sahil"), 10000);
  assert.equal(targetOf(before, "anj"), 10000);

  const reseeded = goalWorld([
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 6000,
      period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4,
    }), at(1)),
  ]);
  assert.equal(targetOf(reseeded, "sahil"), 6000, "moved, having done nothing");
  assert.equal(targetOf(reseeded, "anj"), 6000);
});

test("but not somebody who has set one", () => {
  // The other half, and the shape of the fix: a personal goal is immune. The editor now writes one
  // every time it saves, so nobody is left standing on the seed.
  const s = goalWorld([
    E(ev.goal("sahil", "steps", { target: 14000 }), at(1)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 6000,
      period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4,
    }), at(2)),
  ]);
  assert.equal(targetOf(s, "sahil"), 14000, "held");
  assert.equal(targetOf(s, "anj"), 6000, "still on the seed, so still moved");
});

test("the seed still answers for somebody who has not chosen", () => {
  // The reason the fallback exists at all, and why it is kept rather than removed: a member who
  // has never opened Your goals needs a number, and the group's is the only sensible one.
  const s = goalWorld([E(ev.goal("anj", "steps", { target: 6000 }), at(1))]);
  assert.equal(targetOf(s, "sahil"), 10000);
});

test("a goal CHANGE counts from tomorrow, for each of us separately", () => {
  // The rule that stops a bad week being rescued still applies per member, so one person lowering
  // their number cannot move the day another person is being scored on either.
  //
  // A FIRST goal counts from the day it is set — that is not a change, and a joiner would
  // otherwise be judged on a number they never chose — so the fixture sets one before changing it.
  const s = goalWorld([
    E(ev.goal("anj", "steps", { target: 8000 }), at(1)),
    E(ev.goal("anj", "steps", { target: 100 }), at(5)),
  ]);
  assert.equal(targetOf(s, "anj", 5), 8000, "the drop does not land on the day it was made");
  assert.equal(targetOf(s, "anj", 6), 100, "it lands tomorrow");
  assert.equal(targetOf(s, "sahil", 6), 10000, "and never on me");
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
      console.error("✗ personal: " + failures.length + " failed, " + passed + " passed");
      process.exit(1);
    }
    console.log("✓ personal: " + passed + " tests passed");
  });
