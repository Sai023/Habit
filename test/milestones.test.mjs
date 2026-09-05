// milestones.test.mjs — the four badges, and the boundaries nobody notices until they are wrong.
//
// A tier is a rank held while the streak is alive, so every one of these is a claim about a single
// number crossing a line. The failures are all quiet: a badge that appears a day early is a lie
// somebody screenshots, and one that appears a day late is a person watching a counter tick past
// the number they were working towards with nothing happening.

import assert from "node:assert/strict";
import {
  TIERS, MILESTONES, tierFor, nextTier, HABIT_TIERS, habitLevel, habitCrossed, LEVEL_KEY,
} from "../js/milestones.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------

test("four tiers, ascending, at the agreed numbers", () => {
  assert.deepEqual(MILESTONES, [7, 20, 50, 100]);
  assert.deepEqual(TIERS.map((t) => t.name), ["Bronze", "Silver", "Gold", "Diamond"]);
  // Ascending matters: tierFor takes the last match, so an out-of-order table would hand somebody
  // Bronze at a hundred days.
  for (let i = 1; i < TIERS.length; i += 1) {
    assert.ok(TIERS[i].at > TIERS[i - 1].at, TIERS[i].name + " must sit above " + TIERS[i - 1].name);
  }
});

test("the notice list and the badge list are the same list", () => {
  // Two lists would eventually disagree, and the disagreement is invisible: a notification saying
  // "30 days" with no badge to show for it, or a badge nobody was ever told they had earned.
  assert.deepEqual(MILESTONES, TIERS.map((t) => t.at));
});

// ---------------------------------------------------------------------------
// Which one is held
// ---------------------------------------------------------------------------

test("nothing below the first", () => {
  for (const n of [0, 1, 6]) assert.equal(tierFor(n), null, String(n));
});

test("earned on the day it is reached, not the day after", () => {
  assert.equal(tierFor(7).name, "Bronze");
  assert.equal(tierFor(20).name, "Silver");
  assert.equal(tierFor(50).name, "Gold");
  assert.equal(tierFor(100).name, "Diamond");
});

test("held until the next one, rather than dropping back", () => {
  // A streak of 60 is Gold all the way to a hundred. The alternative — nearest tier — would take
  // somebody's badge away for getting further, which is the opposite of the mechanism.
  assert.equal(tierFor(19).name, "Bronze");
  assert.equal(tierFor(49).name, "Silver");
  assert.equal(tierFor(99).name, "Gold");
  assert.equal(tierFor(365).name, "Diamond");
});

test("nonsense in, nothing out", () => {
  assert.equal(tierFor(null), null);
  assert.equal(tierFor(undefined), null);
  assert.equal(tierFor(0), null);
});

// ---------------------------------------------------------------------------
// What is next
// ---------------------------------------------------------------------------

test("the next one up, and how far", () => {
  assert.deepEqual(
    [0, 6, 7, 18, 49, 99].map((n) => {
      const r = nextTier(n);
      return r.tier.name + "@" + r.away;
    }),
    ["Bronze@7", "Bronze@1", "Silver@13", "Silver@2", "Gold@1", "Diamond@1"],
  );
});

test("the top tier has nothing after it", () => {
  // The line that reads "1 day to X" has to know when to stop asking for one.
  assert.equal(nextTier(100), null);
  assert.equal(nextTier(400), null);
});

// ---------------------------------------------------------------------------
// Minor — one habit on its own
// ---------------------------------------------------------------------------

test("a single habit is held to a higher count than all of them together", () => {
  // Seven days of steps is a good week; seven days of EVERY category is what the majors are for.
  // If the minor thresholds matched, they would fire six times as often for a sixth of the
  // achievement and the majors would drown in them.
  for (const period of Object.keys(HABIT_TIERS)) {
    if (period !== "day") continue;
    assert.ok(HABIT_TIERS[period][0] > MILESTONES[0], "day tier 1 must sit above Bronze");
  }
});

test("each cadence is measured in its own rhythm", () => {
  // A streak counts PERIODS. Fifty looks sensible until it is applied to savings and means fifty
  // months — so a weekly habit's first badge is a month of weeks, and a monthly one's is a quarter.
  assert.deepEqual(HABIT_TIERS.day, [14, 30, 60, 120]);
  assert.deepEqual(HABIT_TIERS.week, [4, 12, 26, 52]);
  assert.deepEqual(HABIT_TIERS.month, [3, 6, 12, 24]);
  for (const steps of Object.values(HABIT_TIERS)) {
    for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i] > steps[i - 1]);
  }
});

test("the level climbs one threshold at a time", () => {
  assert.equal(habitLevel(13, "day"), 0);
  assert.equal(habitLevel(14, "day"), 1);
  assert.equal(habitLevel(59, "day"), 2);
  assert.equal(habitLevel(60, "day"), 3);
  assert.equal(habitLevel(500, "day"), 4);
  // And in the right rhythm for the cadence.
  assert.equal(habitLevel(4, "week"), 1);
  assert.equal(habitLevel(4, "day"), 0, "four DAYS is nothing; four WEEKS is a month");
  assert.equal(habitLevel(3, "month"), 1);
});

test("an unknown period is treated as daily rather than crashing", () => {
  // Periods arrive off the wire from other people's phones, and a build that has not heard of one
  // must degrade rather than take the card down.
  assert.equal(habitLevel(30, "fortnight"), 2);
  assert.equal(habitLevel(30), 2);
});

test("crossing is the exact number, so it fires on one day only", () => {
  assert.equal(habitCrossed(14, "day"), true);
  assert.equal(habitCrossed(15, "day"), false);
  assert.equal(habitCrossed(4, "week"), true);
  assert.equal(habitCrossed(4, "day"), false);
});

test("every level has a colour, and they are the majors' colours", () => {
  // One palette across both, so the two read as one system. The rank is carried by the SHAPE —
  // struck metal against a hollow ring — not by inventing a second set of colours.
  assert.equal(LEVEL_KEY.length, 5);
  assert.equal(LEVEL_KEY[0], "");
  assert.deepEqual(LEVEL_KEY.slice(1), TIERS.map((t) => t.key));
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ milestones: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ milestones: " + passed + " tests passed");
