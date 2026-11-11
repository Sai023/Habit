// cardorder.test.mjs — the order somebody keeps their habit cards in.
//
// The failure that matters is not a wrong order, it is a lost habit: a saved list that drops a card
// because it was added after the person arranged theirs. These pin that nothing is ever dropped or
// duplicated, whatever the stored list looks like.

import assert from "node:assert/strict";
import { orderHabits, idsOf, moveTo, shift, dropIndex, cleanSaved } from "../js/cardorder.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const H = (id) => ({ habitId: id });
const habits = ["steps", "sleep", "vape", "money"].map(H);
const ids = (list) => list.map((h) => h.habitId);

test("no saved order leaves the group's order alone", () => {
  assert.deepEqual(ids(orderHabits(habits, [])), ["steps", "sleep", "vape", "money"]);
  assert.deepEqual(ids(orderHabits(habits, undefined)), ["steps", "sleep", "vape", "money"]);
  assert.deepEqual(ids(orderHabits(habits, "junk")), ["steps", "sleep", "vape", "money"]);
});

test("a saved order is followed", () => {
  assert.deepEqual(ids(orderHabits(habits, ["money", "steps", "vape", "sleep"])), ["money", "steps", "vape", "sleep"]);
});

test("a habit added after the order was saved goes last, not missing", () => {
  const withNew = [...habits, H("workouts")];
  assert.deepEqual(ids(orderHabits(withNew, ["money", "steps", "vape", "sleep"])), ["money", "steps", "vape", "sleep", "workouts"]);
});

test("a habit that no longer exists is dropped, and a repeat is not doubled", () => {
  assert.deepEqual(ids(orderHabits(habits, ["gone", "vape", "vape", "steps"])), ["vape", "steps", "sleep", "money"]);
});

test("never drops or duplicates a habit, whatever is stored", () => {
  for (const saved of [[], ["x"], ["sleep"], ["money", "money", "zzz", "steps"], [1, null, "vape"]]) {
    const out = ids(orderHabits(habits, saved)).sort();
    assert.deepEqual(out, ["money", "sleep", "steps", "vape"], JSON.stringify(saved));
  }
});

test("orderHabits does not change the list it was given", () => {
  const before = ids(habits);
  orderHabits(habits, ["money"]);
  assert.deepEqual(ids(habits), before);
});

test("moveTo puts a card at a position, counted as the list ends up", () => {
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(moveTo(list, "a", 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveTo(list, "d", 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveTo(list, "b", 1), ["a", "b", "c", "d"], "its own slot changes nothing");
});

test("moveTo is forgiving of a finger: past the end clamps, unknown ids are ignored", () => {
  assert.deepEqual(moveTo(["a", "b", "c"], "a", 99), ["b", "c", "a"]);
  assert.deepEqual(moveTo(["a", "b", "c"], "c", -5), ["c", "a", "b"]);
  assert.deepEqual(moveTo(["a", "b"], "zzz", 0), ["a", "b"]);
  assert.deepEqual(moveTo(["a", "b", "c"], "b", NaN), ["a", "b", "c"]);
});

test("shift moves one step and stops at the ends", () => {
  assert.deepEqual(shift(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(shift(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(shift(["a", "b", "c"], "a", -1), ["a", "b", "c"], "already first");
  assert.deepEqual(shift(["a", "b", "c"], "c", 1), ["a", "b", "c"], "already last");
});

test("moveTo and shift do not change the list they were given", () => {
  const list = ["a", "b", "c"];
  moveTo(list, "a", 2); shift(list, "b", 1);
  assert.deepEqual(list, ["a", "b", "c"]);
});

test("dropIndex finds the card under the pointer, else the dragged card's own slot", () => {
  // Two columns, two rows.
  const r = (left, top) => ({ left, top, right: left + 100, bottom: top + 80 });
  const rects = [r(0, 0), r(110, 0), r(0, 90), r(110, 90)];
  assert.equal(dropIndex(rects, 150, 20, 0), 1);
  assert.equal(dropIndex(rects, 20, 120, 0), 2);
  assert.equal(dropIndex(rects, 105, 40, 3), 3, "in the gap between cards: stay put");
  assert.equal(dropIndex(rects, 500, 500, 2), 2, "off the grid: stay put");
});

test("cleanSaved keeps only strings, and only from an array", () => {
  assert.deepEqual(cleanSaved(["a", 1, null, "b"]), ["a", "b"]);
  assert.deepEqual(cleanSaved({ a: 1 }), []);
  assert.deepEqual(cleanSaved(null), []);
  assert.deepEqual(idsOf(habits), ["steps", "sleep", "vape", "money"]);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ card order: " + passed + " tests passed");
