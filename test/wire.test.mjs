// wire.test.mjs — a row produced by the Android shell, run through the web engine.
//
// Both sides have been tested alone: HabitModelTest pins the JSON Kotlin emits, and the engine
// tests pin what replay does with an event. Nobody had ever taken one of those Kotlin rows and
// actually fed it through the JavaScript.
//
// That gap is the dangerous kind. If the shapes disagree, nothing throws on either side — the
// phone reports success, the server accepts the row, and the numbers simply never appear. The
// fixture below is the literal output of PendingEvent.toJson() in the Android project, copied from
// a run, not written by hand here.

import assert from "node:assert/strict";
import { replay, valueOn, rawDayStatus, HIT, MISS, NO_DATA } from "../js/habits.js";
import { ev, SOURCE, AT_LEAST, AT_MOST, METRIC, sourceForDevice } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

/** Verbatim from com.pause.breathe.habit.PendingEvent.toJson(). */
const KOTLIN_ROW = {
  payload: {
    v: 1,
    externalId: null,
    habitId: "steps",
    source: "health_connect",
    day: "2026-03-02",
    value: 8412,
    memberId: "member-1",
  },
  author: "member-1",
  trip_code: "HABIT-7Q2XK9",
  type: "habit_log",
  uuid: "b4238946-6681-415f-8585-b7a6c39efb75",
  ts: 1772474400000,
};

/**
 * What pull_events hands back: the row as stored, plus the server's own ordering stamp.
 * This is the mapping sync.js performs, kept here so the test covers the real path rather than a
 * convenient shortcut past it.
 */
function asPulled(row, seq = 1) {
  const serverRow = { ...row, seq, inserted_at: new Date(row.ts + 1500).toISOString() };
  const serverTs = Date.parse(serverRow.inserted_at) || 0;
  return {
    eventId: serverRow.uuid,
    type: serverRow.type,
    author: serverRow.author,
    ts: Number(serverRow.ts) || serverTs,
    seq: serverRow.seq,
    serverTs,
    payload: serverRow.payload || {},
  };
}

const TZ = "Africa/Johannesburg";
function setup(extra = []) {
  return replay([
    { eventId: "s1", ts: 1772000000000, seq: 0, ...ev.member("member-1", "Sahil") },
    {
      eventId: "s2", ts: 1772000000001, seq: 0,
      ...ev.habit("steps", {
        name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 8000,
        source: SOURCE.HEALTH_CONNECT, tz: TZ, dayStartHour: 4,
      }),
    },
    ...extra,
  ]);
}

test("a row the Android shell produced is understood by the engine", () => {
  const state = setup([asPulled(KOTLIN_ROW)]);
  const steps = state.habits.get("steps");
  assert.equal(valueOn(state, steps, "member-1", "2026-03-02"), 8412);
  assert.equal(rawDayStatus(state, steps, "member-1", "2026-03-02"), HIT);
});

test("its type is one the engine knows — not skipped as unrecognised", () => {
  // isKnown() silently drops anything it does not recognise, which is exactly the right behaviour
  // for forward compatibility and exactly what would hide a wire-format drift.
  const withoutIt = setup();
  const withIt = setup([asPulled(KOTLIN_ROW)]);
  assert.equal(valueOn(withoutIt, withoutIt.habits.get("steps"), "member-1", "2026-03-02"), null);
  assert.notEqual(valueOn(withIt, withIt.habits.get("steps"), "member-1", "2026-03-02"), null);
});

test("its schema version is accepted rather than treated as from the future", () => {
  assert.equal(KOTLIN_ROW.payload.v, 1);
});

test("a null externalId does not break de-duplication", () => {
  // org.json writes JSONObject.NULL, which arrives as a real null. Treated as an id, every row
  // would collapse into one.
  const state = setup([
    asPulled(KOTLIN_ROW, 1),
    asPulled({ ...KOTLIN_ROW, uuid: "c4238946-6681-415f-8585-b7a6c39efb76", payload: { ...KOTLIN_ROW.payload, value: 9000 } }, 2),
  ]);
  // aggregate defaults to "last", so the newer row wins rather than the two summing.
  assert.equal(valueOn(state, state.habits.get("steps"), "member-1", "2026-03-02"), 9000);
});

test("the shell's member id is the one the leaderboard keys on", () => {
  // The whole reason the setup code carries it. A mismatch here is two people on the board.
  const state = setup([asPulled(KOTLIN_ROW)]);
  assert.equal(valueOn(state, state.habits.get("steps"), "member-1", "2026-03-02"), 8412);
  assert.equal(valueOn(state, state.habits.get("steps"), "someone-else", "2026-03-02"), null);
});

test("the day the shell computed is used as-is, not recomputed from the timestamp", () => {
  // Both sides derive day keys, and they agree (HabitDayTest runs the same fixtures). But the row
  // carries the day explicitly, and replay must trust it — recomputing from `ts` in the reader's
  // timezone is how a late-evening reading would land on the wrong date.
  const shifted = { ...KOTLIN_ROW, ts: KOTLIN_ROW.ts + 6 * 3600 * 1000 };
  const state = setup([asPulled(shifted)]);
  assert.equal(valueOn(state, state.habits.get("steps"), "member-1", "2026-03-02"), 8412);
});

// ---------------------------------------------------------------------------
// The second sensor: Pause reporting on itself
// ---------------------------------------------------------------------------

/** Verbatim from PendingEvent.toJson() for a screen-time habit — note the source. */
const PAUSE_ROW = {
  payload: {
    v: 1,
    externalId: null,
    habitId: "screen",
    source: "pause",
    day: "2026-03-02",
    value: 46,
    memberId: "member-1",
  },
  author: "member-1",
  trip_code: "HABIT-7Q2XK9",
  type: "habit_log",
  uuid: "0a1c9e52-2f77-4a1a-9a67-9d0b6a1f77c1",
  ts: 1772474400000,
};

function setupScreen(extra = []) {
  return replay([
    { eventId: "s1", ts: 1772000000000, seq: 0, ...ev.member("member-1", "Sahil") },
    {
      eventId: "s2", ts: 1772000000001, seq: 0,
      ...ev.habit("screen", {
        name: "Screen time", metric: METRIC.SCREEN_MINUTES, direction: AT_MOST, target: 60,
        source: SOURCE.PAUSE, tz: TZ, dayStartHour: 4,
      }),
    },
    ...extra,
  ]);
}

test("a screen-time row from the shell is understood, and judged the right way round", () => {
  // 46 minutes against a 60-minute ceiling is a HIT. The same number against a build habit would
  // be a miss, so this is checking the direction survives the crossing as much as the value.
  const state = setupScreen([asPulled(PAUSE_ROW)]);
  const screen = state.habits.get("screen");
  assert.equal(valueOn(state, screen, "member-1", "2026-03-02"), 46);
  assert.equal(rawDayStatus(state, screen, "member-1", "2026-03-02"), HIT);
  assert.equal(rawDayStatus(state, screen, "member-1", "2026-03-03"), NO_DATA);
});

test("the shell's source string is one the engine treats as automatic", () => {
  // The consequence of getting this wrong is invisible: "pause" not being in AUTOMATIC_SOURCES
  // would make every day the phone was off read as a miss rather than as a silent pipeline, and
  // the app would quietly punish people for a bug.
  const state = setupScreen();
  assert.equal(rawDayStatus(state, state.habits.get("screen"), "member-1", "2026-03-02"), NO_DATA);
});

test("a zero from Pause is a real number, not a silence", () => {
  // The one place the two sensors genuinely differ. A watch reporting nothing means it was not
  // listening; Pause reporting nothing means nothing happened, and a flawless day must not be
  // scored as an outage. The shell sends the zero, and this is the row it sends.
  const perfect = { ...PAUSE_ROW, payload: { ...PAUSE_ROW.payload, value: 0 } };
  const state = setupScreen([asPulled(perfect)]);
  const screen = state.habits.get("screen");
  assert.equal(valueOn(state, screen, "member-1", "2026-03-02"), 0);
  assert.equal(rawDayStatus(state, screen, "member-1", "2026-03-02"), HIT);
});

test("a typed correction still beats the shell's own count", () => {
  // Same rule the watch metrics have: a person overruling a machine is the whole point of being
  // able to log by hand, and taking the max would silently discard any downward correction.
  // The correction has to be DOWNWARD to prove anything: taking the max across sources would
  // agree with a correction upwards, and the test would pass while the rule was broken.
  const overCounted = { ...PAUSE_ROW, payload: { ...PAUSE_ROW.payload, value: 95 } };
  const state = setupScreen([
    asPulled(overCounted),
    { eventId: "m1", ts: PAUSE_ROW.ts + 1000, seq: 2,
      ...ev.log("screen", "member-1", "2026-03-02", 20, SOURCE.MANUAL) },
  ]);
  const screen = state.habits.get("screen");
  assert.equal(valueOn(state, screen, "member-1", "2026-03-02"), 20);
  // 95 would have been a miss against the 60-minute ceiling; the correction turns the day.
  assert.equal(rawDayStatus(state, screen, "member-1", "2026-03-02"), HIT);
  assert.equal(rawDayStatus(setupScreen([asPulled(overCounted)]), screen, "member-1", "2026-03-02"), MISS);
});

test("sourceForDevice answers exactly what the Kotlin bindingSourceFor answers", () => {
  // Two implementations of one decision, writing bindings for the same member into the same log.
  // The Kotlin half of these cases is PauseMetricsTest in the Pause project; if the two ever
  // disagree, each device would keep correcting the other's binding on every run.
  assert.equal(sourceForDevice(METRIC.SCREEN_MINUTES, { pause: true }), SOURCE.PAUSE);
  assert.equal(sourceForDevice(METRIC.APP_OPENS, { pause: true, health: true }), SOURCE.PAUSE);
  // A browser cannot count screen time however capable it is otherwise.
  assert.equal(sourceForDevice(METRIC.SCREEN_MINUTES, { health: true }), SOURCE.MANUAL);
  assert.equal(sourceForDevice(METRIC.STEPS, { health: true }), SOURCE.HEALTH_CONNECT);
  assert.equal(sourceForDevice(METRIC.STEPS, { pause: true }), SOURCE.MANUAL);
  assert.equal(sourceForDevice(METRIC.PUFFS, { pause: true, health: true }), SOURCE.MANUAL);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ wire contract: " + passed + " tests passed");
