// ingest.test.mjs — the sensor-to-log rules, as executable specification.
//
// This is the layer that decides what a poll is allowed to write. Getting it wrong does not throw
// — it quietly floods the shared log with telemetry until replay crawls and pull_events needs
// dozens of round trips to catch up. So the throttling rules get tests of their own.

import assert from "node:assert/strict";
import { replay, dayKey, addDays, valueOn, sourceFor, NO_DATA, MISS, rawDayStatus } from "../js/habits.js";
import { samplesToEvents, instantFor, THROTTLE_MS } from "../js/ingest.js";
import { ev, METRIC, SOURCE, AT_LEAST, AGGREGATE } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg"; // UTC+2, no DST
let _seq = 0;
function at(day, hour = 12, minute = 0) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - 2, minute);
}
function E(spec, ts) {
  _seq += 1;
  return { eventId: "e" + String(_seq).padStart(4, "0"), ts, seq: _seq, ...spec };
}

const D0 = "2026-03-02";
const day = (n) => addDays(D0, n);

/** Two Samsung users on Health Connect, one older phone typing it in — the real group. */
function fixture(extra = []) {
  return replay([
    E(ev.member("sam1", "Alice"), at(D0, 6)),
    E(ev.member("sam2", "Bob"), at(D0, 6)),
    E(ev.member("gar1", "Carol"), at(D0, 6)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      tz: TZ, dayStartHour: 4, source: SOURCE.MANUAL,
    }), at(D0, 6)),
    E(ev.habit("sleep", {
      name: "Sleep", metric: METRIC.SLEEP, direction: AT_LEAST, target: 420,
      tz: TZ, dayStartHour: 4, source: SOURCE.MANUAL,
    }), at(D0, 6)),
    // The two Samsung phones bind to Health Connect; Carol stays manual.
    E(ev.bind("sam1", "steps", SOURCE.HEALTH_CONNECT), at(D0, 7)),
    E(ev.bind("sam1", "sleep", SOURCE.HEALTH_CONNECT), at(D0, 7)),
    E(ev.bind("sam2", "steps", SOURCE.HEALTH_CONNECT), at(D0, 7)),
    ...extra,
  ]);
}

const hcBatch = (samples) => ({ source: SOURCE.HEALTH_CONNECT, samples });

// ===========================================================================
// Per-member source binding
// ===========================================================================

test("a member's binding beats the habit's default source", () => {
  const s = fixture();
  const steps = s.habits.get("steps");
  assert.equal(sourceFor(s, steps, "sam1"), SOURCE.HEALTH_CONNECT);
  assert.equal(sourceFor(s, steps, "gar1"), SOURCE.MANUAL);
});

test("the same silent day is NO_DATA for the watch user and a real MISS for the manual one", () => {
  // This is the whole point of per-member bindings: one shared habit, two honest verdicts.
  const s = fixture();
  const steps = s.habits.get("steps");
  assert.equal(rawDayStatus(s, steps, "sam1", day(1)), NO_DATA);
  assert.equal(rawDayStatus(s, steps, "gar1", day(1)), MISS);
});

test("a batch only writes into habits this member is actually bound to", () => {
  const s = fixture();
  // Carol is manual, so a Health Connect batch for her must produce nothing at all.
  const { events } = samplesToEvents(s, "gar1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 12000 }]),
    { now: at(day(0), 10) });
  assert.equal(events.length, 0);
});

// ===========================================================================
// Attribution
// ===========================================================================

test("sleep is attributed to the day you woke up, not the day you lay down", () => {
  const start = at(day(0), 23, 0);   // Monday 23:00
  const end = at(day(1), 6, 30);     // Tuesday 06:30
  assert.equal(instantFor(METRIC.SLEEP, { start, end }), end);
  assert.equal(instantFor(METRIC.STEPS, { start, end }), start);

  const s = fixture();
  const { events } = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.SLEEP, start, end, value: 450 }]),
    { now: at(day(1), 8) });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.day, day(1), "sleep belongs to the wake day");
});

test("a late-evening reading stays on the local day, not UTC's tomorrow", () => {
  const s = fixture();
  const { events } = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 23, 30), value: 11000 }]),
    { now: at(day(0), 23, 40) });
  assert.equal(events[0].payload.day, day(0));
});

// ===========================================================================
// Throttling — the rules that keep the log from drowning in telemetry
// ===========================================================================

test("the first reading of a day is always written", () => {
  const s = fixture();
  const { events } = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 900 }]),
    { now: at(day(0), 9) });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.value, 900);
});

test("an unchanged re-report writes nothing — the common case for a 15-minute poll", () => {
  const s = fixture([
    E(ev.log("steps", "sam1", day(0), 8000, SOURCE.HEALTH_CONNECT), at(day(0), 14)),
  ]);
  const { events } = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 8000 }]),
    { now: at(day(0), 14, 15) });
  assert.equal(events.length, 0);
});

test("a creeping value is throttled, so a polled total does not append 96 rows a day", () => {
  const s = fixture([
    E(ev.log("steps", "sam1", day(0), 8000, SOURCE.HEALTH_CONNECT), at(day(0), 14)),
  ]);
  const emitted = new Map([["steps|" + day(0), at(day(0), 14)]]);
  const soon = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 8300 }]),
    { now: at(day(0), 14, 15), emitted });
  assert.equal(soon.events.length, 0, "15 minutes later, still under target: not worth a row");

  const later = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 8300 }]),
    { now: at(day(0), 14) + THROTTLE_MS + 1000, emitted });
  assert.equal(later.events.length, 1, "past the throttle, the day's value is refreshed");
});

test("crossing the target is written immediately, whatever the throttle says", () => {
  const s = fixture([
    E(ev.log("steps", "sam1", day(0), 9800, SOURCE.HEALTH_CONNECT), at(day(0), 17)),
  ]);
  const emitted = new Map([["steps|" + day(0), at(day(0), 17)]]);
  const { events } = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 10100 }]),
    { now: at(day(0), 17, 5), emitted });
  assert.equal(events.length, 1, "hitting 10k is the moment worth telling the group about");
  assert.equal(events[0].payload.value, 10100);
});

test("a backfill for a closed day is always written", () => {
  const s = fixture([
    E(ev.log("steps", "sam1", day(0), 6000, SOURCE.HEALTH_CONNECT), at(day(0), 22)),
  ]);
  const emitted = new Map([["steps|" + day(0), at(day(0), 22)]]);
  const { events } = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 9100 }]),
    { now: at(day(1), 7), emitted }); // the watch synced overnight
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.day, day(0));
});

test("a reading older than the backfill window is dropped before it is ever written", () => {
  const s = fixture();
  const { events } = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 12000 }]),
    { now: at(day(6), 9) });
  assert.equal(events.length, 0, "the engine would reject it on replay; do not store a dead row");
});

test("the returned throttle state is what makes the decision pure", () => {
  const s = fixture();
  const first = samplesToEvents(s, "sam1",
    hcBatch([{ metric: METRIC.STEPS, start: at(day(0), 9), value: 900 }]),
    { now: at(day(0), 9) });
  assert.equal(first.emitted.get("steps|" + day(0)), at(day(0), 9));
  // The caller persists `emitted` and hands it back, so a WebView teardown cannot reset the
  // throttle and put the flood straight back.
  assert.ok(first.emitted instanceof Map);
});

test("discrete habits are left alone — an urge is not a running total", () => {
  const s = replay([
    E(ev.member("sam1", "Alice"), at(D0, 6)),
    E(ev.habit("urges", {
      name: "Vape puffs", metric: METRIC.PUFFS, aggregate: AGGREGATE.SUM,
      tz: TZ, dayStartHour: 4, source: SOURCE.PAUSE,
    }), at(D0, 6)),
    E(ev.bind("sam1", "urges", SOURCE.PAUSE), at(D0, 7)),
  ]);
  const { events } = samplesToEvents(s, "sam1",
    { source: SOURCE.PAUSE, samples: [{ metric: METRIC.PUFFS, start: at(day(0), 12), value: 1 }] },
    { now: at(day(0), 12) });
  assert.equal(events.length, 0, "discrete events go through their own append path");
});

test("two metrics in one batch each land on their own habit", () => {
  const s = fixture();
  const { events } = samplesToEvents(s, "sam1", hcBatch([
    { metric: METRIC.STEPS, start: at(day(0), 9), value: 11000 },
    { metric: METRIC.SLEEP, start: at(day(0), 23), end: at(day(1), 6), value: 430 },
  ]), { now: at(day(1), 8) });
  assert.equal(events.length, 2);
  const byHabit = Object.fromEntries(events.map((e) => [e.payload.habitId, e.payload.day]));
  assert.equal(byHabit.steps, day(0));
  assert.equal(byHabit.sleep, day(1));
});

// ---------------------------------------------------------------------------
if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ ingest: " + passed + " tests passed");
