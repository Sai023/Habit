// undo.test.mjs — taking back a number you typed.
//
// ---- The two things that made it necessary ----
//
// A typed number overrules every sensor for its day, permanently. That is the right rule and it is
// written down where it is applied: correcting a watch that over-counted must not be discarded for
// being smaller. The cost only shows up later — ten minutes after you type 6 000 steps because
// sync looked stuck, the watch catches up, and the day is stuck on your guess for ever.
//
// And on a habit that ADDS, nothing you type can ever bring a total down. A mistyped 30 puffs is
// there for good, because every correction is another addition.
//
// ---- Why it is an append and not a delete ----
//
// The log only appends and every device derives everything by replaying it. The row is on three
// phones and a server; there is nothing to delete. So withdrawal is a thing that HAPPENED, the same
// way ending a trip early is — T.EXEMPT already ends a period by writing a second event rather than
// removing the first.
//
// That also keeps the history honest. "Sam logged 3 and took it back" is what occurred, and a log
// that could forget the first half is a log you could quietly launder.

import assert from "node:assert/strict";
import { replay, addDays, valueOn, manualOn, rawPeriodStatus, HIT, MISS, NO_DATA } from "../js/habits.js";
import { ev, T, METRIC, AT_LEAST, AT_MOST, AGGREGATE, SOURCE, PERIOD } from "../js/schema.js";

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
const E = (spec, ts) => ({ eventId: "u" + ++seq, ts, seq, ...spec });

const ME = "m1";

/** Steps: automatic, LAST, with a watch underneath whatever gets typed. */
const STEPS = ev.habit("steps", {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
  period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT,
  days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
});

/** Puffs: a manual ceiling that ADDS, so nothing typed can ever bring it down. */
const PUFFS = ev.habit("puffs", {
  name: "Vape puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
  period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
  days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
});

function state(habit, logs = []) {
  return replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    E(habit, at(0)),
    ...logs,
  ]);
}

const h = (s, id) => s.habits.get(id);
/**
 * A withdrawal, at an explicit moment within the day.
 *
 * The offset is a required parameter rather than a default because replay order IS the semantics:
 * a withdrawal removes what was written before it and nothing written after. My first draft
 * timestamped every clear at the top of the day, which put it AHEAD of the entries it was meant to
 * withdraw, and three tests failed for a reason that had nothing to do with the code.
 */
const clear = (id, n, offset, src = "manual") =>
  E(ev.clearLog(id, ME, day(n), src), at(n) + offset);

// ---------------------------------------------------------------------------
// Handing the day back to the sensor
// ---------------------------------------------------------------------------

test("a typed number overrules the watch, which is the rule being undone", () => {
  const s = state(STEPS, [
    E(ev.log("steps", ME, day(1), 1969, "health_connect"), at(1)),
    E(ev.log("steps", ME, day(1), 6000, "manual"), at(1) + 1000),
  ]);
  assert.equal(valueOn(s, h(s, "steps"), ME, day(1)), 6000);
});

test("withdrawing it puts the watch back in charge", () => {
  // The whole point. Not "blank the day" — the sensor's own reading was underneath the entire
  // time and takes over again.
  const s = state(STEPS, [
    E(ev.log("steps", ME, day(1), 1969, "health_connect"), at(1)),
    E(ev.log("steps", ME, day(1), 6000, "manual"), at(1) + 1000),
    clear("steps", 1, 2000),
  ]);
  assert.equal(valueOn(s, h(s, "steps"), ME, day(1)), 1969);
});

test("the sensor's later readings still land after a withdrawal", () => {
  // A withdrawal is a point in the replay, not a state the day enters. Rows written afterwards
  // are ordinary rows.
  const s = state(STEPS, [
    E(ev.log("steps", ME, day(1), 1969, "health_connect"), at(1)),
    E(ev.log("steps", ME, day(1), 6000, "manual"), at(1) + 1000),
    clear("steps", 1, 2000),
    E(ev.log("steps", ME, day(1), 8400, "health_connect"), at(1) + 3000),
  ]);
  assert.equal(valueOn(s, h(s, "steps"), ME, day(1)), 8400);
});

test("only the named source is withdrawn", () => {
  const s = state(STEPS, [
    E(ev.log("steps", ME, day(1), 1969, "health_connect"), at(1)),
    E(ev.log("steps", ME, day(1), 6000, "manual"), at(1) + 1000),
    clear("steps", 1, 2000),
  ]);
  const entries = s.logs.get("steps|" + ME + "|" + day(1));
  assert.equal(entries.length, 1, "the watch's row is untouched");
  assert.equal(entries[0].source, "health_connect");
});

test("only the named day", () => {
  const s = state(STEPS, [
    E(ev.log("steps", ME, day(1), 6000, "manual"), at(1)),
    E(ev.log("steps", ME, day(2), 7000, "manual"), at(2)),
    clear("steps", 1, 2000),
  ]);
  assert.equal(manualOn(s, h(s, "steps"), ME, day(1)), null);
  assert.equal(manualOn(s, h(s, "steps"), ME, day(2)), 7000);
});

// ---------------------------------------------------------------------------
// A habit that adds
// ---------------------------------------------------------------------------

test("a mistyped total can be taken back and re-entered", () => {
  // The case no amount of further logging could fix: SUM only ever goes up.
  const s = state(PUFFS, [
    E(ev.log("puffs", ME, day(1), 30, "manual"), at(1)),
    clear("puffs", 1, 1000),
    E(ev.log("puffs", ME, day(1), 3, "manual"), at(1) + 2000),
  ]);
  assert.equal(valueOn(s, h(s, "puffs"), ME, day(1)), 3);
});

test("withdrawing every entry leaves the day unreported, not zero", () => {
  // The honest outcome and the one worth being warned about: on a habit nothing else feeds, this
  // is a MISS, because a manual habit with no entry is an unreported day.
  const s = state(PUFFS, [
    E(ev.log("puffs", ME, day(1), 3, "manual"), at(1)),
    clear("puffs", 1, 1000),
  ]);
  assert.equal(valueOn(s, h(s, "puffs"), ME, day(1)), null);
  assert.equal(rawPeriodStatus(s, h(s, "puffs"), ME, day(1)), MISS);
});

test("so the way to a clean day is still to say zero", () => {
  // Withdraw, then declare. Two ordinary events, which is why no replace operation was needed.
  const s = state(PUFFS, [
    E(ev.log("puffs", ME, day(1), 30, "manual"), at(1)),
    clear("puffs", 1, 1000),
    E(ev.log("puffs", ME, day(1), 0, "manual"), at(1) + 2000),
  ]);
  assert.equal(rawPeriodStatus(s, h(s, "puffs"), ME, day(1)), HIT);
});

// ---------------------------------------------------------------------------
// What it must not be able to do
// ---------------------------------------------------------------------------

test("history cannot be rewritten outside the backfill window", () => {
  // Without this, last week's crown is winnable on Tuesday by withdrawing the days that lost it.
  // Same guard as T.LOG, keyed off when the withdrawal was AUTHORED.
  const s = replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    E(PUFFS, at(0)),
    E(ev.log("puffs", ME, day(1), 300, "manual"), at(1)),
    // Authored forty days later.
    E(ev.clearLog("puffs", ME, day(1), "manual"), at(41)),
  ]);
  assert.equal(valueOn(s, h(s, "puffs"), ME, day(1)), 300, "the old day is still 300");
});

test("withdrawing nothing does nothing", () => {
  const s = state(PUFFS, [clear("puffs", 1, 1000)]);
  assert.equal(valueOn(s, h(s, "puffs"), ME, day(1)), null);
});

test("a withdrawal for another member leaves mine alone", () => {
  const s = replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    E(ev.member("m2", "Anj"), at(0)),
    E(PUFFS, at(0)),
    E(ev.log("puffs", ME, day(1), 5, "manual"), at(1)),
    E(ev.clearLog("puffs", "m2", day(1), "manual"), at(1) + 1000),
  ]);
  assert.equal(valueOn(s, h(s, "puffs"), ME, day(1)), 5);
});

// ---------------------------------------------------------------------------
// What the sheet asks before it offers the button
// ---------------------------------------------------------------------------

test("manualOn reports what was typed, not what the day says", () => {
  // On an automatic habit those differ exactly when this matters.
  const s = state(STEPS, [
    E(ev.log("steps", ME, day(1), 1969, "health_connect"), at(1)),
    E(ev.log("steps", ME, day(1), 6000, "manual"), at(1) + 1000),
  ]);
  assert.equal(manualOn(s, h(s, "steps"), ME, day(1)), 6000);
});

test("manualOn is null when only a sensor reported", () => {
  // Which is what keeps the button off a day nobody typed on.
  const s = state(STEPS, [E(ev.log("steps", ME, day(1), 1969, "health_connect"), at(1))]);
  assert.equal(manualOn(s, h(s, "steps"), ME, day(1)), null);
  assert.equal(rawPeriodStatus(s, h(s, "steps"), ME, day(1)), MISS, "1 969 is short of 10 000");
});

test("manualOn follows the habit's own aggregate rule", () => {
  // Not a second copy of it. Three typed entries on a SUM habit are 6, not the last one.
  const s = state(PUFFS, [
    E(ev.log("puffs", ME, day(1), 1, "manual"), at(1)),
    E(ev.log("puffs", ME, day(1), 2, "manual"), at(1) + 1000),
    E(ev.log("puffs", ME, day(1), 3, "manual"), at(1) + 2000),
  ]);
  assert.equal(manualOn(s, h(s, "puffs"), ME, day(1)), 6);
});

test("a typed zero is something to offer to remove", () => {
  // null means "nothing typed" and 0 means "typed nothing", and the button depends on the
  // difference — otherwise declaring a clean day would be the one entry you could not take back.
  const s = state(PUFFS, [E(ev.log("puffs", ME, day(1), 0, "manual"), at(1))]);
  assert.equal(manualOn(s, h(s, "puffs"), ME, day(1)), 0);
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

test("a withdrawal is a real event type an older build will skip", () => {
  // Stated rather than assumed. isKnown drops types a build has never heard of, so a phone that
  // has not reloaded goes on showing the withdrawn number. That divergence is the accepted cost
  // and is written up on ev.clearLog; what must not happen is it being read as something else.
  const spec = ev.clearLog("puffs", ME, day(1), "manual");
  assert.equal(spec.type, T.LOG_CLEAR);
  assert.notEqual(spec.type, T.LOG);
  assert.equal(spec.payload.source, "manual");
  assert.equal(spec.payload.day, day(1));
});

test("the source defaults to manual, which is the only one a person can write", () => {
  assert.equal(ev.clearLog("puffs", ME, day(1)).payload.source, SOURCE.MANUAL);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ undo: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ undo: " + passed + " tests passed");
