// setup-code.test.mjs — the string that carries one person's identity between their two clients.
//
// A silent failure here is the worst kind this app has: you appear twice on your own leaderboard,
// half your data on each row, and nothing anywhere says why.

import assert from "node:assert/strict";
import { encodeSetup, decodeSetup } from "../js/setup-code.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const sample = {
  url: "https://yoydjgkvumxbaxzfbwvp.supabase.co",
  key: "sb_publishable_UZKTY0NhHnkuTSRAo7bcoQ_SGjoTcag",
  code: "HABIT-7Q2XK9",
  memberId: "3f1c9a12-88b4-4c1e-9b0a-2d7e5f4a6c31",
  name: "Sahil",
};

test("a setup code round-trips exactly", () => {
  const decoded = decodeSetup(encodeSetup(sample));
  assert.deepEqual(decoded, sample);
});

test("the member id survives, which is the entire point", () => {
  // If this ever drifts, the same person becomes two members and nothing visibly breaks.
  const decoded = decodeSetup(encodeSetup(sample));
  assert.equal(decoded.memberId, sample.memberId);
});

test("a name with an accent survives the round trip", () => {
  const decoded = decodeSetup(encodeSetup({ ...sample, name: "Zoë Ncwane" }));
  assert.equal(decoded.name, "Zoë Ncwane");
});

test("the code is URL-safe, so pasting it through a chat app cannot mangle it", () => {
  const encoded = encodeSetup(sample);
  assert.ok(/^HS1\.[A-Za-z0-9_-]+$/.test(encoded), "got: " + encoded);
});

test("a typo returns null instead of throwing", () => {
  assert.equal(decodeSetup("HS1.not-real-base64!!!"), null);
  assert.equal(decodeSetup("nonsense"), null);
  assert.equal(decodeSetup(""), null);
  assert.equal(decodeSetup(null), null);
  assert.equal(decodeSetup(undefined), null);
});

test("surrounding whitespace from a copy-paste is tolerated", () => {
  const encoded = encodeSetup(sample);
  assert.deepEqual(decodeSetup("  " + encoded + "\n"), sample);
});

test("a code missing a required field is rejected, not half-applied", () => {
  // Half-applying would leave a device configured with no member id, posting as nobody.
  assert.equal(encodeSetup({ ...sample, memberId: "" }), "");
  assert.equal(encodeSetup({ ...sample, url: "" }), "");
  const noMember = "HS1." + Buffer.from(JSON.stringify({ u: "a", k: "b", c: "c" }))
    .toString("base64url");
  assert.equal(decodeSetup(noMember), null);
});

test("a name is optional — everything else is not", () => {
  const decoded = decodeSetup(encodeSetup({ ...sample, name: "" }));
  assert.equal(decoded.name, "");
  assert.equal(decoded.memberId, sample.memberId);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ setup code: " + passed + " tests passed");
