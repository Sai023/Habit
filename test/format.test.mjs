// format.test.mjs — the small conversions the edit screens lean on.
//
// These are the kind of pure helper that never gets a test because it "obviously works", and then a
// reminder set for 07:00 saves as null, or a typo saves as a minute that does not exist. The clock
// field is the one here that turns free text into a stored number, so it is the one worth pinning.

import assert from "node:assert/strict";
import { toClock, fromClock, axisValue, dateRange, chartTicks, niceTop, seasonNextTag, dayLabel } from "../js/ui/format.js";
import { METRIC, PERIOD } from "../js/schema.js";

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

// ---- the season card's tag ----

test("seasonNextTag names what follows, says so when nothing does, and is silent mid-season", () => {
  assert.equal(seasonNextTag({ next: { index: 4, from: "2026-09-20" }, ended: false }),
    "then Season 4 \u00b7 " + dayLabel("2026-09-20"));
  assert.equal(seasonNextTag({ next: { from: "2026-09-20" }, ended: false }),
    "then the next \u00b7 " + dayLabel("2026-09-20"), "an unnumbered successor is still announced");
  assert.equal(seasonNextTag({ next: null, ended: true }), "nothing booked yet",
    "after a season with no successor, the board is the one place that says so");
  assert.equal(seasonNextTag({ next: null, ended: false }), null, "mid-season with nothing booked is not yet a line");
  assert.equal(seasonNextTag(null), null);
});

// ---- the history chart's words ----

test("axisValue shortens a number to fit beside a bar", () => {
  assert.equal(axisValue(METRIC.SLEEP, 420), "7h");
  assert.equal(axisValue(METRIC.SLEEP, 450), "7.5h");
  assert.equal(axisValue(METRIC.SLEEP, 455), "7.6h", "one decimal, no more");
  assert.equal(axisValue(METRIC.SCREEN_MINUTES, 45), "45m", "under an hour stays in minutes");
  assert.equal(axisValue(METRIC.STEPS, 10000), "10k");
  assert.equal(axisValue(METRIC.STEPS, 12480), "12.5k");
  assert.equal(axisValue(METRIC.PUFFS, 560), "560");
  assert.equal(axisValue(METRIC.SESSIONS, 3.6), "4");
  assert.equal(axisValue(METRIC.AMOUNT, 1000), "1k");
  assert.equal(axisValue(METRIC.STEPS, null), "");
  assert.equal(axisValue(METRIC.STEPS, NaN), "");
});

test("niceTop is the next round number in the metric's own units, and never below the value", () => {
  assert.equal(niceTop(METRIC.SLEEP, 470), 480, "7h50m tops out at 8h");
  assert.equal(niceTop(METRIC.SLEEP, 480), 480, "exactly 8h stays 8h");
  assert.equal(niceTop(METRIC.SCREEN_MINUTES, 144), 150, "under four hours, half hours");
  assert.equal(niceTop(METRIC.STEPS, 12480), 14000);
  assert.equal(niceTop(METRIC.STEPS, 10800), 12000);
  assert.equal(niceTop(METRIC.STEPS, 8000), 8000);
  assert.equal(niceTop(METRIC.PUFFS, 560), 560);
  assert.equal(niceTop(METRIC.PUFFS, 563), 580);
  assert.equal(niceTop(METRIC.SESSIONS, 4), 4, "a count under ten is its own top");
  assert.equal(niceTop(METRIC.SESSIONS, 3.6), 4);
  assert.equal(niceTop(METRIC.AMOUNT, 1050), 1200);
  assert.equal(niceTop(METRIC.STEPS, 0), 1, "never zero — a height cannot divide by it");
  assert.equal(niceTop(METRIC.STEPS, NaN), 1);
});

test("dateRange says a window once, in the fewest words that place it", () => {
  assert.equal(dateRange("2026-09-07", "2026-09-20"), "7 – 20 Sep");
  assert.equal(dateRange("2026-08-31", "2026-09-13"), "31 Aug – 13 Sep");
  assert.equal(dateRange("2025-12-28", "2026-01-10"), "28 Dec 2025 – 10 Jan 2026");
  assert.equal(dateRange("2026-09-18", "2026-09-18"), "18 Sep", "one day is one date");
  assert.equal(dateRange("2026-04-01", "2026-09-30", PERIOD.MONTH), "Apr – Sep 2026");
  assert.equal(dateRange("2025-10-01", "2026-03-31", PERIOD.MONTH), "Oct 2025 – Mar 2026");
  assert.equal(dateRange("2026-09-01", "2026-09-30", PERIOD.MONTH), "Sep 2026");
  assert.equal(dateRange(null, "2026-09-30"), "");
});

test("chartTicks labels every bar once and marks where the calendar turns", () => {
  const D = (from) => ({ from, period: PERIOD.DAY });
  // Sat 12 Sep – Tue 15 Sep 2026: the date under the first bar and under the Monday.
  assert.deepEqual(chartTicks([D("2026-09-12"), D("2026-09-13"), D("2026-09-14"), D("2026-09-15")]), [
    { main: "S", sub: "12" }, { main: "S", sub: null }, { main: "M", sub: "14" }, { main: "T", sub: null },
  ]);
  const W = (from) => ({ from, period: PERIOD.WEEK });
  assert.deepEqual(chartTicks([W("2026-08-24"), W("2026-08-31"), W("2026-09-07")]), [
    { main: "24", sub: "Aug" }, { main: "31", sub: null }, { main: "7", sub: "Sep" },
  ], "a week is its Monday's date, and the month appears where it changes");
  const M = (from) => ({ from, period: PERIOD.MONTH });
  assert.deepEqual(chartTicks([M("2025-11-01"), M("2025-12-01"), M("2026-01-01")]), [
    { main: "Nov", sub: "2025" }, { main: "Dec", sub: null }, { main: "Jan", sub: "2026" },
  ], "a month is its name, and the year appears under the first and each January");
  assert.deepEqual(chartTicks([]), []);
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
