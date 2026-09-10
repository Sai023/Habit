// pull.test.mjs — the arithmetic behind swiping down on Today to sync.
//
// The gesture layer is untestable here and does not need to be: listeners either fire or they do
// not, and a dead listener reports itself the first time somebody swipes. What fails silently is
// the curve — a trigger distance that is slightly wrong feels bad rather than broken, and comes
// back as "it does not really work", which is not a bug report anybody can act on.
//
// So the two properties that decide how it feels are pinned here: an ordinary flick to the top of
// a list must not fire it, and a deliberate pull must, within a thumb's reach.

import assert from "node:assert/strict";
import { pullDistance, armed, pullProgress, START_PX, TRIGGER_PX, MAX_PX } from "../js/pull.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

/** The smallest finger travel that arms it. Found rather than asserted, so the tests below read
 *  in the units somebody actually has: millimetres of thumb. */
function triggerAt() {
  for (let dy = 0; dy <= 600; dy += 1) if (armed(dy)) return dy;
  return Infinity;
}

// ---- Not firing by accident -----------------------------------------------

test("a drag up is not a pull", () => {
  assert.equal(pullDistance(-40), 0);
  assert.equal(armed(-40), false);
});

test("nothing moves inside the slack", () => {
  assert.equal(pullDistance(0), 0);
  assert.equal(pullDistance(START_PX), 0);
  assert.ok(pullDistance(START_PX + 1) > 0, "past the slack it starts to move");
});

test("an overshoot at the top of a list does not sync", () => {
  // The failure this whole curve exists to prevent. Flicking to the top of Today overshoots, and
  // an overshoot IS a drag down at scroll zero — the same gesture, meant differently. Twenty-odd
  // pixels of rubber-band must not push anything to the server.
  assert.equal(armed(25), false, "a 25px overshoot must not fire");
  assert.equal(armed(40), false, "nor a generous one");
});

// ---- Firing on purpose ----------------------------------------------------

test("a deliberate pull is within a thumb's reach", () => {
  const dy = triggerAt();
  // Not a magic number so much as a hand. Below about 60px the accidental cases above start to
  // reach it; past about 140px you are asking for a second grab of the screen, which is the point
  // at which people decide a gesture is not working and stop trying it.
  assert.ok(dy >= 60 && dy <= 140, "arms at " + dy + "px of finger travel");
});

test("past the trigger it stays armed however far you go", () => {
  const dy = triggerAt();
  for (const extra of [1, 50, 400]) {
    assert.equal(armed(dy + extra), true, "still armed " + extra + "px further on");
  }
});

// ---- The feel -------------------------------------------------------------

test("the indicator never runs away from the screen", () => {
  for (const dy of [200, 800, 5000]) {
    assert.ok(pullDistance(dy) <= MAX_PX, "capped at " + MAX_PX + " for dy=" + dy);
  }
});

test("it damps once the decision is made, so the pull visibly stops", () => {
  const dy = triggerAt();
  const before = pullDistance(dy) - pullDistance(dy - 20);
  const after = pullDistance(dy + 40) - pullDistance(dy + 20);
  assert.ok(after < before, "20px of finger moves the indicator less after the trigger than before");
});

test("distance only ever grows with the finger", () => {
  let last = -1;
  for (let dy = -10; dy <= 400; dy += 3) {
    const d = pullDistance(dy);
    assert.ok(d >= last, "went backwards at dy=" + dy);
    last = d;
  }
});

test("progress fills exactly at the trigger and stops there", () => {
  const dy = triggerAt();
  assert.equal(pullProgress(-5), 0);
  assert.ok(pullProgress(dy) >= 1 - 1e-9, "full at the trigger");
  assert.equal(pullProgress(dy + 200), 1, "and no more than full afterwards");
  assert.ok(pullProgress(dy / 2) < 1, "not full halfway");
});

test("the trigger is reachable before the cap, or it could never fire", () => {
  // Guards the constants against each other. TRIGGER_PX > MAX_PX would clamp the distance below
  // the threshold for every possible finger travel, and the gesture would be dead with every
  // individual number in this file still looking sensible.
  assert.ok(TRIGGER_PX < MAX_PX, "TRIGGER_PX must be inside the range distance can reach");
  assert.notEqual(triggerAt(), Infinity, "no finger travel arms it");
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ pull: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ pull: " + passed + " tests passed");
