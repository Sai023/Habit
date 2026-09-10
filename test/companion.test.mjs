// companion.test.mjs — one habit's number shown under another's.
//
// ---- What was asked ----
//
// "Under workouts would it be possible to pull calories burnt per a day from Health Connect if
// that data exists." Two habits answering the same question from opposite ends — how often you
// trained, and how hard — and a week of workouts reads very differently with the effort inside it.
//
// ---- The build that was not done ----
//
// The obvious one is a side-channel: have the shell read calories whether or not any habit asked
// for them, and park the number somewhere the workouts screen can reach. That is a second store,
// outside the log, holding data nothing replays — and every verdict in this app is derived from
// the log by replay, which is the whole reason three phones agree about anything.
//
// So this reads the log instead, and reads nothing that is not in it. Somebody tracking calories
// already has the numbers there, synced and scoped to them. Somebody who is not gets no line,
// which is exactly the "if that data exists" the request was careful to include.
//
// ---- The two properties worth pinning ----
//
// It spans DAYS, not periods, because the two habits do not share a cadence: workouts is weekly,
// calories is daily, and the point is a week of workouts against the calories burned inside it.
//
// And it answers null rather than zero when nothing reported. That distinction cost a release
// elsewhere on this screen — a watch that said nothing is not a day of burning nothing, and a
// "0 kcal" drawn over a quiet week is a number the app invented.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { companionTotal } from "../js/history.js";
import { ev, METRIC, AT_LEAST, AGGREGATE, SOURCE, PERIOD } from "../js/schema.js";

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
const E = (spec, ts) => ({ eventId: "c" + ++seq, ts, seq, ...spec });

const ME = "m1";
const OTHER = "m2";

/** A daily calories habit, plus whatever logs the test wants against it. */
function state(logs = []) {
  return replay([
    E(ev.meta({ tz: TZ }), at(0)),
    E(ev.member(ME, "Sam"), at(0)),
    E(ev.member(OTHER, "Anj"), at(0)),
    E(ev.habit("cals", {
      name: "Calories burned", metric: METRIC.ACTIVE_CALORIES, direction: AT_LEAST,
      target: 400, period: PERIOD.DAY, aggregate: AGGREGATE.LAST,
      source: SOURCE.HEALTH_CONNECT, days: [1, 2, 3, 4, 5, 6, 7], tz: TZ,
    }), at(0)),
    ...logs,
  ]);
}

const cals = (s) => s.habits.get("cals");
const burn = (n, v, who = ME) => E(ev.log("cals", who, day(n), v, "health_connect"), at(n));

// ---------------------------------------------------------------------------
// Adding up across a range
// ---------------------------------------------------------------------------

test("a week's worth is the sum of its days", () => {
  const s = state([burn(0, 300), burn(1, 500), burn(2, 250)]);
  assert.equal(companionTotal(s, cals(s), ME, day(0), day(2)), 1050);
});

test("the range is inclusive at both ends", () => {
  // Off by one here would silently drop the Monday of every week shown.
  const s = state([burn(0, 100), burn(1, 10), burn(2, 100)]);
  assert.equal(companionTotal(s, cals(s), ME, day(1), day(1)), 10, "a single day is its own range");
  assert.equal(companionTotal(s, cals(s), ME, day(0), day(2)), 210);
});

test("days outside the range are not counted", () => {
  const s = state([burn(0, 999), burn(1, 100), burn(2, 200), burn(3, 999)]);
  assert.equal(companionTotal(s, cals(s), ME, day(1), day(2)), 300);
});

test("only this member's numbers", () => {
  // The log holds the whole group. Summing across everybody would put the team's calories under
  // one person's workouts, which is both wrong and flattering.
  const s = state([burn(0, 100), burn(0, 5000, OTHER), burn(1, 200, OTHER)]);
  assert.equal(companionTotal(s, cals(s), ME, day(0), day(1)), 100);
});

// ---------------------------------------------------------------------------
// Silence is not zero
// ---------------------------------------------------------------------------

test("nothing reported at all is null, not zero", () => {
  const s = state();
  assert.equal(companionTotal(s, cals(s), ME, day(0), day(6)), null);
});

test("a partly quiet week totals what it has", () => {
  // Not an average and not a hole: three days reported, and their sum is the honest answer.
  const s = state([burn(1, 400), burn(4, 600)]);
  assert.equal(companionTotal(s, cals(s), ME, day(0), day(6)), 1000);
});

test("a logged zero counts, unlike a silent day", () => {
  // The same distinction the puff sheet had to learn. A day genuinely recorded as zero is data.
  const s = state([burn(2, 0)]);
  assert.equal(companionTotal(s, cals(s), ME, day(0), day(6)), 0);
});

// ---------------------------------------------------------------------------
// Nothing to show
// ---------------------------------------------------------------------------

test("no companion habit means no line", () => {
  // The whole of "if that data exists". Somebody not tracking calories gets nothing drawn, rather
  // than a zero or an empty panel.
  const s = state([burn(0, 300)]);
  assert.equal(companionTotal(s, null, ME, day(0), day(2)), null);
  assert.equal(companionTotal(s, undefined, ME, day(0), day(2)), null);
});

test("a backwards range is refused rather than walked", () => {
  const s = state([burn(0, 300), burn(1, 300)]);
  assert.equal(companionTotal(s, cals(s), ME, day(2), day(0)), null);
});

test("a missing end of the range is refused", () => {
  const s = state([burn(0, 300)]);
  assert.equal(companionTotal(s, cals(s), ME, day(0), null), null);
  assert.equal(companionTotal(s, cals(s), ME, null, day(0)), null);
});

// ---------------------------------------------------------------------------
// The shape the screen actually asks for
// ---------------------------------------------------------------------------

test("a month of daily calories under a monthly habit still adds up", () => {
  // Ranges longer than a week are the case the loop bound has to survive; a monthly workouts
  // habit asks for thirty-one days at a time.
  const logs = [];
  for (let i = 0; i < 31; i += 1) logs.push(burn(i, 100));
  const s = state(logs);
  assert.equal(companionTotal(s, cals(s), ME, day(0), day(30)), 3100);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ companion: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ companion: " + passed + " tests passed");
