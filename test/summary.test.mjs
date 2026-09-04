// summary.test.mjs — the snapshot the shell draws its own screens from.
//
// This is a wire format, so it gets wire-format tests. The shell caches whatever it was last given
// and renders Home and Insights from it with no WebView running, which means an old APK will be
// reading new summaries and a new one old summaries for as long as it takes three phones to
// update. Anything that does not survive JSON, or that the shell would have to interpret, is a bug
// that only shows up on somebody else's phone.

import assert from "node:assert/strict";
import { replay, addDays, HIT, MISS, NO_DATA, EXEMPT } from "../js/habits.js";
import { buildSummary, summarySignature, SUMMARY_VERSION } from "../js/summary.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, AGGREGATE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const START = "2026-03-02";
const day = (n) => addDays(START, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "s" + ++seq, ts, seq, ...spec });

function world(extra = []) {
  return replay([
    E(ev.member("m1", "Me"), at(0)),
    E(ev.member("m2", "Thabo"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", icon: "👟", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT, tz: TZ, dayStartHour: 0,
    }), at(0)),
    E(ev.habit("sleep", {
      name: "Sleep", icon: "😴", metric: METRIC.SLEEP, direction: AT_LEAST, target: 420,
      aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT, tz: TZ, dayStartHour: 0,
    }), at(0)),
    E(ev.habit("puffs", {
      name: "Vape puffs", icon: "💨", metric: METRIC.PUFFS, direction: AT_MOST, target: 200,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0, scored: true,
    }), at(0)),
    E(ev.bind("m1", "steps", SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.bind("m1", "sleep", SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.bind("m1", "puffs", SOURCE.MANUAL), at(0)),
    ...extra,
  ]);
}

const find = (s, id) => s.habits.find((h) => h.id === id);

// ---------------------------------------------------------------------------
// What it says
// ---------------------------------------------------------------------------

test("every tracked habit is in it, not only the ones Pause can measure", () => {
  // The whole reason it exists. Home and Insights are native and only ever knew about screen time,
  // so somebody tracking steps, sleep and a savings target got a progress screen about none of it.
  const s = buildSummary(world(), "m1", day(0), ["m1", "m2"]);
  assert.equal(s.v, SUMMARY_VERSION);
  assert.deepEqual(s.habits.map((h) => h.id).sort(), ["puffs", "sleep", "steps"]);
});

test("the day is counted the way the engine counts it, not re-derived", () => {
  const s = buildSummary(world([
    E(ev.log("steps", "m1", day(0), 11000, SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.log("puffs", "m1", day(0), 150, SOURCE.MANUAL), at(0)),
    // Sleep says nothing, and its source is a watch — so it is waiting, not failed.
  ]), "m1", day(0), ["m1", "m2"]);

  assert.equal(find(s, "steps").status, HIT);
  assert.equal(find(s, "puffs").status, HIT);
  assert.equal(find(s, "sleep").status, NO_DATA);
  assert.equal(s.done, 2);
  assert.equal(s.due, 2, "a habit still waiting on a sensor is not yet due");
  assert.equal(s.waiting, 1);
});

test("numbers arrive spoken, because the shell has no metric table", () => {
  // Sleep is stored in minutes and said in hours. Sending 430 and letting Kotlin decide is how a
  // value reads "430" on one screen and "7h 10m" on the next.
  const s = buildSummary(world([
    E(ev.log("sleep", "m1", day(0), 430, SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.log("steps", "m1", day(0), 10300, SOURCE.HEALTH_CONNECT), at(0)),
  ]), "m1", day(0), ["m1"]);
  assert.equal(find(s, "sleep").headline, "7h 10m");
  // Grouped, not raw — and asserted without naming the separator, which toLocaleString takes from
  // the device. A comma here and a space on a phone set to French are both correct; "10300" is not.
  const steps = find(s, "steps").headline;
  assert.equal(steps.replace(/\D/g, ""), "10300");
  assert.notEqual(steps, "10300", "a five-figure number should be grouped");
});

test("a ceiling counts down, and its bar fills as the budget survives", () => {
  // Showing "150 of 200" for something you are quitting puts the emphasis on the wrong number and
  // makes a bad day look like progress.
  const s = buildSummary(world([
    E(ev.log("puffs", "m1", day(0), 150, SOURCE.MANUAL), at(0)),
  ]), "m1", day(0), ["m1"]);
  const puffs = find(s, "puffs");
  assert.equal(puffs.reduce, true);
  assert.equal(puffs.headline, "50");
  assert.equal(puffs.caption, "left of 200");
  assert.equal(puffs.progress, 25, "a quarter of the budget left is a quarter-full bar");
});

test("a missed ceiling does not report a negative bar", () => {
  const s = buildSummary(world([
    E(ev.log("puffs", "m1", day(0), 400, SOURCE.MANUAL), at(0)),
  ]), "m1", day(0), ["m1"]);
  const puffs = find(s, "puffs");
  assert.equal(puffs.status, MISS);
  assert.equal(puffs.headline, "0");
  assert.equal(puffs.progress, 0);
});

test("a habit opted out of is resting, not missing", () => {
  const s = buildSummary(world([
    E(ev.goal("m1", "puffs", { target: 200, active: false }), at(0)),
  ]), "m1", day(0), ["m1"]);
  // Opting out on day one is honoured on day one, so it drops off the list entirely.
  assert.equal(find(s, "puffs"), undefined);
  assert.equal(s.resting, 0);
});

test("where you stand in the group comes along too", () => {
  const s = buildSummary(world([
    E(ev.log("steps", "m1", day(0), 11000, SOURCE.HEALTH_CONNECT), at(0)),
  ]), "m1", day(0), ["m1", "m2"]);
  assert.equal(s.board.of, 2);
  assert.ok(s.board.rank >= 1);
});

// ---------------------------------------------------------------------------
// What it must survive
// ---------------------------------------------------------------------------

test("the day's categories come along, already labelled", () => {
  // The shell has no table of what a category is called or what it is worth, and giving it one
  // would be the second implementation this whole design exists to avoid.
  const s = buildSummary(world([
    E(ev.log("steps", "m1", day(0), 11000, SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.log("puffs", "m1", day(0), 100, SOURCE.MANUAL), at(0)),
  ]), "m1", day(0), ["m1"]);
  const keys = s.categories.map((c) => c.key);
  assert.ok(keys.includes("fitness") && keys.includes("discipline"));
  for (const c of s.categories) {
    assert.equal(typeof c.label, "string");
    assert.ok(c.pct >= 0 && c.pct <= 100);
    assert.ok(c.share > 0, "a category with no share would not be here");
  }
  assert.equal(typeof s.today_pct, "number");
});

test("the season rides along, or is null before a week has finished", () => {
  const s = buildSummary(world(), "m1", day(0), ["m1"]);
  assert.ok(s.season === null || typeof s.season.weeks === "number");
});

test("the on-goal streak spans every habit, not just the one Pause can see", () => {
  // Pause's hero has always counted "days the slowed apps stayed under their limit", because
  // screen time is the only thing Pause measures itself. On a phone tracking four things that is a
  // number which looks like the whole picture and is not.
  const logs = [];
  for (let n = 0; n < 4; n += 1) {
    logs.push(E(ev.log("steps", "m1", day(n), 11000, SOURCE.HEALTH_CONNECT), at(n)));
    logs.push(E(ev.log("sleep", "m1", day(n), 430, SOURCE.HEALTH_CONNECT), at(n)));
    logs.push(E(ev.log("puffs", "m1", day(n), 100, SOURCE.MANUAL), at(n)));
  }
  const s = buildSummary(world(logs), "m1", day(3), ["m1"]);
  assert.equal(s.onGoalStreak, 4);
});

test("one habit short breaks it, which is the point of counting all of them", () => {
  const logs = [];
  for (let n = 0; n < 4; n += 1) {
    logs.push(E(ev.log("steps", "m1", day(n), 11000, SOURCE.HEALTH_CONNECT), at(n)));
    logs.push(E(ev.log("sleep", "m1", day(n), 430, SOURCE.HEALTH_CONNECT), at(n)));
    // The vape is only reported on the last two days; before that it is an unlogged miss.
    if (n >= 2) logs.push(E(ev.log("puffs", "m1", day(n), 100, SOURCE.MANUAL), at(n)));
  }
  const s = buildSummary(world(logs), "m1", day(3), ["m1"]);
  assert.equal(s.onGoalStreak, 2);
});

test("a day nothing was asked about neither breaks the streak nor extends it", () => {
  // A rest day, or a week away. Stepping over it is the only reading that is neither a punishment
  // nor a gift.
  const logs = [];
  for (const n of [0, 1, 3]) {
    logs.push(E(ev.log("steps", "m1", day(n), 11000, SOURCE.HEALTH_CONNECT), at(n)));
    logs.push(E(ev.log("sleep", "m1", day(n), 430, SOURCE.HEALTH_CONNECT), at(n)));
    logs.push(E(ev.log("puffs", "m1", day(n), 100, SOURCE.MANUAL), at(n)));
  }
  const s = buildSummary(
    world([...logs, E(ev.exempt("m1", day(2), day(2), "travel"), at(0))]),
    "m1", day(3), ["m1"],
  );
  assert.equal(s.onGoalStreak, 3, "three scored days with a rest stepped over in the middle");
});

test("it survives a round trip through JSON unchanged", () => {
  // It crosses to Kotlin as a string and comes back out of SharedPreferences days later. A Map, a
  // Date or an undefined in here is a field that silently vanishes on somebody else's phone.
  const s = buildSummary(world([
    E(ev.log("steps", "m1", day(0), 11000, SOURCE.HEALTH_CONNECT), at(0)),
  ]), "m1", day(0), ["m1", "m2"]);
  const back = JSON.parse(JSON.stringify(s));
  assert.deepEqual(back, s);
  assert.ok(!JSON.stringify(s).includes("undefined"));
});

test("null is used where a number would be a lie", () => {
  // "No progress to report" and "zero progress" are different, and an engine that conflates them
  // draws an empty bar for a habit nobody has measured yet.
  const s = buildSummary(world(), "m1", day(0), ["m1"]);
  assert.equal(find(s, "steps").progress, null);
  assert.equal(find(s, "steps").status, NO_DATA);
});

test("a group of one still produces a summary", () => {
  const s = buildSummary(world(), "m1", day(0), ["m1"]);
  assert.ok(s.board !== undefined);
  assert.equal(s.habits.length, 3);
});

test("no members at all is not a crash", () => {
  const s = buildSummary(replay([]), "m1", day(0), []);
  assert.equal(s.habits.length, 0);
  assert.equal(s.board, null);
  assert.equal(s.due, 0);
});

test("the signature changes when something drawable changes, and not otherwise", () => {
  // The bridge call is cheap but not free, and a repaint is not news. What matters is that it does
  // not go quiet on a change somebody would see.
  const quiet = world();
  const loud = world([E(ev.log("steps", "m1", day(0), 11000, SOURCE.HEALTH_CONNECT), at(0))]);
  const a = summarySignature(buildSummary(quiet, "m1", day(0), ["m1"]));
  const b = summarySignature(buildSummary(quiet, "m1", day(0), ["m1"]));
  const c = summarySignature(buildSummary(loud, "m1", day(0), ["m1"]));
  assert.equal(a, b, "the same state twice is not news");
  assert.notEqual(a, c, "a habit turning green is");
});

test("the signature ignores the clock, or it would fire on every repaint", () => {
  const s1 = buildSummary(world(), "m1", day(0), ["m1"]);
  const s2 = buildSummary(world(), "m1", day(0), ["m1"]);
  s2.at = s1.at + 60_000;
  assert.equal(summarySignature(s1), summarySignature(s2));
});

test("the bonus crosses the bridge as its own number, never inside the percentage", () => {
  // The shell draws these and cannot recompute them, so this payload is the whole contract. A day
  // is worth exactly 100 and the bonus rides beside it — folding them together would make "out of
  // 100" meaningless on the one screen most people look at.
  const s = buildSummary(world([
    E(ev.log("steps", "m1", day(0), 20000, SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.log("sleep", "m1", day(0), 480, SOURCE.HEALTH_CONNECT), at(0)),
    E(ev.log("puffs", "m1", day(0), 0, SOURCE.MANUAL), at(0)),
  ]), "m1", day(0), ["m1", "m2"]);

  assert.equal(s.v, SUMMARY_VERSION, "the version says which fields to expect");
  assert.equal(s.today_pct, 100, "a day is still out of a hundred");
  assert.ok(s.today_bonus > 0, "and beating the targets is worth something beside it");
  assert.ok(s.today_bonus <= 15, "never outside its own ceiling");
  assert.equal(s.bonus_held, false);
  assert.equal(s.bonus_withheld, 0);
  for (const c of s.categories) assert.equal(typeof c.bonus, "number");
});

test("Rest & recovery reports no bonus however well it went", () => {
  const s = buildSummary(world([
    E(ev.log("sleep", "m1", day(0), 700, SOURCE.HEALTH_CONNECT), at(0)),
  ]), "m1", day(0), ["m1", "m2"]);
  const rest = s.categories.find((c) => c.key === "rest");
  if (rest) assert.equal(rest.bonus, 0, "oversleeping is not an achievement to pay for");
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ shell summary: " + passed + " tests passed");
