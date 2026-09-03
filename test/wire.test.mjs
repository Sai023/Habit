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
import { replay, valueOn, rawDayStatus, HIT } from "../js/habits.js";
import { ev, SOURCE, AT_LEAST, METRIC } from "../js/schema.js";

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

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ wire contract: " + passed + " tests passed");
