// bridge.test.mjs — the handshake, and the one line in it that fails silently.
//
// ---- Why this file exists ----
//
// The shell announces what it can do; this side reads that announcement and hides any control the
// shell could not honour. The reading is done by rebuilding the capability object WHOLE, field by
// named field — so a capability the shell sends that this side forgets to name is dropped on the
// floor and reads as false forever.
//
// That failure is invisible from both ends. The shell sees a well-formed announcement go out. The
// page sees a capability it believes is absent, and correctly hides the control — which looks
// exactly like an older shell that genuinely lacks the feature. Nothing errors, nothing warns, and
// the feature is simply never reachable. It happened with focusSettings: the shell advertised it,
// the page never read it, and the button that opens the screen-time limits could not have appeared
// on any device.
//
// So the test is not "does this field work". It is "is every field the shell sends readable at
// all", written so that adding one to the shell without adding it here fails here.

import assert from "node:assert/strict";
import { installBridge, caps } from "../js/bridge.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

/**
 * Every capability HabitBridge.kt puts into the onBridgeReady payload.
 *
 * Keep this in step with announceReady(). It is a hand-copied list because the two halves are
 * separate repositories that cannot import from each other — which is the whole reason the drift
 * this file catches is possible in the first place.
 */
const ANNOUNCED = ["version", "healthConnect", "alarms", "tile", "embedded", "focusSettings"];

function fakeShell() {
  const calls = [];
  globalThis.window = globalThis;
  globalThis.PauseNative = new Proxy({}, {
    get: (_, name) => (typeof name === "string" ? (json) => calls.push([name, json]) : undefined),
    has: () => true,
  });
  return calls;
}

function announce(payload) {
  fakeShell();
  installBridge({});
  // The shell reaches these through window.HabitBridge; installBridge is what puts them there.
  globalThis.HabitBridge.onBridgeReady(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------

// First, because the capability object is module state that an announcement replaces and nothing
// resets. This is the state a plain browser stays in for its whole life, and the only point in the
// file where "nothing has been announced yet" is still true.
test("before the shell says anything, every capability is false", () => {
  installBridge({});
  assert.equal(caps().native, false, "native");
  for (const k of ANNOUNCED) {
    if (k === "version") continue;
    assert.equal(caps()[k], false, k + " must start false, so a control is never drawn on a guess");
  }
  assert.equal(caps().version, 0);
});

test("every capability the shell announces is readable", () => {
  // All true, so a field that is simply not read shows up as false and names itself.
  const payload = { version: 1, setup: null };
  for (const k of ANNOUNCED) payload[k] = k === "version" ? 1 : true;

  announce(payload);
  const got = caps();

  const dropped = ANNOUNCED.filter((k) => !got[k]);
  assert.deepEqual(
    dropped, [],
    "announced by the shell but not read in onBridgeReady, so they can never be true: "
      + dropped.join(", "),
  );
});

test("a capability the shell omits is false, not undefined", () => {
  // Screens branch on these. `undefined` is falsy and would behave, but it also means "this build
  // has never heard of the feature", which is a different thing from "this shell cannot do it" the
  // moment anyone logs or reports one.
  announce({ version: 1 });
  const got = caps();
  for (const k of ANNOUNCED) {
    if (k === "version") continue;
    assert.equal(got[k], false, k + " should be false when the shell does not announce it");
  }
});

test("an announcement from an older shell does not throw", () => {
  // The page deploys the moment it is pushed; the APK is installed by hand whenever somebody gets
  // round to it. A payload missing half these fields is the normal state for days at a time.
  announce({ version: 1, embedded: true });
  assert.equal(caps().embedded, true);
  assert.equal(caps().focusSettings, false);
  assert.equal(caps().native, true);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ bridge: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ bridge: " + passed + " tests passed");
