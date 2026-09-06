// edits.test.mjs — save it, replay it, open it again, and see what it says.
//
// ---- The bug this is built around ----
//
// Reported as "saving changes when editing a habit does not persist". You change 10 000 to 8 000,
// press save, reopen the screen, and it says 10 000.
//
// Nothing failed. A goal change starts counting TOMORROW — that is what stops a bad week being
// rescued on Sunday night — so the number in force today is still the old one. The editor was
// showing the number in force. The save had worked perfectly and the screen said otherwise, which
// is worse than an error: an error tells you to try again, this told you the app was broken.
//
// The goals sheet had this right, with a comment saying exactly why. The editor was written later
// and answered the same question differently. So the rule moved into edits.js and both screens
// read it, and these tests go all the way round — form values, to events, through replay, to what
// the screen would show next time — because every single-step test of this passes.

import assert from "node:assert/strict";
import { replay, addDays, targetFor, latestGoal } from "../js/habits.js";
import { goalToShow, habitFields } from "../js/edits.js";
import { ev, METRIC, AT_LEAST, AT_MOST, AGGREGATE, SOURCE, PERIOD, VISIBILITY } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MON = "2026-03-02";
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T09:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "e" + ++seq, ts, seq, ...spec });

const STEPS = {
  key: "steps", label: "Steps", icon: "👟", metric: METRIC.STEPS,
  direction: AT_LEAST, aggregate: AGGREGATE.SUM, period: PERIOD.DAY,
};

const world = (extra = []) => replay([
  E(ev.member("me", "Me"), at(0)),
  E(ev.member("anj", "Anj"), at(0)),
  E(ev.habit("h", {
    name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
    period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
    tz: TZ, dayStartHour: 4,
  }), at(0)),
  ...extra,
]);

/** What the editor would put in the goal box, opening on [n]. */
const shown = (s, who, n) => goalToShow(s, s.habits.get("h"), who, day(n));

/** Saving the editor: the habit event it writes, plus the personal goal beside it. */
const save = (s, who, n, { isNew = false, name = "Steps", target, days, taper = false } = {}) => replay([
  ...s.__events,
  E(ev.habit("h", habitFields({
    isNew, name, type: STEPS, target, taper,
    days: days || [1, 2, 3, 4, 5, 6, 7], tz: TZ, dayStartHour: 4,
    category: "fitness", visibility: VISIBILITY.FULL, source: SOURCE.MANUAL,
  })), at(n)),
  E(ev.goal(who, "h", { target, active: true }), at(n)),
]);

/** replay() drops the source list, so keep it for the round trip. */
const withEvents = (extra = []) => {
  const events = [
    E(ev.member("me", "Me"), at(0)),
    E(ev.member("anj", "Anj"), at(0)),
    E(ev.habit("h", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 4,
    }), at(0)),
    ...extra,
  ];
  const s = replay(events);
  s.__events = events;
  return s;
};

// ---------------------------------------------------------------------------
// The round trip: what you save is what you see
// ---------------------------------------------------------------------------

test("a goal change is still there when you reopen the screen", () => {
  // The reported bug, in one assertion. Before the fix this returned 10 000 and looked like a
  // save that had silently failed.
  const s = withEvents([E(ev.goal("me", "h", { target: 10000, active: true }), at(1))]);
  const after = save(s, "me", 6, { target: 8000 });
  assert.equal(shown(after, "me", 6), 8000, "reopened on the same day");
});

test("even though it does not take effect until tomorrow", () => {
  // Both halves are true at once, and that is the whole subtlety. The screen shows what you chose;
  // the scorer uses what was in force. Asserting them together is what stops somebody "fixing"
  // this by making the change count today, which would reopen the Sunday-night rescue.
  const s = withEvents([E(ev.goal("me", "h", { target: 10000, active: true }), at(1))]);
  const after = save(s, "me", 6, { target: 8000 });
  assert.equal(shown(after, "me", 6), 8000, "what you set");
  assert.equal(targetFor(after, after.habits.get("h"), "me", day(6)), 10000, "what counts today");
  assert.equal(targetFor(after, after.habits.get("h"), "me", day(7)), 8000, "and from tomorrow");
});

test("a name change is there immediately", () => {
  const s = withEvents();
  const after = save(s, "me", 6, { name: "Daily steps", target: 10000 });
  assert.equal(after.habits.get("h").name, "Daily steps");
});

test("a change to which days is there immediately", () => {
  const s = withEvents();
  const after = save(s, "me", 6, { target: 10000, days: [1, 3, 5] });
  assert.deepEqual(after.habits.get("h").days, [1, 3, 5]);
});

test("switching the taper on is there immediately", () => {
  const s = withEvents();
  const after = save(s, "me", 6, { target: 10000, taper: true });
  assert.ok(after.habits.get("h").taper, "taper survived the save");
});

test("saving twice in a day keeps the last number", () => {
  // Somebody who thought it had not saved and did it again — which is exactly what the old
  // behaviour invited.
  const s = withEvents([E(ev.goal("me", "h", { target: 10000, active: true }), at(1))]);
  const once = save(s, "me", 6, { target: 8000 });
  once.__events = [...s.__events,
    E(ev.habit("h", habitFields({
      isNew: false, name: "Steps", type: STEPS, target: 8000, taper: false,
      days: [1, 2, 3, 4, 5, 6, 7], tz: TZ, dayStartHour: 4,
      category: "fitness", visibility: VISIBILITY.FULL, source: SOURCE.MANUAL,
    })), at(6)),
    E(ev.goal("me", "h", { target: 8000, active: true }), at(6))];
  const twice = save(once, "me", 6, { target: 7000 });
  assert.equal(shown(twice, "me", 6), 7000);
});

// ---------------------------------------------------------------------------
// And it is still nobody else's number
// ---------------------------------------------------------------------------

test("editing does not move anybody else", () => {
  const s = withEvents([E(ev.goal("me", "h", { target: 10000, active: true }), at(1))]);
  const after = save(s, "me", 6, { target: 8000 });
  assert.equal(targetFor(after, after.habits.get("h"), "anj", day(7)), 10000, "Anj is untouched");
  assert.equal(after.habits.get("h").target, 10000, "and the seed is untouched");
});

test("but creating one DOES set the seed", () => {
  // The other half of the isNew rule: a habit has to be born with a number, or everybody joining
  // later has nothing to be judged against.
  const fields = habitFields({
    isNew: true, name: "Steps", type: STEPS, target: 12000, taper: false,
    days: [1, 2, 3, 4, 5, 6, 7], tz: TZ, dayStartHour: 4,
    category: "fitness", visibility: VISIBILITY.FULL, source: SOURCE.MANUAL,
  });
  assert.equal(fields.target, 12000);
});

test("and editing one never mentions the seed at all", () => {
  // Asserted on the payload rather than through replay, because "absent" and "unchanged" look
  // identical afterwards and only one of them is what this has to guarantee.
  const fields = habitFields({
    isNew: false, name: "Steps", type: STEPS, target: 12000, taper: false,
    days: [1, 2, 3, 4, 5, 6, 7], tz: TZ, dayStartHour: 4,
    category: "fitness", visibility: VISIBILITY.FULL, source: SOURCE.MANUAL,
  });
  assert.ok(!("target" in fields), "target must not be in an edit payload");
});

// ---------------------------------------------------------------------------
// What the box says before you have chosen anything
// ---------------------------------------------------------------------------

test("somebody who has never set a goal sees the seed", () => {
  const s = withEvents();
  assert.equal(shown(s, "anj", 6), 10000);
});

test("a zero or missing target falls back rather than showing nothing", () => {
  // Goals written by older builds, and by setGoals when a row was left blank.
  const s = withEvents([E(ev.goal("me", "h", { target: 0, active: true }), at(1))]);
  assert.equal(shown(s, "me", 6), 10000);
});

test("an opted-out habit still shows the number you last chose", () => {
  // Opting out does not forget your target — you come back to the goal you left, not to the
  // group's.
  const s = withEvents([
    E(ev.goal("me", "h", { target: 9000, active: true }), at(1)),
    E(ev.goal("me", "h", { active: false }), at(2)),
  ]);
  assert.equal(shown(s, "me", 6), 9000);
  assert.equal(latestGoal(s, "h", "me").active, false);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ edits: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ edits: " + passed + " tests passed");
