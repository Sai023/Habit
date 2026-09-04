// habits.test.mjs — the design rules, as executable specification.
//
// Run with `npm test`. No dependencies and no test runner: the engine is pure, so node built-ins
// are enough, and keeping it that way means CI needs no install step.
//
// Every case here is a decision that was argued for during the architecture review. If one of
// these fails, a rule changed — go and change the rule on purpose.

import assert from "node:assert/strict";
import {
  replay, walk, streak, dayKey, addDays, daysBetween, isoDayOfWeek, rawDayStatus, valueOn, targetOn, publicValue, HIT, MISS, NO_DATA, EXEMPT,
} from "../js/habits.js";
import { leaderboard } from "../js/score.js";
import { ev, T, SOURCE, VISIBILITY, AT_MOST, AT_LEAST, AGGREGATE, METRIC } from "../js/schema.js";

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TZ = "Africa/Johannesburg"; // UTC+2 all year — South Africa has no DST
let _seq = 0;

/** Epoch ms for a local wall-clock time in TZ. */
function at(day, hour = 12, minute = 0) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - 2, minute);
}

/** Wrap a schema event builder into a full log row. */
function E(spec, ts) {
  _seq += 1;
  return { eventId: "e" + String(_seq).padStart(4, "0"), ts, seq: _seq, ...spec };
}

const D0 = "2026-03-02"; // a Monday
const day = (n) => addDays(D0, n);

/** A habit definition event plus whatever logs the caller wants. */
function group({ habit, logs = [], extra = [] }) {
  const events = [
    E(ev.member("m1", "Alice"), at(D0, 6)),
    E(ev.habit("h1", { tz: TZ, dayStartHour: 4, ...habit }), at(D0, 6)),
    ...logs,
    ...extra,
  ];
  return replay(events);
}

const manualHabit = { name: "Read", direction: AT_LEAST, target: 1, source: SOURCE.MANUAL };
// The metric is not decoration. A binding to Health Connect is only believed for a metric Health
// Connect can actually read, so a habit called "Steps" that never says it measures steps is not a
// watch-fed habit — it is the leftover this fixture used to accidentally describe.
const autoHabit = {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
  source: SOURCE.HEALTH_CONNECT,
};

const log = (n, value, opts = {}) =>
  E(ev.log("h1", opts.member || "m1", day(n), value, opts.source || SOURCE.MANUAL, opts.externalId || null),
    at(day(opts.authoredOn == null ? n : opts.authoredOn), opts.hour == null ? 20 : opts.hour));

// ===========================================================================
// Calendar
// ===========================================================================

test("dayKey: 23:30 local stays on the local day, not UTC's tomorrow", () => {
  // 23:30 SAST on 2 March is 21:30 UTC the same day, but 00:30 UTC would flip a naive UTC key.
  assert.equal(dayKey(at("2026-03-02", 23, 30), TZ, 0), "2026-03-02");
  assert.equal(dayKey(Date.UTC(2026, 2, 2, 23, 30), TZ, 0), "2026-03-03"); // 01:30 SAST next day
});

test("dayKey: a 01:00 log belongs to yesterday when the day starts at 04:00", () => {
  assert.equal(dayKey(at("2026-03-03", 1, 0), TZ, 4), "2026-03-02");
  assert.equal(dayKey(at("2026-03-03", 4, 0), TZ, 4), "2026-03-03");
  assert.equal(dayKey(at("2026-03-03", 3, 59), TZ, 4), "2026-03-02");
});

test("dayKey: the pinned timezone means travel does not move the boundary", () => {
  // Same instant, logged from Bangkok. The habit's tz is what decides the day, not the device's.
  const instant = at("2026-03-02", 22, 0); // 22:00 SAST == 03:00 next day in Bangkok
  assert.equal(dayKey(instant, TZ, 4), "2026-03-02");
  assert.equal(dayKey(instant, "Asia/Bangkok", 4), "2026-03-02"); // still the same habit-day
});

test("calendar arithmetic crosses month and year boundaries", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01"); // 2026 is not a leap year
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(daysBetween("2026-02-25", "2026-03-04"), 7);
  assert.equal(daysBetween("2026-03-04", "2026-02-25"), -7);
  assert.equal(isoDayOfWeek("2026-03-02"), 1); // Monday
  assert.equal(isoDayOfWeek("2026-03-08"), 7); // Sunday
});

// ===========================================================================
// A single day's status
// ===========================================================================

test("at_least: value meets target is a HIT, below is a MISS", () => {
  const s = group({ habit: autoHabit, logs: [log(0, 10000), log(1, 9999)] });
  const h = s.habits.get("h1");
  assert.equal(rawDayStatus(s, h, "m1", day(0)), HIT);
  assert.equal(rawDayStatus(s, h, "m1", day(1)), MISS);
});

test("at_most: staying under the ceiling is a HIT — the direction really inverts", () => {
  const s = group({
    habit: { ...manualHabit, direction: AT_MOST, target: 8, aggregate: AGGREGATE.SUM },
    logs: [log(0, 6), log(1, 9)],
  });
  const h = s.habits.get("h1");
  assert.equal(rawDayStatus(s, h, "m1", day(0)), HIT);
  assert.equal(rawDayStatus(s, h, "m1", day(1)), MISS);
});

test("a silent AUTOMATIC source is NO_DATA; a silent MANUAL habit is a real MISS", () => {
  const auto = group({ habit: autoHabit, logs: [] });
  const manual = group({ habit: manualHabit, logs: [] });
  assert.equal(rawDayStatus(auto, auto.habits.get("h1"), "m1", day(1)), NO_DATA);
  assert.equal(rawDayStatus(manual, manual.habits.get("h1"), "m1", day(1)), MISS);
});

test("a day outside the habit's active weekdays is EXEMPT, not a miss", () => {
  const s = group({ habit: { ...manualHabit, days: [1, 3, 5] } }); // Mon/Wed/Fri
  const h = s.habits.get("h1");
  assert.equal(rawDayStatus(s, h, "m1", day(1)), EXEMPT); // Tuesday
  assert.equal(rawDayStatus(s, h, "m1", day(2)), MISS);   // Wednesday, nothing logged
});

test("Travel Mode exempts a range outright rather than draining grace tokens", () => {
  const s = group({
    habit: manualHabit,
    extra: [E(ev.exempt("m1", day(3), day(5), "travel"), at(day(2), 9))],
  });
  const h = s.habits.get("h1");
  assert.equal(rawDayStatus(s, h, "m1", day(3)), EXEMPT);
  assert.equal(rawDayStatus(s, h, "m1", day(5)), EXEMPT);
  assert.equal(rawDayStatus(s, h, "m1", day(6)), MISS);
});

// ===========================================================================
// Combining readings
// ===========================================================================

test("aggregate LAST does not multiply a re-reported running total", () => {
  // Health Connect reports the day's TOTAL each time it syncs. Summing would treble this.
  const s = group({ habit: autoHabit, logs: [log(0, 4000), log(0, 9000), log(0, 12000)] });
  assert.equal(valueOn(s, s.habits.get("h1"), "m1", day(0)), 12000);
});

test("aggregate SUM adds discrete events and de-duplicates on externalId", () => {
  const s = group({
    habit: { ...manualHabit, aggregate: AGGREGATE.SUM, target: 3 },
    logs: [
      log(0, 1, { externalId: "a" }),
      log(0, 1, { externalId: "a" }), // the same activity re-delivered — must not double count
      log(0, 1, { externalId: "b" }),
      log(0, 1),                       // no id: a plain tap, always counted
    ],
  });
  assert.equal(valueOn(s, s.habits.get("h1"), "m1", day(0)), 3);
});

test("two sources describing one day take the MAX, never the sum", () => {
  const s = group({
    habit: autoHabit,
    logs: [log(0, 8000, { source: SOURCE.HEALTH_CONNECT }), log(0, 12000, { source: SOURCE.STRAVA })],
  });
  assert.equal(valueOn(s, s.habits.get("h1"), "m1", day(0)), 12000);
});

test("a number somebody typed in beats the watch, even when it is lower", () => {
  // Max is right between two sensors and wrong against a person. Correcting a watch that
  // over-counted would otherwise be discarded for being the smaller number, which makes the
  // correction button look broken while quietly keeping the wrong figure.
  const s = group({
    habit: autoHabit,
    logs: [
      log(0, 12000, { source: SOURCE.HEALTH_CONNECT }),
      log(0, 8000, { source: SOURCE.MANUAL }),
    ],
  });
  assert.equal(valueOn(s, s.habits.get("h1"), "m1", day(0)), 8000);
  assert.equal(rawDayStatus(s, s.habits.get("h1"), "m1", day(0)), MISS, "and the verdict follows it");
});

test("a manual entry can also correct a day upwards when the watch was asleep", () => {
  const s = group({
    habit: autoHabit,
    logs: [
      log(0, 2000, { source: SOURCE.HEALTH_CONNECT }),
      log(0, 11000, { source: SOURCE.MANUAL }),
    ],
  });
  assert.equal(valueOn(s, s.habits.get("h1"), "m1", day(0)), 11000);
});

test("correcting twice keeps the later correction", () => {
  const s = group({
    habit: autoHabit,
    logs: [log(0, 8000, { source: SOURCE.MANUAL }), log(0, 9500, { source: SOURCE.MANUAL })],
  });
  assert.equal(valueOn(s, s.habits.get("h1"), "m1", day(0)), 9500);
});

test("sensors still take the max between themselves", () => {
  const s = group({
    habit: autoHabit,
    logs: [
      log(0, 8000, { source: SOURCE.HEALTH_CONNECT }),
      log(0, 12000, { source: SOURCE.STRAVA }),
    ],
  });
  assert.equal(valueOn(s, s.habits.get("h1"), "m1", day(0)), 12000);
});

test("taper steps the ceiling down each week and never past the floor", () => {
  const s = group({
    habit: { ...manualHabit, direction: AT_MOST, target: 20, taper: { amount: 1, everyDays: 7, floor: 0 } },
  });
  const h = s.habits.get("h1");
  assert.equal(targetOn(h, day(0)), 20);
  assert.equal(targetOn(h, day(6)), 20);
  assert.equal(targetOn(h, day(7)), 19);
  assert.equal(targetOn(h, day(70)), 10);
  assert.equal(targetOn(h, day(300)), 0); // floor holds
});

// ===========================================================================
// Streaks and grace
// ===========================================================================

test("a banked grace token auto-spends on a miss and the streak survives", () => {
  const logs = [0, 1, 2, 3, 4, 5, 6].map((n) => log(n, 1)); // seven clean days earns one token
  const s = group({ habit: manualHabit, logs });
  const w = walk(s, "h1", "m1", day(8)); // through = day 7, which has no log
  assert.deepEqual(w.spent, [day(7)]);
  assert.equal(w.statuses.get(day(7)), EXEMPT);
  assert.equal(w.tokens, 0);
  assert.equal(w.streak, 8);
});

test("a miss with nothing banked resets the streak", () => {
  const s = group({
    habit: { ...manualHabit, grace: { earnEvery: 0, cap: 0 } }, // grace disabled
    logs: [log(0, 1), log(1, 1), log(2, 1), log(4, 1)],         // day 3 missed
  });
  const w = walk(s, "h1", "m1", day(5));
  assert.equal(w.statuses.get(day(3)), MISS);
  assert.equal(w.streak, 1); // only day 4 survives
});

test("tokens are capped, so you cannot bank a year of forgiveness", () => {
  const logs = [];
  for (let n = 0; n < 28; n += 1) logs.push(log(n, 1)); // four clean weeks = four earned
  const s = group({ habit: manualHabit, logs });
  const w = walk(s, "h1", "m1", day(28)); // through day 27, so nothing has been spent yet
  assert.equal(w.tokens, 2, "four weeks earns four, but the bank holds two");
  assert.deepEqual(w.spent, []);
  assert.equal(w.streak, 28);
});

test("NO_DATA preserves the streak without advancing it", () => {
  const s = group({ habit: autoHabit, logs: [log(0, 12000), log(1, 12000), log(3, 12000)] });
  const w = walk(s, "h1", "m1", day(4));
  assert.equal(w.statuses.get(day(2)), NO_DATA);
  assert.equal(w.streak, 3);   // three hits counted
  assert.equal(w.tokens, 0);   // the gap earned nothing
  assert.deepEqual(w.spent, []); // and cost nothing
});

test("today is not judged a miss while it is still running", () => {
  const s = group({ habit: manualHabit, logs: [log(0, 1), log(1, 1), log(2, 1)] });
  const w = walk(s, "h1", "m1", day(3)); // nothing logged today yet
  assert.equal(w.todayStatus, MISS);
  assert.equal(w.streak, 3, "a streak must survive the morning, not reset at 00:01");
});

test("today counts the moment it is won", () => {
  const s = group({ habit: manualHabit, logs: [log(0, 1), log(1, 1), log(2, 1), log(3, 1)] });
  assert.equal(streak(s, "h1", "m1", day(3)), 4);
});

// ===========================================================================
// Log integrity
// ===========================================================================

test("a log authored long after the fact is rejected, so history cannot be rewritten", () => {
  const s = group({
    habit: manualHabit,
    logs: [
      log(0, 1, { authoredOn: 2 }), // two days late — allowed (an offline backfill)
      log(1, 1, { authoredOn: 6 }), // five days late — rejected
    ],
  });
  const h = s.habits.get("h1");
  assert.equal(rawDayStatus(s, h, "m1", day(0)), HIT);
  assert.equal(rawDayStatus(s, h, "m1", day(1)), MISS);
});

test("shuffled arrival order derives identical state — the whole reason this is not a trigger", () => {
  const events = [
    E(ev.member("m1", "Alice"), at(D0, 6)),
    E(ev.habit("h1", { tz: TZ, dayStartHour: 4, ...manualHabit }), at(D0, 6)),
    ...[0, 1, 2, 3, 4, 5, 6].map((n) => log(n, 1)),
  ];
  const inOrder = walk(replay(events), "h1", "m1", day(8));

  // Deterministic shuffle: reverse, then interleave from both ends.
  const shuffled = [];
  for (let i = 0, j = events.length - 1; i <= j; i += 1, j -= 1) {
    shuffled.push(events[j]);
    if (i !== j) shuffled.push(events[i]);
  }
  const outOfOrder = walk(replay(shuffled), "h1", "m1", day(8));

  assert.equal(outOfOrder.streak, inOrder.streak);
  assert.deepEqual(outOfOrder.spent, inOrder.spent);
  assert.deepEqual([...outOfOrder.statuses.entries()], [...inOrder.statuses.entries()]);
});

test("an unknown event type is ignored, not fatal — old APKs must degrade quietly", () => {
  const events = [
    E(ev.member("m1", "Alice"), at(D0, 6)),
    E(ev.habit("h1", { tz: TZ, dayStartHour: 4, ...manualHabit }), at(D0, 6)),
    E({ type: "habit_something_from_2027", payload: { v: 1, wat: true } }, at(D0, 7)),
    E({ type: T.LOG, payload: { v: 99, habitId: "h1", memberId: "m1", day: day(0), value: 1 } }, at(day(0), 20)),
    log(0, 1),
  ];
  const s = replay(events);
  assert.equal(s.habits.size, 1);
  assert.equal(valueOn(s, s.habits.get("h1"), "m1", day(0)), 1); // the v:99 row was skipped
});

// ===========================================================================
// Leaderboard
// ===========================================================================

function threeMembers({ carolSource = SOURCE.MANUAL, carolLogs = [0, 1, 2] } = {}) {
  const events = [
    E(ev.member("m1", "Alice"), at(D0, 6)),
    E(ev.member("m2", "Bob"), at(D0, 6)),
    E(ev.member("m3", "Carol"), at(D0, 6)),
    // A watch-fed habit has to be one a watch can read, or the engine rightly disbelieves the
    // binding. The target stays at 1 so the arithmetic below is still about days rather than steps.
    E(ev.habit("h1", {
      tz: TZ, dayStartHour: 4, ...manualHabit, source: carolSource, scored: true,
      ...(carolSource === SOURCE.HEALTH_CONNECT ? { metric: METRIC.STEPS } : {}),
    }), at(D0, 6)),
  ];
  for (let n = 0; n <= 6; n += 1) {
    events.push(log(n, 1, { member: "m1" }));                    // Alice: 7/7
    if (n < 5) events.push(log(n, 1, { member: "m2" }));         // Bob:   5/7
  }
  for (const n of carolLogs) events.push(log(n, 1, { member: "m3" }));
  return replay(events);
}

test("crown goes to the top completion, clown to the bottom", () => {
  const s = threeMembers();
  const rows = leaderboard(s, ["m1", "m2", "m3"], day(0), day(6), day(6));
  assert.deepEqual(rows.map((r) => r.name), ["Alice", "Bob", "Carol"]);
  assert.equal(rows[0].pct, 100);
  assert.equal(rows[0].crown, true);
  assert.equal(rows[2].clown, true);
});

test("a silent pipeline suppresses the clown entirely — it is never promoted upward", () => {
  // Carol's habit is automatic and she logged only 2 of 7 days, so 5 days are NO_DATA rather
  // than misses. She must not be clowned for a broken watch — and neither must Bob, who did
  // better than her.
  const s = threeMembers({ carolSource: SOURCE.HEALTH_CONNECT, carolLogs: [0, 1] });
  const rows = leaderboard(s, ["m1", "m2", "m3"], day(0), day(6), day(6));
  const carol = rows.find((r) => r.name === "Carol");
  const bob = rows.find((r) => r.name === "Bob");

  assert.ok(carol.noData > 0, "Carol should have NO_DATA days");
  assert.equal(carol.clown, false);
  assert.equal(carol.clownSuppressed, true, "the UI needs to explain why, and offer the fix");
  assert.equal(bob.clown, false, "the tag must not be promoted to someone who did better");
  assert.equal(rows.filter((r) => r.clown).length, 0);
});

test("EXEMPT and NO_DATA days leave the denominator", () => {
  const s = threeMembers({ carolSource: SOURCE.HEALTH_CONNECT, carolLogs: [0, 1] });
  const carol = leaderboard(s, ["m1", "m2", "m3"], day(0), day(6), day(6))
    .find((r) => r.name === "Carol");
  assert.equal(carol.eligible, 2, "only the two days we could actually measure");
  assert.equal(carol.pct, 100, "she hit both days she was measured on");
});

test("a tie on percentage breaks on days completed, not on name", () => {
  // Both perfect, but one of them showed up on more days. Percentage alone would crown whoever
  // had the fewest days measured — a week that was mostly rest days should not beat a full one.
  const events = [
    E(ev.member("m1", "Zoe"), at(D0, 6)),
    E(ev.member("m2", "Adam"), at(D0, 6)),
    E(ev.habit("h1", { tz: TZ, dayStartHour: 4, ...manualHabit, scored: true }), at(D0, 6)),
  ];
  for (let n = 0; n <= 6; n += 1) events.push(log(n, 1, { member: "m1" })); // Zoe: 7/7
  for (let n = 0; n <= 2; n += 1) events.push(log(n, 1, { member: "m2" })); // Adam: 3/3, rest exempt
  events.push(E(ev.exempt("m2", day(3), day(6), "travel"), at(day(2), 9)));

  const rows = leaderboard(replay(events), ["m1", "m2"], day(0), day(6), day(6));
  assert.equal(rows[0].pct, 100);
  assert.equal(rows[1].pct, 100);
  assert.equal(rows[0].name, "Zoe", "seven days beats three, alphabet notwithstanding");
  assert.equal(rows[0].crown, true);
});

test("everything counts unless somebody switches it off", () => {
  // Reduce habits used to opt OUT by default, on the reasoning that being bottom of a quitting
  // metric produces hidden logs rather than quitting. That held when the board was one pooled
  // ratio and the only thing a habit could do was drag you down it.
  //
  // Categories changed the shape of the argument: Discipline is thirty per cent of the day and it
  // is MADE of reduce habits, so defaulting them off did not protect anybody — it deleted the
  // category, and a phone tracking steps, sleep and a vape was scored on two of the three without
  // being told which.
  const reduce = group({ habit: { ...manualHabit, direction: AT_MOST, target: 8 } });
  assert.equal(reduce.habits.get("h1").scored, true);

  // And the switch is still there for a habit somebody genuinely wants kept off the board.
  const optedOut = group({ habit: { ...manualHabit, direction: AT_MOST, target: 8, scored: false } });
  assert.equal(optedOut.habits.get("h1").scored, false);
});

// ===========================================================================
// Visibility
// ===========================================================================

test("visibility controls what the group sees of a number", () => {
  const base = { direction: AT_LEAST, target: 10000 };
  assert.deepEqual(publicValue({ ...base, visibility: VISIBILITY.FULL }, 8000), { value: 8000 });
  assert.deepEqual(publicValue({ ...base, visibility: VISIBILITY.PROGRESS }, 8000), { pct: 80 });
  assert.equal(publicValue({ ...base, visibility: VISIBILITY.PRIVATE }, 8000), null);

  // A reduce habit reports progress as "how far under the ceiling", never the raw count.
  const reduce = { direction: AT_MOST, target: 20, visibility: VISIBILITY.PROGRESS };
  assert.deepEqual(publicValue(reduce, 5), { pct: 75 });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ habits engine: " + passed + " tests passed");
