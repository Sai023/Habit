// update.test.mjs — the three judgements that decide whether a new build actually arrives.
//
// The bug this came from was not a wrong answer anywhere. Every piece worked: the worker versioned
// itself off a content hash, the new generation downloaded, the old cache was dropped. What was
// missing was anybody telling the running page to start over, so a phone could sit on a build from
// days earlier while reporting itself perfectly healthy. There is no console on a phone and no
// symptom to search for — the app simply looks like the app.
//
// So the interesting cases here are all about NOT acting, because each of the three ways this can
// go wrong is silent and none of them is silent in the same way:
//
//   • reload too eagerly and it is a loop, which is an app that cannot be opened at all
//   • reload at the wrong moment and it eats a number somebody typed and had not saved
//   • check too eagerly and every foreground costs a network round trip

import assert from "node:assert/strict";
import { checkDue, holdsInput, reloadDue } from "../js/update.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const NOW = Date.parse("2026-09-05T12:00:00Z");

// ---------------------------------------------------------------------------
// Asking the network whether a new build exists
// ---------------------------------------------------------------------------

test("the first check is always due", () => {
  // Nothing has been asked yet, and the launch after a deploy is the whole point.
  assert.equal(checkDue(0, NOW), true);
});

test("a check a minute after the last one is due", () => {
  assert.equal(checkDue(NOW - MINUTE, NOW), true);
});

test("flipping in and out of the app does not check every time", () => {
  // Foreground fires on every app switch, and a habit tracker gets opened a lot. Without a floor
  // this is a request per glance.
  assert.equal(checkDue(NOW - SECOND, NOW), false);
  assert.equal(checkDue(NOW - 59 * SECOND, NOW), false);
});

// ---------------------------------------------------------------------------
// Whether now is a safe moment to pull the page out from under somebody
// ---------------------------------------------------------------------------

test("an open sheet holds the reload back", () => {
  // Every number in this app is typed into a sheet. Reloading over one loses it, and the person
  // would have no idea why — it would read as the app throwing their entry away.
  assert.equal(holdsInput(true, "DIV"), true);
});

test("a focused field holds it back too", () => {
  assert.equal(holdsInput(false, "INPUT"), true);
  assert.equal(holdsInput(false, "TEXTAREA"), true);
  assert.equal(holdsInput(false, "SELECT"), true);
});

test("an idle page is fair game", () => {
  assert.equal(holdsInput(false, "BODY"), false);
  assert.equal(holdsInput(false, "BUTTON"), false);
  assert.equal(holdsInput(false, null), false);
  assert.equal(holdsInput(false, undefined), false);
});

// ---------------------------------------------------------------------------
// The loop guard
// ---------------------------------------------------------------------------

test("the first automatic reload of a session is allowed", () => {
  assert.equal(reloadDue(0, NOW), true);
});

test("a second reload seconds after the first is refused", () => {
  // The failure this prevents has no recovery path from inside the app: a page that reloads on
  // every load never stays up long enough to be used or to be told to stop.
  assert.equal(reloadDue(NOW - SECOND, NOW), false);
  assert.equal(reloadDue(NOW - 29 * SECOND, NOW), false);
});

test("a later deploy in the same long-lived session still gets through", () => {
  // The WebView here is deliberately kept alive across app switches and can stay up for days, so
  // "one reload ever" would quietly stop delivering updates after the first one.
  assert.equal(reloadDue(NOW - 30 * SECOND, NOW), true);
  assert.equal(reloadDue(NOW - 3 * 24 * 60 * MINUTE, NOW), true);
});

test("a garbled stored timestamp does not wedge it shut", () => {
  // Read back off session storage, so it is a string that might be anything at all. Failing open
  // costs one extra reload; failing closed costs every future update.
  assert.equal(reloadDue(NaN, NOW), true);
  assert.equal(reloadDue(-1, NOW), true);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ update: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ update: " + passed + " tests passed");
