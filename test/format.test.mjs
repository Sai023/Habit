// format.test.mjs — the small conversions the edit screens lean on.
//
// These are the kind of pure helper that never gets a test because it "obviously works", and then a
// reminder set for 07:00 saves as null, or a typo saves as a minute that does not exist. The clock
// field is the one here that turns free text into a stored number, so it is the one worth pinning.

import assert from "node:assert/strict";
import { toClock, fromClock } from "../js/ui/format.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

test("toClock renders a minute of the day as a zero-padded time", () => {
  assert.equal(toClock(0), "00:00");
  assert.equal(toClock(420), "07:00");
  assert.equal(toClock(545), "09:05", "single-digit minutes are padded");
  assert.equal(toClock(1439), "23:59", "the last minute of the day");
});

test("fromClock parses a time back to a minute of the day", () => {
  assert.equal(fromClock("07:00"), 420);
  assert.equal(fromClock("9:05"), 545, "a single-digit hour still parses");
  assert.equal(fromClock("00:00"), 0);
  assert.equal(fromClock("23:59"), 1439);
});

test("fromClock and toClock round-trip every minute of the day", () => {
  for (let m = 0; m < 1440; m += 1) {
    assert.equal(fromClock(toClock(m)), m, "round-trip failed at minute " + m);
  }
});

test("fromClock refuses what is not a time, and clamps what is out of range", () => {
  assert.equal(fromClock(""), null);
  assert.equal(fromClock(null), null);
  assert.equal(fromClock("half seven"), null, "words are not a time");
  assert.equal(fromClock("7"), null, "an hour with no minutes is not a complete time");
  assert.equal(fromClock("25:00"), 1439, "past midnight clamps to the last minute, never wraps");
  assert.equal(fromClock("-1:00"), 0, "before the day clamps to the first minute");
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ format (edit-screen conversions): " + passed + " tests passed");
