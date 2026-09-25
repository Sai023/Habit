// perf.test.mjs — a real event log, at real scale, asked about out of order.
//
// Every other test file builds a fresh fixture per case and asks it about days in increasing
// order. Real callers do not: the board asks about last week, then a habit's own history sheet
// asks about week three, then the board re-asks about last week again — all against the SAME
// replayed state, because getState() caches it (see store.js). While building the taper (Sept
// 2026), 254 green tests missed exactly this: a memo cached a single running total of weeks held
// instead of a per-week figure, so asking about an EARLIER week after a LATER one had already been
// walked returned the later total — the ceiling ran upwards instead of down, and scoring the same
// state twice gave two different answers. A throwaway timing probe caught it in minutes; nothing
// here had been asking in that order. See habits.js's "---- The cache ----" comment on taperPlan
// for the fix. This file is that probe, kept, so the next caching bug fails here instead.
//
// It also does what the probe was originally FOR: times replay()/dailyFacts()/leaderboard() over a
// multi-year, multi-member log, because DATA-ARCHITECTURE.md is explicit that dailyFacts is
// habits × days and should be measured at real scale rather than assumed free.

import assert from "node:assert/strict";
import { replay, targetFor, addDays, TAPER_MISS_LIMIT } from "../js/habits.js";
import { leaderboard } from "../js/score.js";
import { dailyFacts } from "../js/dailyfacts.js";
import { ev, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, METRIC, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const BASE_DAY = "2026-01-05"; // a Monday
let _seq = 0;
function at(day, hour = 20) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - 2);
}
function E(spec, ts) {
  _seq += 1;
  return { eventId: "p" + String(_seq).padStart(5, "0"), ts, seq: _seq, ...spec };
}

// ---------------------------------------------------------------------------
// Order-independence: the exact bug class the taper cache used to have.
// ---------------------------------------------------------------------------

/**
 * A year of a tapering habit for one member, with four weeks deliberately HELD (3+ missed days),
 * spread across the range. A fixture that never holds a week can't exercise the running-total bug
 * at all — holdsBefore stays all-zero regardless of call order — so the holds are the point.
 */
function tapingYear(memberId = "m1") {
  const events = [
    E(ev.member(memberId, "Member"), at(BASE_DAY, 7)),
    E(ev.habit("puffs", {
      name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
      aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
      taper: { percent: 10, everyDays: 7, floor: 0 },
    }), at(BASE_DAY, 7)),
    E(ev.goal(memberId, "puffs", { target: 80 }), at(BASE_DAY, 8)),
  ];
  const HELD_WEEKS = new Set([5, 15, 30, 45]); // 0-indexed weeks that miss 3+ days
  const weeks = 55;
  for (let w = 0; w < weeks; w += 1) {
    const weekStart = addDays(BASE_DAY, w * 7);
    const missesThisWeek = HELD_WEEKS.has(w) ? TAPER_MISS_LIMIT : 0;
    for (let d = 0; d < 7; d += 1) {
      const day = addDays(weekStart, d);
      if (d < missesThisWeek) continue; // skip logging = a miss for a manual AT_MOST habit
      events.push(E(ev.log("puffs", memberId, day, 0, SOURCE.MANUAL), at(day)));
    }
  }
  return events;
}

test("targetFor gives the same answer for an early week whether asked before or after a later one", () => {
  const events = tapingYear();

  // Baseline: a fresh state, asked ONLY about the early week, cache never extended past it.
  const freshState = replay(events);
  const puffs = freshState.habits.get("puffs");
  const earlyDay = addDays(BASE_DAY, 10 * 7); // week 10
  const lateDay = addDays(BASE_DAY, 50 * 7);  // week 50
  const baseline = targetFor(freshState, puffs, "m1", earlyDay);

  // The real order: a SEPARATE state (same log, same cache-by-state semantics as getState()) asked
  // about the LATE week first — forcing the taper walk out to week 50 — then asked about the early
  // week second, against the SAME state and therefore the SAME warmed cache.
  const warmedState = replay(events);
  const puffs2 = warmedState.habits.get("puffs");
  targetFor(warmedState, puffs2, "m1", lateDay); // warm the cache out to week 50
  const afterLate = targetFor(warmedState, puffs2, "m1", earlyDay);

  assert.equal(afterLate, baseline,
    `week 10's target moved after week 50 was asked about (baseline ${baseline}, got ${afterLate}) — ` +
    `this is the exact running-total regression the taper cache was fixed for.`);
});

test("the same query against the same state gives the same answer twice", () => {
  const events = tapingYear();
  const state = replay(events);
  const puffs = state.habits.get("puffs");
  const day = addDays(BASE_DAY, 30 * 7);

  const first = targetFor(state, puffs, "m1", day);
  const second = targetFor(state, puffs, "m1", day);
  assert.equal(first, second, "repeat reads of the same state and day must be identical");
});

test("a full dailyFacts pass gives the same table whether run once or twice over the same state", () => {
  const events = tapingYear();
  const state = replay(events);
  const to = addDays(BASE_DAY, 54 * 7 + 6);

  const first = dailyFacts(state, { me: "m1", to });
  const second = dailyFacts(state, { me: "m1", to });
  assert.deepEqual(second, first, "dailyFacts must be a pure function of (state, args)");
});

// ---------------------------------------------------------------------------
// Timing at real scale — cheap enough to assert on every run, generous enough not to flake CI.
// ---------------------------------------------------------------------------

/** ~2 years, 5 members, 6 habits — comfortably past "friend-group scale". */
function bigLog() {
  const members = ["m1", "m2", "m3", "m4", "m5"];
  const habits = [
    { id: "steps", name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, aggregate: AGGREGATE.LAST },
    { id: "sleep", name: "Sleep", metric: METRIC.SLEEP, direction: AT_LEAST, target: 420, aggregate: AGGREGATE.LAST },
    { id: "puffs", name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, aggregate: AGGREGATE.SUM, taper: { percent: 10, everyDays: 7, floor: 0 } },
    { id: "water", name: "Water", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 8, aggregate: AGGREGATE.SUM },
    { id: "reading", name: "Reading", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 1, aggregate: AGGREGATE.SUM },
    { id: "meditate", name: "Meditate", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 1, aggregate: AGGREGATE.SUM },
  ];
  const days = 730;
  const events = [];
  for (const m of members) events.push(E(ev.member(m, m), at(BASE_DAY, 7)));
  for (const h of habits) {
    events.push(E(ev.habit(h.id, {
      name: h.name, metric: h.metric, direction: h.direction, target: h.target,
      aggregate: h.aggregate, taper: h.taper, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
      period: PERIOD.DAY,
    }), at(BASE_DAY, 7)));
    for (const m of members) events.push(E(ev.goal(m, h.id, { target: h.target }), at(BASE_DAY, 8)));
  }
  // A realistic mix: about five sixths of days logged, so misses/holds/taper walks all actually
  // run rather than the whole log being one uninterrupted clean streak.
  for (let n = 0; n < days; n += 1) {
    const day = addDays(BASE_DAY, n);
    for (const m of members) {
      for (const h of habits) {
        if ((n + m.length + h.id.length) % 6 === 0) continue; // ~1 in 6 days skipped, per habit
        const value = h.direction === AT_MOST ? (n % 11) : (h.aggregate === AGGREGATE.SUM ? 1 : h.target);
        events.push(E(ev.log(h.id, m, day, value, SOURCE.MANUAL), at(day)));
      }
    }
  }
  return { events, members, habits, days };
}

test("replay + leaderboard + dailyFacts over ~2 years × 5 members × 6 habits completes quickly and repeatably", () => {
  const { events, members, days } = bigLog();

  const t0 = Date.now();
  const state = replay(events);
  const to = addDays(BASE_DAY, days - 1);
  const board = leaderboard(state, members, BASE_DAY, to, to);
  const facts = members.map((m) => dailyFacts(state, { me: m, to }));
  const elapsed = Date.now() - t0;

  // Not a tight bound — CI runners vary — but a real algorithmic regression (an accidental O(n²)
  // walk, a memo that stopped memoizing) blows past this by an order of magnitude, which is the
  // point: this is a tripwire, not a benchmark.
  assert.ok(elapsed < 5000, `replay + leaderboard + dailyFacts took ${elapsed}ms for ${events.length} events — investigate before assuming it scales`);
  assert.equal(board.length, members.length);
  assert.ok(facts.every((f) => f.length > 0), "every member should have at least some daily facts");

  // Repeat-read determinism at this same real scale, not just the small fixture above.
  const board2 = leaderboard(state, members, BASE_DAY, to, to);
  assert.deepEqual(board2, board, "leaderboard must give the same board for the same state and range, run twice");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ perf: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ perf: " + passed + " tests passed");
