// sync.test.mjs — the two decisions inside the sync engine that are easy to get wrong.
//
// The engine itself is I/O and cannot run under node. These two are not I/O at all, and they are
// the parts whose failures are invisible: a misclassified error tells the user the wrong story for
// a fortnight, and a missed restamp gives one person a different streak from everyone else on the
// same log.

import assert from "node:assert/strict";
import { classifySyncError, planMerge, STATES } from "../js/sync.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

// ===========================================================================
// Telling failures apart
// ===========================================================================

test("a vanished network is OFFLINE, not a server problem", () => {
  // fetch rejects with a TypeError when there is no connection. Nothing is wrong with the server
  // and nothing needs backing off — it will just work again when the signal comes back.
  const err = new TypeError("Failed to fetch");
  assert.equal(classifySyncError(err, true).state, STATES.OFFLINE);
  assert.equal(classifySyncError(new Error("anything"), false).state, STATES.OFFLINE);
});

test("a 4xx is REJECTED — alive and refusing us", () => {
  // A wrong key, a missing function, a policy change. Retrying cannot fix any of them, so saying
  // "retrying..." would be a small lie that makes a dead sync look like a slow one for weeks.
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const v = classifySyncError(Object.assign(new Error("no"), { status }), true);
    assert.equal(v.state, STATES.DEGRADED);
    assert.equal(v.reason, "rejected", "status " + status);
  }
});

test("a 5xx or a silent server is UNREACHABLE — most likely paused", () => {
  // On a free tier the overwhelmingly likely cause is a project paused for inactivity, which needs
  // a human to press Restore. Different words, different fix.
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifySyncError(Object.assign(new Error("no"), { status }), true).reason, "unreachable");
  }
  assert.equal(classifySyncError(new Error("no status at all"), true).reason, "unreachable");
});

test("being offline beats whatever the error said", () => {
  // The browser knows better than the exception does.
  const v = classifySyncError(Object.assign(new Error("no"), { status: 500 }), false);
  assert.equal(v.state, STATES.OFFLINE);
});

// ===========================================================================
// Merging a pulled page
// ===========================================================================

const row = (uuid, seq, overrides = {}) => ({
  uuid, seq,
  type: "habit_log",
  author: "m1",
  ts: 1772474400000,
  inserted_at: "2026-03-02T18:00:01.500Z",
  payload: { v: 1, habitId: "steps", memberId: "m1", day: "2026-03-02", value: 8412 },
  ...overrides,
});

test("an unseen row is stored, with the server's stamp on it", () => {
  const plan = planMerge([row("a", 7)], new Map());
  assert.equal(plan.toAdd.length, 1);
  assert.equal(plan.toRestamp.length, 0);
  assert.equal(plan.toAdd[0].eventId, "a");
  assert.equal(plan.toAdd[0].seq, 7);
  assert.equal(plan.toAdd[0].serverTs, Date.parse("2026-03-02T18:00:01.500Z"));
  assert.equal(plan.maxSeq, 7);
});

test("our own event coming back gets restamped exactly once", () => {
  // Written locally with only our clock on it. Without the server's arrival time, the device that
  // authored an event orders it by its own clock while everyone else orders it by the server's,
  // and the same log derives different streaks on different phones.
  const ours = { eventId: "a", type: "habit_log", ts: 1772474400000, payload: {} };
  const first = planMerge([row("a", 7)], new Map([["a", ours]]));
  assert.equal(first.toAdd.length, 0);
  assert.equal(first.toRestamp.length, 1);
  assert.equal(first.toRestamp[0].serverTs, Date.parse("2026-03-02T18:00:01.500Z"));
  assert.equal(first.toRestamp[0].seq, 7);

  const stamped = { ...ours, serverTs: Date.parse("2026-03-02T18:00:01.500Z"), seq: 7 };
  const again = planMerge([row("a", 7)], new Map([["a", stamped]]));
  assert.equal(again.toRestamp.length, 0, "already stamped — nothing to do");
  assert.equal(again.toAdd.length, 0);
});

test("a restamp keeps the event's own content", () => {
  // It changes ordering, not data. Overwriting the payload from the pulled row would be harmless
  // today and a silent data loss the moment the two ever differ.
  const ours = { eventId: "a", type: "habit_log", ts: 999, payload: { keep: "me" }, extra: 1 };
  const plan = planMerge([row("a", 7)], new Map([["a", ours]]));
  assert.deepEqual(plan.toRestamp[0].payload, { keep: "me" });
  assert.equal(plan.toRestamp[0].ts, 999);
  assert.equal(plan.toRestamp[0].extra, 1);
});

test("the cursor advances to the highest seq in the page", () => {
  const plan = planMerge([row("a", 3), row("b", 9), row("c", 5)], new Map());
  assert.equal(plan.maxSeq, 9, "not the last row's seq — the largest");
  assert.equal(plan.toAdd.length, 3);
});

test("an empty page moves nothing", () => {
  const plan = planMerge([], new Map());
  assert.equal(plan.maxSeq, 0);
  assert.equal(plan.toAdd.length, 0);
  assert.equal(plan.toRestamp.length, 0);
});

test("a row with no usable timestamps still gets a deterministic one", () => {
  // Date.now() here would make replay order depend on when a device happened to sync, which is
  // the one thing the ordering rule exists to prevent.
  const plan = planMerge([row("a", 1, { ts: 0, inserted_at: "nonsense" })], new Map());
  assert.equal(plan.toAdd[0].ts, 0);
  assert.equal(plan.toAdd[0].serverTs, undefined);
});

test("a row missing seq does not corrupt the cursor", () => {
  const plan = planMerge([row("a", 4), row("b", undefined)], new Map());
  assert.equal(plan.maxSeq, 4);
  assert.equal(plan.toAdd[1].seq, undefined);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ sync engine: " + passed + " tests passed");
