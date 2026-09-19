// today.test.mjs — the Today tab's data layer: how each habit is classified, and the active-day
// guard that stops a day-in-progress ever reading as a failure.
//
// These are the decisions the redesigned cards render. The archetype pick and the guard are the
// whole point — a steps card at noon must be "in progress", never a red miss; a ceiling that has
// been punched through must show it; and a zero on a vape tally is the perfect day, not an empty bar.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, AGGREGATE, PERIOD } from "../js/schema.js";
import { todayModel, layoutOf, isEvent, faceOf } from "../js/today.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const at = (d, h = 12) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd, h - 2); };
let seq = 0;
const E = (spec, ts) => ({ eventId: "e" + String(++seq).padStart(4, "0"), ts, seq, author: "me", ...spec });

// ---------------------------------------------------------------------------
// Classification — layoutOf / isEvent
// ---------------------------------------------------------------------------

const H = (o) => ({ habitId: "x", metric: METRIC.STEPS, direction: AT_LEAST, period: PERIOD.DAY, ...o });

test("frequency wins first: a weekly habit is a grid and a monthly one a gauge, whatever they measure", () => {
  assert.equal(layoutOf(H({ period: PERIOD.WEEK })), "week");
  assert.equal(layoutOf(H({ period: PERIOD.MONTH })), "month");
});

test("daily habits pick an archetype by direction and kind", () => {
  assert.equal(layoutOf(H({ metric: METRIC.STEPS, direction: AT_LEAST })), "accumulation");
  assert.equal(layoutOf(H({ metric: METRIC.SCREEN_MINUTES, direction: AT_MOST })), "ceiling");
  assert.equal(layoutOf(H({ metric: METRIC.PUFFS, direction: AT_MOST })), "event");
});

test("isEvent is a ceiling you tally, never a floor you sum up to", () => {
  assert.equal(isEvent(H({ metric: METRIC.PUFFS, direction: AT_MOST })), true, "puffs stay an event");
  assert.equal(isEvent(H({ metric: METRIC.AMOUNT, direction: AT_MOST, aggregate: AGGREGATE.SUM })), true, "a same-shaped urge tally too");
  assert.equal(isEvent(H({ metric: METRIC.AMOUNT, direction: AT_LEAST, aggregate: AGGREGATE.SUM })), false, "SUM building to a floor is accumulation, not abstinence");
  assert.equal(isEvent(H({ metric: METRIC.STEPS, direction: AT_LEAST })), false);
});

// ---------------------------------------------------------------------------
// The active-day guard — faceOf
// ---------------------------------------------------------------------------

test("an accumulation shortfall is never a failure while the day runs, only once it closes", () => {
  assert.deepEqual(faceOf("accumulation", 5000, 10000, true), { state: "in-progress", tone: "neutral" });
  assert.deepEqual(faceOf("accumulation", 10000, 10000, true), { state: "met", tone: "good" });
  assert.deepEqual(faceOf("accumulation", 5000, 10000, false), { state: "missed", tone: "bad" }, "a CLOSED unmet day is the only miss");
});

test("a ceiling is safe under the cap and a breach the moment it is punched through — even mid-day", () => {
  assert.deepEqual(faceOf("ceiling", 40, 60, true), { state: "safe", tone: "good" });
  assert.deepEqual(faceOf("ceiling", 60, 60, true), { state: "safe", tone: "good" }, "exactly at the cap is still safe");
  assert.deepEqual(faceOf("ceiling", 80, 60, true), { state: "over", tone: "bad" }, "over is a real, already-happened breach");
});

test("an event tally: zero is the clean perfect day; a log warns; over the ceiling is worse", () => {
  assert.deepEqual(faceOf("event", 0, 80, true), { state: "clean", tone: "good" });
  assert.deepEqual(faceOf("event", 5, 80, true), { state: "logged", tone: "warn" });
  assert.deepEqual(faceOf("event", 100, 80, true), { state: "logged", tone: "bad" });
});

// ---------------------------------------------------------------------------
// The whole model on a real replayed state
// ---------------------------------------------------------------------------

const TODAY = "2026-09-16"; // a Wednesday, in a 30-day month
function world({ noSavings = false } = {}) {
  seq = 0;
  const h = (id, o) => E(ev.habit(id, { name: id, tz: TZ, scored: true, period: PERIOD.DAY, ...o }), at("2026-09-01", 6));
  const evs = [
    E(ev.member("me", "Sam"), at("2026-09-01", 6)),
    h("steps", { metric: METRIC.STEPS, direction: AT_LEAST, target: 10000 }),
    h("screen", { metric: METRIC.SCREEN_MINUTES, direction: AT_MOST, target: 60 }),
    h("puffs", { metric: METRIC.PUFFS, direction: AT_MOST, target: 80 }),
    h("gym", { metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3, period: PERIOD.WEEK, aggregate: AGGREGATE.SUM }),
    h("save", { metric: METRIC.AMOUNT, direction: AT_LEAST, target: 15000, period: PERIOD.MONTH }),
    // today's readings
    E(ev.log("steps", "me", TODAY, 5000, SOURCE.HEALTH_CONNECT), at(TODAY)),
    E(ev.log("screen", "me", TODAY, 40, SOURCE.PAUSE), at(TODAY)),
    // no puffs log today → a clean zero
    // two of three workouts this week: Monday and today (Wednesday)
    E(ev.log("gym", "me", "2026-09-14", 1, SOURCE.HEALTH_CONNECT, "s1"), at("2026-09-14")),
    E(ev.log("gym", "me", TODAY, 1, SOURCE.HEALTH_CONNECT, "s2"), at(TODAY)),
    // a third of the monthly savings, on the 16th
    ...(noSavings ? [] : [E(ev.log("save", "me", TODAY, 5000, SOURCE.MANUAL), at(TODAY))]),
  ];
  return replay(evs);
}

const card = (m, id) => m.cards.find((c) => c.habitId === id);

test("accumulation card: climbing, neutral, with the space still to go", () => {
  const c = card(todayModel(world(), "me", TODAY), "steps");
  assert.equal(c.layout, "accumulation");
  assert.equal(c.state, "in-progress");
  assert.equal(c.tone, "neutral");
  assert.equal(c.value, 5000);
  assert.equal(c.toGo, 5000);
});

test("ceiling card: headroom is the number, safe while under the cap", () => {
  const c = card(todayModel(world(), "me", TODAY), "screen");
  assert.equal(c.layout, "ceiling");
  assert.equal(c.state, "safe");
  assert.equal(c.headroom, 20, "40 of a 60 cap leaves 20");
  assert.equal(c.over, false);
});

test("event card: no puffs logged is a clean day, not an empty bar", () => {
  const c = card(todayModel(world(), "me", TODAY), "puffs");
  assert.equal(c.layout, "event");
  assert.equal(c.state, "clean");
  assert.equal(c.incidents, 0);
});

test("week card: a 7-day grid, the right days lit, and it is not yet met", () => {
  const c = card(todayModel(world(), "me", TODAY), "gym");
  assert.equal(c.layout, "week");
  assert.equal(c.days.length, 7);
  assert.equal(c.days[0].label, "M");
  assert.equal(c.days[0].done, true, "Monday's session");
  assert.equal(c.days[2].done, true, "today's (Wednesday) session");
  assert.equal(c.days[2].isToday, true);
  assert.equal(c.days[1].done, false, "no Tuesday session");
  assert.equal(c.done, 2);
  assert.equal(c.need, 3);
  assert.equal(c.weekMet, false);
  assert.ok(typeof c.paceBy === "number", "a pace is offered while unmet");
});

test("week card: once the goal is met the pace prompt is suppressed", () => {
  // three sessions Mon/Tue/Wed — the weekly goal of three is met
  seq = 100;
  const evs2 = [
    E(ev.member("me", "Sam"), at("2026-09-01", 6)),
    E(ev.habit("gym", { name: "gym", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3, period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, tz: TZ, scored: true }), at("2026-09-01", 6)),
    E(ev.log("gym", "me", "2026-09-14", 1, SOURCE.HEALTH_CONNECT, "a"), at("2026-09-14")),
    E(ev.log("gym", "me", "2026-09-15", 1, SOURCE.HEALTH_CONNECT, "b"), at("2026-09-15")),
    E(ev.log("gym", "me", TODAY, 1, SOURCE.HEALTH_CONNECT, "c"), at(TODAY)),
  ];
  const c = card(todayModel(replay(evs2), "me", TODAY), "gym");
  assert.equal(c.weekMet, true);
  assert.equal(c.paceBy, null, "no conflicting 'N by tonight' once the week is won");
});

test("month card: how much of the target is in, where in the month we are, and whether anything is logged", () => {
  const c = card(todayModel(world(), "me", TODAY), "save");
  assert.equal(c.layout, "month");
  assert.equal(c.dayOfMonth, 16);
  assert.equal(c.daysInMonth, 30);
  assert.equal(c.filledPct, 33, "5000 of 15000");
  assert.equal(c.logged, true);
  assert.equal("pacePct" in c, false, "a month is not a pace any more, so the card carries none");
});

test("month card: an unlogged month says so, and the category still counts at zero", () => {
  const m = todayModel(world({ noSavings: true }), "me", TODAY);
  const c = card(m, "save");
  assert.equal(c.logged, false);
  assert.equal(c.filledPct, 0);
  const money = m.attributes.find((a) => a.category === "money");
  assert.ok(money, "Money is one of the day's categories from day one");
  assert.equal(money.points, 0);
  assert.ok(money.offered > 0);
});

test("hero: the away-XP micro-copy is the gap to a perfect day", () => {
  const m = todayModel(world(), "me", TODAY);
  assert.equal(m.hero.awayXp, 100 - m.hero.dayXp);
  assert.ok(m.hero.awayXp >= 0 && m.hero.awayXp <= 100);
});

test("attributes: only the categories that count today, none empty", () => {
  const m = todayModel(world(), "me", TODAY);
  assert.ok(m.attributes.every((a) => a.offered > 0), "no zero-share rows clutter the overview");
});

test("attributes: the rows add up to the hero, and the to-go on each row adds up to the gap", () => {
  const m = todayModel(world(), "me", TODAY);
  const offered = m.attributes.reduce((s, a) => s + a.offered, 0);
  const points = m.attributes.reduce((s, a) => s + a.points, 0);
  assert.equal(offered, 100, "the shares are the hundred the day is worth");
  assert.equal(points, m.hero.dayXp, "the category points sum to the headline — 47 + 20 + 17 under an 83 is the bug");
  assert.equal(offered - points, m.hero.awayXp, "so the per-row 'to go' sums to 'away from a perfect day'");
  assert.ok(m.attributes.every((a) => a.points <= a.offered), "never '47 of 46'");
  assert.ok(m.attributes.every((a) => Number.isInteger(a.points) && Number.isInteger(a.offered)));
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ today (data layer): " + passed + " tests passed");
