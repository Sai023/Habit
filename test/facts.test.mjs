// facts.test.mjs — what the log is allowed to say about a person.
//
// Every fact has a floor below which it is absent, and the wording is the product. Both are
// pinned: a "strongest weekday" off one Tuesday is the kind of claim somebody changes their week
// for, and a sentence that says "1 days" is the kind of thing that makes the rest look invented.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, AGGREGATE, PERIOD } from "../js/schema.js";
import { factsAbout } from "../js/facts.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MON = "2026-03-02";
const day = (n) => addDays(MON, n);
const at = (n, h = 12) => Date.parse(day(n) + "T" + String(h).padStart(2, "0") + ":00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "f" + ++seq, ts, seq, ...spec });

const world = (extra = []) => replay([
  E(ev.meta({ tz: TZ }), at(0)),
  E(ev.member("me", "Me"), at(0)),
  E(ev.member("them", "Them"), at(0)),
  E(ev.habit("steps", {
    name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
    period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT, tz: TZ, dayStartHour: 0,
  }), at(0)),
  E(ev.habit("sleep", {
    name: "Sleep", metric: METRIC.SLEEP, direction: AT_LEAST, target: 420,
    period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT, tz: TZ, dayStartHour: 0,
  }), at(0)),
  E(ev.habit("puffs", {
    name: "Vape puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 20,
    period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
    taper: { amount: 1, everyDays: 7, floor: 0 },
  }), at(0)),
  E(ev.bind("me", "steps", SOURCE.HEALTH_CONNECT), at(0)),
  E(ev.bind("me", "sleep", SOURCE.HEALTH_CONNECT), at(0)),
  E(ev.bind("me", "puffs", SOURCE.MANUAL), at(0)),
  ...extra,
]);
const log = (h, n, v, src = SOURCE.HEALTH_CONNECT) => E(ev.log(h, "me", day(n), v, src), at(n, 20));
const fullDay = (n, steps = 10000) => [log("steps", n, steps), log("sleep", n, 450), log("puffs", n, 10, SOURCE.MANUAL)];
const titles = (facts) => facts.map((f) => f.title);
const find = (facts, title) => facts.find((f) => f.title === title);

test("a brand-new member gets nothing invented", () => {
  assert.deepEqual(factsAbout(world(), "me", day(0)), []);
});

test("one day played says so, in the singular, and claims nothing else", () => {
  const facts = factsAbout(world(fullDay(0)), "me", day(1));
  assert.equal(find(facts, "Days played").text.startsWith("1 day since"), true);
  assert.equal(find(facts, "Your best day"), undefined, "one day is not a best day");
  assert.equal(find(facts, "Your strongest day"), undefined);
  // The thousands separator is the locale's; the digits are what is checked.
  assert.match(find(facts, "Distance walked").text.replace(/[^\d a-z]/gi, ""), /^10\s?000 steps/, "steps are worth saying from day one");
});

test("a week of days earns the record, the walk, the sleep and the vape", () => {
  const s = world([0, 1, 2, 3, 4, 5, 6].flatMap((n) => fullDay(n, 9000 + n * 500)));
  const facts = factsAbout(s, "me", day(7));
  const t = titles(facts);
  for (const want of ["Days played", "Your best day", "Perfect days", "Distance walked", "Time asleep", "The vape", "At your pace"]) {
    assert.ok(t.includes(want), "missing: " + want + " in " + t.join(", "));
  }
  assert.equal(find(facts, "Your strongest day"), undefined, "one of each weekday is not a pattern");
  assert.match(find(facts, "Distance walked").text, /steps since you joined — about \d+(\.\d)? km/);
  assert.match(find(facts, "Time asleep").text, /over 7 nights — 7h 30m a night/);
  assert.match(find(facts, "The vape").text, /70 puffs logged over 7 days, 10 a day/);
});

test("the weekday pattern waits for two of each day, and the softest day for a real gap", () => {
  // Two weeks, every day equal: strongest is named (some day has to be) but there is no gap.
  const even = world([...Array(14).keys()].flatMap((n) => fullDay(n)));
  const f1 = factsAbout(even, "me", day(14));
  assert.ok(find(f1, "Your strongest day"));
  assert.equal(find(f1, "Your softest day"), undefined, "no gap, no complaint");
  // Two weeks where every Wednesday is a bad day.
  const wed = world([...Array(14).keys()].flatMap((n) => (n % 7 === 2 ? [log("steps", n, 500), log("sleep", n, 450), log("puffs", n, 10, SOURCE.MANUAL)] : fullDay(n))));
  const f2 = factsAbout(wed, "me", day(14));
  assert.match(find(f2, "Your softest day").text, /^Wednesdays — /);
});

test("the vape says how far the ceiling has come down", () => {
  const s = world([...Array(21).keys()].flatMap((n) => fullDay(n)));
  const facts = factsAbout(s, "me", day(21));
  assert.match(find(facts, "The vape").text, /Your ceiling has come down from 20 to \d+\./);
});

test("marathons are counted once there is one", () => {
  // 60,000 steps ≈ 45.7 km: one marathon.
  const s = world([0, 1, 2, 3, 4, 5].flatMap((n) => fullDay(n, 10000)));
  assert.match(find(factsAbout(s, "me", day(6)), "Distance walked").text, /, a marathon\./);
  // Two hundred thousand steps ≈ 152 km: several.
  const s2 = world([...Array(20).keys()].flatMap((n) => fullDay(n, 10000)));
  assert.match(find(factsAbout(s2, "me", day(20)), "Distance walked").text, /\d marathons\./);
});

test("every fact is an icon, a title and a sentence that ends", () => {
  const s = world([...Array(10).keys()].flatMap((n) => fullDay(n)));
  for (const f of factsAbout(s, "me", day(10))) {
    assert.ok(f.icon && f.title && f.text, JSON.stringify(f));
    assert.match(f.text, /\.$/, "ends with a full stop: " + f.text);
    assert.doesNotMatch(f.text, /\b1 days\b|\b1 nights\b|\b1 weeks\b/, "singular: " + f.text);
  }
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ facts: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ facts: " + passed + " tests passed");
