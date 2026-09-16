// merge.test.mjs — member identity: folding a person's split ids into one history.
//
// A person can end up with two or three member ids (a rejoin, a reinstall, a wrong code). Until
// they are merged their logs, streaks and board share are split across ids. A merge event says
// "these are the same person"; replay then reads every event the duplicate authored as the kept
// id, so the history unifies everywhere at once.

import assert from "node:assert/strict";
import {
  replay, addDays, valueOn, canonicalMember, aliasesOf, HIT,
} from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, PERIOD, AGGREGATE } from "../js/schema.js";
import { dailyFacts, consistency } from "../js/dailyfacts.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const D0 = "2026-03-02"; // Monday
const day = (n) => addDays(D0, n);
const at = (d, h = 20) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd, h - 2); };
let seq = 0;
const E = (spec, ts, author = "x") => ({ eventId: "e" + String(++seq).padStart(4, "0"), ts, seq, author, ...spec });

function base() {
  seq = 0;
  return [
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, period: PERIOD.DAY, aggregate: AGGREGATE.LAST, tz: TZ }), at(D0, 6)),
    // Anj joined twice, older id first.
    E(ev.member("anj-old", "Anj"), at(day(0), 6)),
    E(ev.member("anj-new", "Anj"), at(day(3), 6)),
    // Some days logged under the old id, some under the new — a split history.
    E(ev.log("steps", "anj-old", day(0), 12000, SOURCE.MANUAL), at(day(0))),
    E(ev.log("steps", "anj-old", day(1), 11000, SOURCE.MANUAL), at(day(1))),
    E(ev.log("steps", "anj-new", day(3), 13000, SOURCE.MANUAL), at(day(3))),
    E(ev.log("steps", "anj-new", day(4), 14000, SOURCE.MANUAL), at(day(4))),
  ];
}

test("without a merge, the two ids are two members with split logs", () => {
  const s = replay(base());
  assert.equal(s.members.size, 2);
  assert.equal(valueOn(s, s.habits.get("steps"), "anj-old", day(0)), 12000);
  assert.equal(valueOn(s, s.habits.get("steps"), "anj-new", day(0)), null, "the old day is not on the new id");
});

test("merging anj-new into anj-old folds every event onto the kept id", () => {
  const s = replay([...base(), E(ev.mergeMember("anj-new", "anj-old"), at(day(5), 6))]);
  assert.equal(s.members.size, 1, "one person now");
  assert.ok(s.members.has("anj-old"));
  assert.equal(s.members.has("anj-new"), false, "the duplicate id is gone from the board");
  // Every day is readable on the kept id, whichever id originally logged it.
  assert.equal(valueOn(s, s.habits.get("steps"), "anj-old", day(3)), 13000);
  assert.equal(valueOn(s, s.habits.get("steps"), "anj-old", day(4)), 14000);
  assert.equal(canonicalMember(s, "anj-new"), "anj-old");
  assert.deepEqual(aliasesOf(s, "anj-old"), ["anj-new"]);
});

test("the merge is order-independent — it applies to events written before AND after it", () => {
  // Put the merge in the MIDDLE, and log more under the (now aliased) new id afterwards.
  const events = [...base(),
    E(ev.mergeMember("anj-new", "anj-old"), at(day(5), 6)),
    E(ev.log("steps", "anj-new", day(6), 15000, SOURCE.MANUAL), at(day(6))),
  ];
  const s = replay(events);
  assert.equal(valueOn(s, s.habits.get("steps"), "anj-old", day(6)), 15000, "later logs on the old id too");
});

test("the kept id's join day is the earliest across both, and its name stands", () => {
  // Merge the OLDER id into the NEWER one: the person still joined on day 0.
  const s = replay([...base(),
    E(ev.member("anj-new", "AJ"), at(day(4), 7)),                 // the kept id renames itself
    E(ev.mergeMember("anj-old", "anj-new"), at(day(5), 6)),
  ]);
  assert.equal(s.members.size, 1);
  const m = s.members.get("anj-new");
  assert.equal(m.since, day(0), "joined the day the earliest id first appeared");
  assert.equal(m.name, "AJ", "the folded-in id does not rename the person");
});

test("a duplicate removed BEFORE being merged does not delete the person", () => {
  const s = replay([...base(),
    E(ev.member("anj-new", "Anj", { removed: true }), at(day(4), 8)), // the dup was cleaned off first
    E(ev.mergeMember("anj-new", "anj-old"), at(day(5), 6)),
  ]);
  assert.ok(s.members.has("anj-old"), "the person survives");
  // and the removed duplicate's logs still fold in
  assert.equal(valueOn(s, s.habits.get("steps"), "anj-old", day(3)), 13000);
});

test("chained merges resolve to one root and do not loop", () => {
  const s = replay([
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 1, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.member("a", "A"), at(day(0), 6)),
    E(ev.member("b", "A"), at(day(0), 6)),
    E(ev.member("c", "A"), at(day(0), 6)),
    E(ev.log("steps", "a", day(0), 5, SOURCE.MANUAL), at(day(0))),
    E(ev.log("steps", "b", day(1), 6, SOURCE.MANUAL), at(day(1))),
    E(ev.log("steps", "c", day(2), 7, SOURCE.MANUAL), at(day(2))),
    E(ev.mergeMember("a", "b"), at(day(3), 6)),
    E(ev.mergeMember("b", "c"), at(day(3), 7)),
    // and a cycle attempt, which must be ignored rather than hang
    E(ev.mergeMember("c", "a"), at(day(3), 8)),
  ]);
  assert.equal(s.members.size, 1, "all three are one person");
  const id = [...s.members.keys()][0];
  assert.equal(valueOn(s, s.habits.get("steps"), id, day(0)), 5);
  assert.equal(valueOn(s, s.habits.get("steps"), id, day(1)), 6);
  assert.equal(valueOn(s, s.habits.get("steps"), id, day(2)), 7);
});

test("the read-model unifies a merged person into one longitudinal history", () => {
  const s = replay([...base(), E(ev.mergeMember("anj-new", "anj-old"), at(day(5), 6))]);
  const facts = dailyFacts(s, { me: "anj-old", to: day(4) });
  const steps = facts.filter((f) => f.habitId === "steps" && f.reported);
  assert.equal(steps.length, 4, "all four days, across both original ids, in one person's facts");
  const c = consistency(facts, "steps");
  assert.equal(c.metDays, 4, "and all four count toward their consistency");
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ member merge / identity: " + passed + " tests passed");
