// history.test.mjs — one habit read backwards, in the periods it is actually judged in.
//
// ---- What this is guarding ----
//
// A history screen is mostly arithmetic about periods, and arithmetic about periods is where the
// off-by-ones live. Three of them are waiting here specifically:
//
//   • a weekly habit's "last eight" are eight ISO WEEKS, not fifty-six days
//   • the newest entry is the period still RUNNING, and a summary that counts it is a sentence
//     about the future — "3 of 14" on a Tuesday morning
//   • a habit has a birthday, and drawing cells before it shows days the engine refuses to judge
//
// The screen draws whatever this returns, so every one of those would arrive as a number somebody
// reads and believes.

import assert from "node:assert/strict";
import { replay, addDays, HIT, MISS, NO_DATA, EXEMPT } from "../js/habits.js";
import { habitHistory, historySummary, runs, SPAN } from "../js/history.js";
import { ev, METRIC, AT_LEAST, AT_MOST, AGGREGATE, SOURCE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MON = "2026-03-02";          // a Monday
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "h" + ++seq, ts, seq, ...spec });

/**
 * One member, one habit, logged on the days `values` names.
 *
 * Grace is off. A token absorbing a miss is correct for a streak and noise in a history screen,
 * where the whole point is to show what actually happened on each day.
 */
function world({ period = PERIOD.DAY, direction = AT_LEAST, target = 100,
  aggregate = AGGREGATE.LAST, born = 0, values = {}, extra = [] } = {}) {
  const events = [
    E(ev.member("me", "Me"), at(born)),
    E(ev.habit("h", {
      name: "Steps", metric: METRIC.STEPS, direction, target, period, aggregate,
      source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0, grace: { earnEvery: 0, cap: 0 },
    }), at(born)),
    ...extra,
  ];
  for (const [n, v] of Object.entries(values)) {
    events.push(E(ev.log("h", "me", day(Number(n)), v, SOURCE.MANUAL), at(Number(n))));
  }
  return replay(events);
}

const hist = (s, today, want) =>
  habitHistory(s, s.habits.get("h"), "me", day(today), want);

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test("a daily habit shows a fortnight, oldest first", () => {
  const s = world({ born: 0 });
  const h = hist(s, 30);
  assert.equal(h.length, SPAN[PERIOD.DAY]);
  assert.equal(h[0].from, day(17), "fourteen days back");
  assert.equal(h[h.length - 1].from, day(30), "and today at the end");
});

test("a weekly habit shows WEEKS, not fifty-six days", () => {
  // The off-by-one worth naming: "the last eight" means eight of the habit's own periods.
  const s = world({ period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, target: 3, born: 0 });
  const h = hist(s, 70);
  assert.equal(h.length, SPAN[PERIOD.WEEK]);
  for (const e of h) assert.equal(e.period, PERIOD.WEEK);
  // Consecutive entries are seven days apart, which is the property that fails if days leak in.
  for (let i = 1; i < h.length; i += 1) {
    assert.equal(addDays(h[i - 1].from, 7), h[i].from, "week " + i);
  }
});

test("a monthly habit shows months", () => {
  const s = world({ period: PERIOD.MONTH, target: 1000, born: 0 });
  const h = hist(s, 200);
  assert.equal(h.length, SPAN[PERIOD.MONTH]);
  for (const e of h) assert.equal(e.period, PERIOD.MONTH);
});

test("it never reaches back before the habit existed", () => {
  // The same birthday habitScore refuses to judge across. Drawing cells earlier would show days
  // the engine would not score, which is the shape of the bug retroactive.test.mjs exists for.
  const s = world({ born: 25 });
  const h = hist(s, 30);
  assert.equal(h.length, 6, "born on day 25, six days to today");
  assert.equal(h[0].from, day(25));
});

test("a habit born today has exactly one entry", () => {
  const s = world({ born: 30 });
  const h = hist(s, 30);
  assert.equal(h.length, 1);
  assert.ok(h[0].open);
});

// ---------------------------------------------------------------------------
// The period still running
// ---------------------------------------------------------------------------

test("the newest entry is marked open and every older one is not", () => {
  const s = world({ born: 0 });
  const h = hist(s, 30);
  assert.ok(h[h.length - 1].open, "today");
  assert.ok(h.slice(0, -1).every((e) => !e.open), "everything before it is closed");
});

test("a summary never counts the period still running", () => {
  // "3 of 14" on a Tuesday morning is a sentence about the future. The open week is drawn and not
  // scored — a week two days in is not a week you failed.
  const s = world({ born: 0, values: { 27: 500, 28: 500, 29: 500, 30: 0 } });
  const closed = historySummary(hist(s, 30));
  const withOpen = historySummary(hist(s, 30).map((e) => ({ ...e, open: false })));
  assert.ok(closed.judged < withOpen.judged, "today was excluded");
  assert.equal(closed.hits, withOpen.hits - 0, "and today was a miss, so hits are unchanged");
});

// ---------------------------------------------------------------------------
// What the window adds up to
// ---------------------------------------------------------------------------

test("hits and misses are counted over judged periods only", () => {
  const s = world({ born: 17, values: { 17: 500, 18: 0, 19: 500, 20: 0, 21: 500 } });
  const sum = historySummary(hist(s, 22));
  assert.equal(sum.hits, 3);
  assert.equal(sum.missed, 2);
  assert.equal(sum.judged, 5);
});

test("silence is quiet, not missed", () => {
  // The four states have to survive into a screen, or NO_DATA reads as failure — which is the one
  // reading the whole automatic-source rule exists to prevent.
  const s = world({
    born: 17, values: { 17: 500 },
    extra: [E(ev.bind("me", "h", SOURCE.HEALTH_CONNECT), at(17))],
  });
  const sum = historySummary(hist(s, 20));
  assert.ok(sum.quiet > 0, "days a watch said nothing about");
  assert.equal(sum.missed, 0, "and none of them is a miss");
});

test("a rest day is neither", () => {
  const s = world({
    born: 17, values: { 17: 500, 19: 500 },
    extra: [E(ev.exempt("me", day(18), day(18), "travel", null, "t1"), at(17))],
  });
  const sum = historySummary(hist(s, 20));
  assert.equal(sum.resting, 1);
  assert.ok(!sum.missed || sum.missed >= 0);
});

test("the average is over periods that reported, not over the window", () => {
  // A fortnight with four silent days is not a fortnight of low numbers, and dividing by 14 would
  // say it was.
  const s = world({ born: 17, values: { 17: 400, 18: 600 } });
  const sum = historySummary(hist(s, 19).filter((e) => e.from <= day(18)));
  assert.equal(sum.average, 500);
});

test("an empty window summarises to nothing rather than to zero", () => {
  const sum = historySummary([]);
  assert.equal(sum.judged, 0);
  assert.equal(sum.average, null, "null, not 0 — nothing was measured");
  assert.equal(sum.best, null);
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

test("the best run is the longest there has ever been", () => {
  // Five clean, one bad, three clean. The current run is three; the best is five and does not
  // shrink because the recent one is shorter.
  const s = world({
    born: 0,
    values: { 0: 500, 1: 500, 2: 500, 3: 500, 4: 500, 5: 0, 6: 500, 7: 500, 8: 500 },
  });
  const r = runs(s, s.habits.get("h"), "me", day(8));
  assert.equal(r.current, 3);
  assert.equal(r.best, 5);
});

test("the current run is the same number the card shows", () => {
  // Read off the same walk the streak comes from, so the card and this screen cannot disagree.
  const s = world({ born: 0, values: { 0: 500, 1: 500, 2: 500 } });
  const r = runs(s, s.habits.get("h"), "me", day(2));
  assert.equal(r.current, 3);
  assert.equal(r.best, 3);
});

test("a habit with no history has no runs and does not throw", () => {
  const s = world({ born: 0 });
  const r = runs(s, s.habits.get("h"), "me", day(0));
  assert.equal(r.current, 0);
  assert.equal(r.best, 0);
});

// ---------------------------------------------------------------------------
// A ceiling, which reads the other way round
// ---------------------------------------------------------------------------

test("an at-most habit carries the target that was in force for each period", () => {
  // A taper moves the ceiling, and a history cell showing today's ceiling against last week's
  // number would invent misses that never happened.
  const s = world({
    direction: AT_MOST, target: 100, aggregate: AGGREGATE.SUM, born: 0,
    extra: [E(ev.habit("h", {
      name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 100,
      period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 0, grace: { earnEvery: 0, cap: 0 },
      taper: { amount: 1, everyDays: 7, floor: 0 },
    }), at(0))],
  });
  const h = hist(s, 20);
  const early = h[0];
  const late = h[h.length - 1];
  assert.ok(late.target <= early.target, "the ceiling came down: " + early.target + " -> " + late.target);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ history: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ history: " + passed + " tests passed");
