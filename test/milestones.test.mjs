// milestones.test.mjs — the four badges, and the boundaries nobody notices until they are wrong.
//
// A tier is a rank held while the streak is alive, so every one of these is a claim about a single
// number crossing a line. The failures are all quiet: a badge that appears a day early is a lie
// somebody screenshots, and one that appears a day late is a person watching a counter tick past
// the number they were working towards with nothing happening.

import assert from "node:assert/strict";
import { TIERS, MILESTONES, tierFor, nextTier } from "../js/milestones.js";

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

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ milestones: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ milestones: " + passed + " tests passed");
