// identity.test.mjs — whose phone is this, when two halves of the app disagree.
//
// ---- What went wrong ----
//
// A second phone joined the group by pasting the FIRST phone's setup code, which is exactly what
// a setup code does: it says "this phone is me". So the WebView's database recorded the first
// person's member id.
//
// Then it was put right — leave the group, rejoin with an invite — and it was not put right at
// all. HabitPrefs.clear() wipes the SHELL's store; a WebView keeps its identity in IndexedDB,
// which is separate storage and survived. The shell knew it was Anj. The page inside it still
// believed it was Sahil, refused the handover because it already held a group code, and went on
// showing his day while writing her entries to his row.
//
// Two things had to change, and this file is the one that can be tested without a browser: the
// handover decision itself. The other half — the shell wiping WebStorage when you leave — lives
// in the Kotlin.
//
// The edge on the other side is real too, which is why this is a three-way decision rather than a
// boolean: moving a device to a DIFFERENT room without asking is worse than any of the above.

import assert from "node:assert/strict";
import { identityAction } from "../js/store.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const ROOM = "HABIT-43M9UU";
const OTHER = "HABIT-7Q2XK9";
const SAHIL = "member-sahil";
const ANJ = "member-anj";

// ---------------------------------------------------------------------------
// A fresh WebView
// ---------------------------------------------------------------------------

test("a context that has never joined anything takes the whole identity", () => {
  // The ordinary case, and the reason the handover exists: a WebView starts empty, so without it
  // the page runs onboarding again and mints a SECOND id for somebody the shell has been posting
  // as for days.
  assert.equal(
    identityAction({ code: ROOM, memberId: ANJ }, { code: null, memberId: null }),
    "adopt",
  );
});

// ---------------------------------------------------------------------------
// The phone that had been somebody else
// ---------------------------------------------------------------------------

test("same room, different person: the shell wins", () => {
  // The failure this file is named for. The shell has just completed a join; this context is only
  // repeating what it was told last time.
  assert.equal(
    identityAction({ code: ROOM, memberId: ANJ }, { code: ROOM, memberId: SAHIL }),
    "rebind",
  );
});

test("rebinding changes WHO, never WHICH ROOM", () => {
  // Worth stating as its own case: "rebind" must never be reachable for a different room, or the
  // fix for one problem becomes the other one.
  for (const stored of [{ code: OTHER, memberId: SAHIL }, { code: OTHER, memberId: ANJ }]) {
    assert.equal(identityAction({ code: ROOM, memberId: ANJ }, stored), "ignore");
  }
});

// ---------------------------------------------------------------------------
// The edge on the other side
// ---------------------------------------------------------------------------

test("a device already in another group is never silently moved", () => {
  // Somebody testing standalone, or an older build. Repointing them without asking is worse than
  // showing onboarding once, which is what refusing leaves them with.
  assert.equal(
    identityAction({ code: ROOM, memberId: ANJ }, { code: OTHER, memberId: ANJ }),
    "ignore",
  );
});

test("being told what we already are is not a change", () => {
  // announceReady fires on every page load and again whenever the page asks. This must be free.
  assert.equal(
    identityAction({ code: ROOM, memberId: ANJ }, { code: ROOM, memberId: ANJ }),
    "ignore",
  );
});

test("an incomplete handover is ignored rather than half-applied", () => {
  const stored = { code: null, memberId: null };
  assert.equal(identityAction({ code: ROOM, memberId: "" }, stored), "ignore");
  assert.equal(identityAction({ code: "", memberId: ANJ }, stored), "ignore");
  assert.equal(identityAction({}, stored), "ignore");
  assert.equal(identityAction(undefined, stored), "ignore");
  assert.equal(identityAction(null, null), "ignore");
});

test("a stored room with no member id is still a room, and still adopted into", () => {
  // Half-written state from an interrupted setup. Same room, so the member id is simply supplied.
  assert.equal(
    identityAction({ code: ROOM, memberId: ANJ }, { code: ROOM, memberId: null }),
    "rebind",
  );
});

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ identity: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ identity: " + passed + " tests passed");
