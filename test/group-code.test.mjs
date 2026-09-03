// group-code.test.mjs — accepting a code that has been through a human and a phone keyboard.
//
// Written after a real join failed: the code showed up in the field as "HABIT - 7KMDWS", with
// spaces around the hyphen, and the app rejected it as malformed. It was the right code. Being
// pedantic about punctuation at the exact moment somebody is trying to join their friends is the
// worst possible place to be strict, so these are the shapes that must all work.

import assert from "node:assert/strict";
import { normalizeGroupCode, isGroupCode, groupCode } from "../js/id.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const CANON = "HABIT-7KMDWS";

test("a clean code passes through untouched", () => {
  assert.equal(normalizeGroupCode(CANON), CANON);
});

test("spaces around the hyphen are accepted — the bug this exists for", () => {
  assert.equal(normalizeGroupCode("HABIT - 7KMDWS"), CANON);
  assert.equal(normalizeGroupCode("HABIT -7KMDWS"), CANON);
  assert.equal(normalizeGroupCode("HABIT- 7KMDWS"), CANON);
});

test("lower case and surrounding whitespace are fine", () => {
  assert.equal(normalizeGroupCode("  habit-7kmdws  "), CANON);
  assert.equal(normalizeGroupCode("Habit-7KmdWs"), CANON);
});

test("an autocorrected dash still works", () => {
  // Phone keyboards turn a hyphen between spaces into an en or em dash without being asked.
  assert.equal(normalizeGroupCode("HABIT – 7KMDWS"), CANON);
  assert.equal(normalizeGroupCode("HABIT — 7KMDWS"), CANON);
  assert.equal(normalizeGroupCode("HABIT_7KMDWS"), CANON);
});

test("the prefix can be missing entirely", () => {
  // People read the interesting half off the screen and type only that.
  assert.equal(normalizeGroupCode("7KMDWS"), CANON);
  assert.equal(normalizeGroupCode("7kmdws"), CANON);
});

test("a code copied with no separator at all works", () => {
  assert.equal(normalizeGroupCode("HABIT7KMDWS"), CANON);
});

test("the body still has to be six valid characters", () => {
  // Past this point a wrong code is an empty room rather than an error, so the check stays strict.
  assert.equal(normalizeGroupCode("HABIT-7KMDW"), "");    // too short
  assert.equal(normalizeGroupCode("HABIT-7KMDWSX"), "");  // too long
  assert.equal(normalizeGroupCode(""), "");
  assert.equal(normalizeGroupCode(null), "");
  assert.equal(normalizeGroupCode("just some words"), "");
});

test("characters left out of the alphabet are rejected rather than guessed at", () => {
  // I, O, 0 and 1 are excluded precisely so they can never be confused for one another. Silently
  // mapping O to 0 would send someone confidently into the wrong room.
  assert.equal(normalizeGroupCode("HABIT-7KMDW0"), "");
  assert.equal(normalizeGroupCode("HABIT-7KMDWO"), "");
  assert.equal(normalizeGroupCode("HABIT-7KMDW1"), "");
  assert.equal(normalizeGroupCode("HABIT-7KMDWI"), "");
});

test("a generated code always survives a round trip", () => {
  for (let i = 0; i < 200; i += 1) {
    const generated = groupCode();
    assert.equal(normalizeGroupCode(generated), generated);
    assert.ok(isGroupCode(generated));
    // And it survives being mangled the way a person would mangle it.
    assert.equal(normalizeGroupCode(generated.replace("-", " - ").toLowerCase()), generated);
  }
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ group code: " + passed + " tests passed");
