// roster.test.mjs — the menu's reading of the room, as executable claims.
//
// The Habits sheet decides two things that used to be untested render-layer logic: how much each id
// has logged (which tells two identical names apart, and gates a safe removal), and which ids are
// the SAME person split apart — the offer that folds a scattered identity back into one. That offer
// is the exact repair the friend group needed, so whether it fires is worth pinning.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, PERIOD } from "../js/schema.js";
import { countMemberLogs, countHabitLogs, duplicateGroups, mergeTarget } from "../js/roster.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const D0 = "2026-09-01";
const day = (n) => addDays(D0, n);
const at = (d, h = 20) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd, h - 2); };
let seq = 0;
const E = (spec, ts) => ({ eventId: "e" + String(++seq).padStart(4, "0"), ts, seq, author: "a", ...spec });

function room() {
  seq = 0;
  const evs = [
    E(ev.member("a", "Anj"), at(D0, 6)),
    E(ev.member("b", "Ivan"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 5000, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.habit("vape", { name: "Vape", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
  ];
  // a: steps on 3 distinct days, vape on 2 distinct days = 5 log keys; b: steps on 1 day = 1 key
  for (let n = 0; n < 3; n++) evs.push(E(ev.log("steps", "a", day(n), 8000, SOURCE.HEALTH_CONNECT), at(day(n))));
  for (let n = 0; n < 2; n++) evs.push(E(ev.log("vape", "a", day(n), 5, SOURCE.MANUAL), at(day(n))));
  evs.push(E(ev.log("steps", "b", day(0), 9000, SOURCE.HEALTH_CONNECT), at(day(0))));
  // a re-logs the same steps day twice more — one key, not three (the count is per day, not per write)
  evs.push(E(ev.log("steps", "a", day(0), 8100, SOURCE.HEALTH_CONNECT), at(day(0)) + 1000));
  evs.push(E(ev.log("steps", "a", day(0), 8200, SOURCE.HEALTH_CONNECT), at(day(0)) + 2000));
  return replay(evs);
}

test("countMemberLogs counts one key per member-habit-day, not per write", () => {
  const s = room();
  assert.equal(countMemberLogs(s, "a"), 5, "3 steps days + 2 vape days, re-writes of a day still one");
  assert.equal(countMemberLogs(s, "b"), 1);
  assert.equal(countMemberLogs(s, "nobody"), 0);
});

test("countHabitLogs counts every member's days for a habit", () => {
  const s = room();
  assert.equal(countHabitLogs(s, "steps"), 4, "a's 3 days + b's 1");
  assert.equal(countHabitLogs(s, "vape"), 2);
  assert.equal(countHabitLogs(s, "ghost"), 0);
});

test("the counts are coupled to the log-key format — if it changes, this fails loudly", () => {
  // Every stored key must be habitId|memberId|day, three parts. This is the assumption both counts
  // (and the safe-removal UX that reads them) rest on.
  const s = room();
  for (const key of s.logs.keys()) {
    assert.equal(key.split("|").length, 3, "unexpected log key shape: " + key);
  }
});

test("duplicateGroups finds the same name on more than one id, case- and space-insensitively", () => {
  const groups = duplicateGroups([
    { memberId: "1", name: "Anj", logged: 3 },
    { memberId: "2", name: " anj ", logged: 1 },   // same person: trimmed, lower-cased
    { memberId: "3", name: "ANJ", logged: 0 },       // and again
    { memberId: "4", name: "Ivan", logged: 9 },
  ]);
  assert.equal(groups.length, 1, "one duplicate group");
  assert.deepEqual(groups[0].map((m) => m.memberId).sort(), ["1", "2", "3"], "all three Anj ids, Ivan left out");
});

test("duplicateGroups never folds two nameless ids together, and never returns a lone id", () => {
  const groups = duplicateGroups([
    { memberId: "x", name: "", logged: 0 },   // nameless: keyed on its own id
    { memberId: "y", name: "", logged: 0 },   // a different nameless id — NOT the same person
    { memberId: "z", name: "Solo", logged: 2 },
  ]);
  assert.deepEqual(groups, [], "no false duplicate from blank names, and a solo name is not a group");
});

test("mergeTarget folds into the most-logged id, and breaks a tie deterministically by id", () => {
  const group = [
    { memberId: "b", name: "Anj", logged: 2 },
    { memberId: "a", name: "Anj", logged: 7 },  // the most logged — the one to keep
    { memberId: "c", name: "Anj", logged: 1 },
  ];
  assert.equal(mergeTarget(group).memberId, "a");
  // a tie on the count is settled by memberId, the same on every device
  const tied = [
    { memberId: "z", name: "Anj", logged: 4 },
    { memberId: "a", name: "Anj", logged: 4 },
  ];
  assert.equal(mergeTarget(tied).memberId, "a", "tie goes to the lower memberId, not to array order");
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ roster (the menu's read of the room): " + passed + " tests passed");
