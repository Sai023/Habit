// worstday.test.mjs — what a week looks like without its lowest day.
//
// ---- Where this came from ----
//
// "Why isn't every day worth 100 points, so one bad day of non-tracking hurts less?"
//
// The arithmetic answer is that it would change nothing: a sum and an average are the same number.
// Six hundreds and a zero is 600 out of 700 and it is 85.7%, and calling the axis "points" does
// not dilute the zero. They only disagree when two people have different numbers of judged days,
// and then the sum is the unfair one — it ranks somebody who played seven days above somebody who
// was perfect on the four they were asked about.
//
// But the question underneath was real. One bad day costs a seventh of the week, and if that is
// too much the fix is not a different unit, it is not counting the day. This is that rule,
// computed but not applied, so the group can look at what it would do to a week they actually
// played before deciding whether they want it.
//
// ---- Why it takes the daily scores rather than the week ----
//
// Because the week's own percentage cannot answer it. 85% is seven days at 85, where dropping the
// worst changes nothing, or six at a hundred and one at zero, where it changes everything. The
// shape is the whole answer and the average is exactly what throws it away.

import assert from "node:assert/strict";
import { withoutWorstDay } from "../js/score.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

/** A week, as scoreOver hands it over: one entry per day that was actually judged. */
const week = (...pcts) => pcts.map((pct, i) => ({ day: "2026-03-0" + (i + 2), pct }));

// ---------------------------------------------------------------------------
// The shape is the answer
// ---------------------------------------------------------------------------

test("a flat week is unchanged by dropping its worst day", () => {
  // Seven days at 85. There is nothing to rescue, and a rule that claims otherwise is selling
  // something.
  const w = withoutWorstDay(week(85, 85, 85, 85, 85, 85, 85));
  assert.equal(w.pct, 85);
});

test("one catastrophic day is most of what the rule is for", () => {
  // Six perfect days and a zero: 86% becomes 100%. Same weekly average as the test above, opposite
  // outcome — which is exactly why this cannot be answered without the days.
  const w = withoutWorstDay(week(100, 100, 100, 0, 100, 100, 100));
  assert.equal(Math.round((600 / 7)), 86, "the week as it stands");
  assert.equal(w.pct, 100);
  assert.equal(w.dropped.pct, 0);
});

test("it drops the lowest day, not the last bad one", () => {
  const w = withoutWorstDay(week(90, 40, 90, 70, 90));
  assert.equal(w.dropped.pct, 40);
  assert.equal(w.pct, Math.round((90 + 90 + 70 + 90) / 4));
});

test("the dropped day is named, so the reader can check it", () => {
  const w = withoutWorstDay(week(90, 12, 90));
  assert.equal(w.dropped.day, "2026-03-03");
  assert.equal(w.dropped.pct, 12);
});

test("ties drop only one day", () => {
  // Two equally bad days: one goes, one stays. Dropping both would be a different rule and a much
  // more generous one.
  const w = withoutWorstDay(week(100, 0, 0, 100));
  assert.equal(w.days, 3);
  assert.equal(w.pct, Math.round((100 + 0 + 100) / 3));
});

// ---------------------------------------------------------------------------
// It never improves a week by removing the only thing in it
// ---------------------------------------------------------------------------

test("a one-day week has no worst day", () => {
  // Dropping the only day that counted leaves nothing to average, and "100%" off the back of no
  // days at all is the kind of number that ends an argument badly.
  assert.equal(withoutWorstDay(week(40)), null);
});

test("no days at all is null, not zero", () => {
  assert.equal(withoutWorstDay([]), null);
  assert.equal(withoutWorstDay(null), null);
  assert.equal(withoutWorstDay(undefined), null);
});

test("a perfect week stays perfect rather than going over", () => {
  const w = withoutWorstDay(week(100, 100, 100));
  assert.equal(w.pct, 100);
});

// ---------------------------------------------------------------------------
// The property that makes it a fair rule
// ---------------------------------------------------------------------------

test("it can never lower a week", () => {
  // Removing the minimum cannot pull a mean down. Worth pinning, because the whole proposition is
  // "this makes a bad week kinder" and a rule that occasionally did the opposite would be a
  // betrayal rather than a bug.
  const cases = [
    week(100, 0, 50, 75, 90),
    week(10, 10, 10),
    week(0, 0, 100),
    week(33, 66, 99, 12, 87, 54),
  ];
  for (const days of cases) {
    const before = days.reduce((a, d) => a + d.pct, 0) / days.length;
    const after = withoutWorstDay(days).pct;
    assert.ok(after >= Math.round(before) - 1,
      "went down: " + Math.round(before) + " -> " + after);
  }
});

test("it leaves the original untouched", () => {
  // The board renders from the same array immediately afterwards. A rule that answered a question
  // by quietly editing the week would be the worst possible way to lose a day.
  const days = week(100, 0, 100);
  const copy = days.map((d) => ({ ...d }));
  withoutWorstDay(days);
  assert.deepEqual(days, copy);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ worst day: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ worst day: " + passed + " tests passed");
