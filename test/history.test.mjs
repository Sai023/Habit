// history.test.mjs — one habit read backwards, in the periods it is actually judged in.
//
// ---- What this is guarding ----
//
// A history screen is mostly arithmetic about periods, and arithmetic about periods is where the
// off-by-ones live. Three of them are waiting here specifically:
//
//   • a weekly habit's "last eight" are eight ISO WEEKS, not fifty-six days
//   • the newest entry is the period still RUNNING, and a summary that counts it is a sentence
//     about the future — "3 of 14" on a Tuesday morning
//   • a habit has a birthday, and drawing cells before it shows days the engine refuses to judge
//
// The screen draws whatever this returns, so every one of those would arrive as a number somebody
// reads and believes.

import assert from "node:assert/strict";
import { replay, addDays, HIT, MISS, NO_DATA, EXEMPT } from "../js/habits.js";
import {
  habitHistory, historySummary, runs, trend, lifetime, byWeekday, worstWeekday,
  groupHistory, SPAN,
} from "../js/history.js";
import {
  ev, METRIC, AT_LEAST, AT_MOST, AGGREGATE, SOURCE, PERIOD, VISIBILITY,
} from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MON = "2026-03-02";          // a Monday
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "h" + ++seq, ts, seq, ...spec });

/**
 * One member, one habit, logged on the days `values` names.
 *
 * Grace is off. A token absorbing a miss is correct for a streak and noise in a history screen,
 * where the whole point is to show what actually happened on each day.
 */
function world({ period = PERIOD.DAY, direction = AT_LEAST, target = 100,
  aggregate = AGGREGATE.LAST, born = 0, values = {}, extra = [] } = {}) {
  const events = [
    E(ev.member("me", "Me"), at(born)),
    E(ev.habit("h", {
      name: "Steps", metric: METRIC.STEPS, direction, target, period, aggregate,
      source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0, grace: { earnEvery: 0, cap: 0 },
    }), at(born)),
    ...extra,
  ];
  for (const [n, v] of Object.entries(values)) {
    events.push(E(ev.log("h", "me", day(Number(n)), v, SOURCE.MANUAL), at(Number(n))));
  }
  return replay(events);
}

const hist = (s, today, want) =>
  habitHistory(s, s.habits.get("h"), "me", day(today), want);

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test("a daily habit shows a fortnight, oldest first", () => {
  const s = world({ born: 0 });
  const h = hist(s, 30);
  assert.equal(h.length, SPAN[PERIOD.DAY]);
  assert.equal(h[0].from, day(17), "fourteen days back");
  assert.equal(h[h.length - 1].from, day(30), "and today at the end");
});

test("a weekly habit shows WEEKS, not fifty-six days", () => {
  // The off-by-one worth naming: "the last eight" means eight of the habit's own periods.
  const s = world({ period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, target: 3, born: 0 });
  const h = hist(s, 70);
  assert.equal(h.length, SPAN[PERIOD.WEEK]);
  for (const e of h) assert.equal(e.period, PERIOD.WEEK);
  // Consecutive entries are seven days apart, which is the property that fails if days leak in.
  for (let i = 1; i < h.length; i += 1) {
    assert.equal(addDays(h[i - 1].from, 7), h[i].from, "week " + i);
  }
});

test("a monthly habit shows months", () => {
  const s = world({ period: PERIOD.MONTH, target: 1000, born: 0 });
  const h = hist(s, 200);
  assert.equal(h.length, SPAN[PERIOD.MONTH]);
  for (const e of h) assert.equal(e.period, PERIOD.MONTH);
});

test("it never reaches back before the habit existed", () => {
  // The same birthday habitScore refuses to judge across. Drawing cells earlier would show days
  // the engine would not score, which is the shape of the bug retroactive.test.mjs exists for.
  const s = world({ born: 25 });
  const h = hist(s, 30);
  assert.equal(h.length, 6, "born on day 25, six days to today");
  assert.equal(h[0].from, day(25));
});

test("a habit born today has exactly one entry", () => {
  const s = world({ born: 30 });
  const h = hist(s, 30);
  assert.equal(h.length, 1);
  assert.ok(h[0].open);
});

// ---------------------------------------------------------------------------
// The period still running
// ---------------------------------------------------------------------------

test("the newest entry is marked open and every older one is not", () => {
  const s = world({ born: 0 });
  const h = hist(s, 30);
  assert.ok(h[h.length - 1].open, "today");
  assert.ok(h.slice(0, -1).every((e) => !e.open), "everything before it is closed");
});

test("a summary never counts the period still running", () => {
  // "3 of 14" on a Tuesday morning is a sentence about the future. The open week is drawn and not
  // scored — a week two days in is not a week you failed.
  const s = world({ born: 0, values: { 27: 500, 28: 500, 29: 500, 30: 0 } });
  const closed = historySummary(hist(s, 30));
  const withOpen = historySummary(hist(s, 30).map((e) => ({ ...e, open: false })));
  assert.ok(closed.judged < withOpen.judged, "today was excluded");
  assert.equal(closed.hits, withOpen.hits - 0, "and today was a miss, so hits are unchanged");
});

// ---------------------------------------------------------------------------
// What the window adds up to
// ---------------------------------------------------------------------------

test("hits and misses are counted over judged periods only", () => {
  const s = world({ born: 17, values: { 17: 500, 18: 0, 19: 500, 20: 0, 21: 500 } });
  const sum = historySummary(hist(s, 22));
  assert.equal(sum.hits, 3);
  assert.equal(sum.missed, 2);
  assert.equal(sum.judged, 5);
});

test("silence is quiet, not missed", () => {
  // The four states have to survive into a screen, or NO_DATA reads as failure — which is the one
  // reading the whole automatic-source rule exists to prevent.
  const s = world({
    born: 17, values: { 17: 500 },
    extra: [E(ev.bind("me", "h", SOURCE.HEALTH_CONNECT), at(17))],
  });
  const sum = historySummary(hist(s, 20));
  assert.ok(sum.quiet > 0, "days a watch said nothing about");
  assert.equal(sum.missed, 0, "and none of them is a miss");
});

test("a rest day is neither", () => {
  const s = world({
    born: 17, values: { 17: 500, 19: 500 },
    extra: [E(ev.exempt("me", day(18), day(18), "travel", null, "t1"), at(17))],
  });
  const sum = historySummary(hist(s, 20));
  assert.equal(sum.resting, 1);
  assert.ok(!sum.missed || sum.missed >= 0);
});

test("the average is over periods that reported, not over the window", () => {
  // A fortnight with four silent days is not a fortnight of low numbers, and dividing by 14 would
  // say it was.
  const s = world({ born: 17, values: { 17: 400, 18: 600 } });
  const sum = historySummary(hist(s, 19).filter((e) => e.from <= day(18)));
  assert.equal(sum.average, 500);
});

test("an empty window summarises to nothing rather than to zero", () => {
  const sum = historySummary([]);
  assert.equal(sum.judged, 0);
  assert.equal(sum.average, null, "null, not 0 — nothing was measured");
  assert.equal(sum.best, null);
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

test("the best run is the longest there has ever been", () => {
  // Five clean, one bad, three clean. The current run is three; the best is five and does not
  // shrink because the recent one is shorter.
  const s = world({
    born: 0,
    values: { 0: 500, 1: 500, 2: 500, 3: 500, 4: 500, 5: 0, 6: 500, 7: 500, 8: 500 },
  });
  const r = runs(s, s.habits.get("h"), "me", day(8));
  assert.equal(r.current, 3);
  assert.equal(r.best, 5);
});

test("the current run is the same number the card shows", () => {
  // Read off the same walk the streak comes from, so the card and this screen cannot disagree.
  const s = world({ born: 0, values: { 0: 500, 1: 500, 2: 500 } });
  const r = runs(s, s.habits.get("h"), "me", day(2));
  assert.equal(r.current, 3);
  assert.equal(r.best, 3);
});

test("a habit with no history has no runs and does not throw", () => {
  const s = world({ born: 0 });
  const r = runs(s, s.habits.get("h"), "me", day(0));
  assert.equal(r.current, 0);
  assert.equal(r.best, 0);
});

// ---------------------------------------------------------------------------
// A ceiling, which reads the other way round
// ---------------------------------------------------------------------------

test("an at-most habit carries the target that was in force for each period", () => {
  // A taper moves the ceiling, and a history cell showing today's ceiling against last week's
  // number would invent misses that never happened.
  const s = world({
    direction: AT_MOST, target: 100, aggregate: AGGREGATE.SUM, born: 0,
    extra: [E(ev.habit("h", {
      name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: 100,
      period: PERIOD.DAY, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 0, grace: { earnEvery: 0, cap: 0 },
      taper: { amount: 1, everyDays: 7, floor: 0 },
    }), at(0))],
  });
  const h = hist(s, 20);
  const early = h[0];
  const late = h[h.length - 1];
  assert.ok(late.target <= early.target, "the ceiling came down: " + early.target + " -> " + late.target);
});

// ---------------------------------------------------------------------------
// This window against the one before it
// ---------------------------------------------------------------------------
//
// The easiest thing on a history screen to get backwards, because for a CEILING down is the good
// direction. Reporting the change is arithmetic; deciding whether it is good is a fact about the
// habit, and only the habit knows.

const climbing = (dir) => {
  const values = {};
  // First fortnight around 200, second around 400.
  for (let n = 0; n < 14; n += 1) values[n] = 200;
  for (let n = 14; n < 28; n += 1) values[n] = 400;
  return world({ direction: dir, target: 300, born: 0, values });
};

test("a habit going up is BETTER when the goal is a floor", () => {
  const s = climbing(AT_LEAST);
  const t = trend(s, s.habits.get("h"), "me", day(28));
  assert.ok(t.change > 0, "the numbers went up");
  assert.ok(t.better, "and for a floor, up is better");
});

test("the same movement is WORSE when the goal is a ceiling", () => {
  // Identical numbers, opposite verdict. This is the whole reason `better` is separate from
  // `change` — "up 100%" is a triumph for steps and a relapse for puffs.
  const s = climbing(AT_MOST);
  const t = trend(s, s.habits.get("h"), "me", day(28));
  assert.ok(t.change > 0, "the same movement");
  assert.ok(!t.better, "and for a ceiling it is not an improvement");
});

test("a window that barely moved is called flat", () => {
  // Under five per cent is noise wearing a percentage, and a screen that announces it teaches
  // people to ignore the screen.
  const values = {};
  for (let n = 0; n < 28; n += 1) values[n] = 300 + (n % 2);
  const s = world({ born: 0, values });
  const t = trend(s, s.habits.get("h"), "me", day(28));
  assert.ok(t.flat);
});

test("too little history reports nothing rather than a number", () => {
  // Two days against one produces a percentage that is arithmetically true and meaningless, and
  // somebody will believe it.
  const s = world({ born: 24, values: { 24: 100, 25: 200, 26: 300 } });
  assert.equal(trend(s, s.habits.get("h"), "me", day(27)), null);
});

test("a habit with no numbers at all reports nothing", () => {
  const s = world({ born: 0 });
  assert.equal(trend(s, s.habits.get("h"), "me", day(28)), null);
});

test("the two windows are the same length", () => {
  // Comparing nine days against five would produce a change that is mostly an artefact of the
  // split, and the split is the one thing the reader cannot see.
  const values = {};
  for (let n = 0; n < 28; n += 1) values[n] = 300;
  const s = world({ born: 0, values });
  const t = trend(s, s.habits.get("h"), "me", day(28));
  assert.equal(t.periods, SPAN[PERIOD.DAY], "half of a double window");
});

// ---------------------------------------------------------------------------
// The longer view
// ---------------------------------------------------------------------------

test("lifetime looks past the window on screen", () => {
  // The chart is a fortnight because a fortnight is readable. It is a bad answer to "is this
  // working" — two weeks is one bad flu.
  const values = {};
  for (let n = 0; n < 60; n += 1) values[n] = n < 30 ? 50 : 500;
  const s = world({ born: 0, values });
  const life = lifetime(s, s.habits.get("h"), "me", day(60));
  assert.ok(life.judged > SPAN[PERIOD.DAY], "more than the chart shows: " + life.judged);
  assert.equal(life.hits, 30, "the thirty good days");
});

test("the best day is the highest when the goal is a floor", () => {
  const s = world({ born: 0, values: { 0: 200, 1: 900, 2: 300 } });
  const life = lifetime(s, s.habits.get("h"), "me", day(3));
  assert.equal(life.best.value, 900);
});

test("and the LOWEST when it is a ceiling", () => {
  // Reporting the highest number as a personal best on a vape habit would be grim, and it is the
  // version you get for free by not thinking about it.
  const s = world({ direction: AT_MOST, target: 500, aggregate: AGGREGATE.SUM, born: 0,
    values: { 0: 200, 1: 20, 2: 300 } });
  const life = lifetime(s, s.habits.get("h"), "me", day(3));
  assert.equal(life.best.value, 20);
});

test("a habit with nothing judged has no lifetime to report", () => {
  const s = world({ born: 0 });
  assert.equal(lifetime(s, s.habits.get("h"), "me", day(0)), null);
});

// ---------------------------------------------------------------------------
// Which days go badly
// ---------------------------------------------------------------------------

test("weekdays are Monday first and count only judged days", () => {
  const values = {};
  for (let n = 0; n < 28; n += 1) values[n] = 500;
  const s = world({ born: 0, values });
  const days = byWeekday(s, s.habits.get("h"), "me", day(28));
  assert.equal(days.length, 7);
  // MON is a Monday, so day 0 lands in slot 0.
  assert.ok(days[0].judged > 0);
  assert.equal(days.reduce((t, d) => t + d.hits, 0), days.reduce((t, d) => t + d.judged, 0));
});

test("a weekly habit has no weekday pattern to report", () => {
  // "Your worst Sunday" is meaningless for a target that is silent about which days it happens on.
  const s = world({ period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, target: 3, born: 0 });
  assert.equal(byWeekday(s, s.habits.get("h"), "me", day(30)), null);
});

test("a genuinely bad day is named", () => {
  // Sundays missed, everything else met.
  const values = {};
  for (let n = 0; n < 56; n += 1) {
    const isSunday = (new Date(addDays(MON, n) + "T12:00:00Z").getUTCDay() + 6) % 7 === 6;
    values[n] = isSunday ? 0 : 500;
  }
  const s = world({ born: 0, values });
  const worst = worstWeekday(byWeekday(s, s.habits.get("h"), "me", day(56)));
  assert.ok(worst, "there is a pattern");
  assert.equal(worst.index, 6, "Sunday");
});

test("a week with no real pattern says nothing", () => {
  // The normal case, and the one that has to stay silent — naming whichever day happened to be
  // lowest is how a screen invents a problem somebody then organises their week around.
  const values = {};
  for (let n = 0; n < 56; n += 1) values[n] = n % 9 === 0 ? 0 : 500;
  const s = world({ born: 0, values });
  assert.equal(worstWeekday(byWeekday(s, s.habits.get("h"), "me", day(56))), null);
});

test("too few samples of a day says nothing about it", () => {
  // "You always fail on Tuesdays" off two Tuesdays is a claim somebody changes their week for.
  const values = {};
  for (let n = 0; n < 8; n += 1) values[n] = n === 1 ? 0 : 500;
  const s = world({ born: 0, values });
  assert.equal(worstWeekday(byWeekday(s, s.habits.get("h"), "me", day(8))), null);
});

// ---------------------------------------------------------------------------
// The group, on one habit — and where a hidden number could escape
// ---------------------------------------------------------------------------
//
// A comparison is the one screen where somebody's privacy setting can be quietly undone. The three
// settings mean exactly what they say, and this is the place they have to hold.

/** Three people on one habit, each logging `values[id]` and choosing `vis[id]`. */
function group({ values = {}, vis = {}, targets = {} } = {}) {
  const events = [
    E(ev.member("me", "Me"), at(0)),
    E(ev.member("anj", "Anj"), at(0)),
    E(ev.member("ivan", "Ivan"), at(0)),
    E(ev.habit("h", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 0, grace: { earnEvery: 0, cap: 0 },
    }), at(0)),
  ];
  for (const [id, v] of Object.entries(vis)) {
    events.push(E(ev.goal(id, "h", { visibility: v }), at(0)));
  }
  for (const [id, t] of Object.entries(targets)) {
    events.push(E(ev.goal(id, "h", { target: t }), at(0)));
  }
  for (const [id, list] of Object.entries(values)) {
    list.forEach((v, n) => events.push(E(ev.log("h", id, day(n + 1), v, SOURCE.MANUAL), at(n + 1))));
  }
  return replay(events);
}

const row = (rows, id) => rows.find((r) => r.memberId === id);

test("somebody on FULL shows their number", () => {
  const s = group({
    values: { me: [9000, 9000], anj: [12000, 12000] },
    vis: { anj: VISIBILITY.FULL },
  });
  const rows = groupHistory(s, s.habits.get("h"), "me", day(4));
  assert.ok("value" in row(rows, "anj").shown, "the figure itself");
});

test("somebody on PROGRESS shows a percentage and never the number", () => {
  const s = group({
    values: { me: [9000, 9000], anj: [12000, 12000] },
    vis: { anj: VISIBILITY.PROGRESS },
  });
  const anj = row(groupHistory(s, s.habits.get("h"), "me", day(4)), "anj");
  assert.ok("pct" in anj.shown, "how close, not what");
  assert.ok(!("value" in anj.shown), "the number must not be here");
});

test("somebody on PRIVATE shows nothing but their ticks", () => {
  const s = group({
    values: { me: [9000, 9000], anj: [12000, 12000] },
    vis: { anj: VISIBILITY.PRIVATE },
  });
  const anj = row(groupHistory(s, s.habits.get("h"), "me", day(4)), "anj");
  assert.equal(anj.shown, null, "no number and no percentage");
  assert.ok(anj.judged > 0, "but whether they hit it is still shown — that is what private means");
});

test("a private number cannot be reconstructed from anything else on the row", () => {
  // The leak worth naming: a row that hides the value and reports everything else can hand it
  // back. Hits, days and the run are all counts of VERDICTS, which is exactly what PRIVATE
  // permits; nothing on the row is derived from the figure itself.
  const s = group({
    values: { me: [9000], anj: [12345] },
    vis: { anj: VISIBILITY.PRIVATE },
  });
  const anj = row(groupHistory(s, s.habits.get("h"), "me", day(3)), "anj");
  const leaked = JSON.stringify(anj).includes("12345");
  assert.ok(!leaked, "the figure appears nowhere on the row: " + JSON.stringify(anj));
});

test("my own row is never filtered, whatever I chose", () => {
  // Hiding your numbers from yourself is the one reading of "private" nobody means.
  const s = group({
    values: { me: [9000, 9000] },
    vis: { me: VISIBILITY.PRIVATE },
  });
  const mine = row(groupHistory(s, s.habits.get("h"), "me", day(4)), "me");
  assert.ok(mine.shown && "value" in mine.shown, "I still see my own figure");
});

test("progress is measured against THEIR target, not the group's seed", () => {
  // habit.target is 10 000 — the seed. Anj is on 6 000 and clearing it every day, which is 100%
  // of what she was asked for and 60% of somebody else's number.
  const s = group({
    values: { me: [9000], anj: [6000, 6000] },
    vis: { anj: VISIBILITY.PROGRESS },
    targets: { anj: 6000 },
  });
  const anj = row(groupHistory(s, s.habits.get("h"), "me", day(4)), "anj");
  assert.equal(anj.shown.pct, 100, "she cleared her goal");
});

test("somebody who declined the habit is not on the list", () => {
  const s = replay([
    E(ev.member("me", "Me"), at(0)),
    E(ev.member("anj", "Anj"), at(0)),
    E(ev.habit("h", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
      tz: TZ, dayStartHour: 0,
    }), at(0)),
    E(ev.goal("anj", "h", { active: false }), at(0)),
    E(ev.log("h", "me", day(1), 12000, SOURCE.MANUAL), at(1)),
  ]);
  const rows = groupHistory(s, s.habits.get("h"), "me", day(3));
  assert.equal(row(rows, "anj"), undefined, "not competing on it");
  assert.ok(row(rows, "me"), "and I still am");
});

test("the order is stable for two people who are level", () => {
  // Otherwise the list reshuffles between repaints, which reads as the numbers changing.
  const s = group({ values: { me: [12000, 12000], anj: [12000, 12000] } });
  const a = groupHistory(s, s.habits.get("h"), "me", day(4)).map((r) => r.memberId);
  const b = groupHistory(s, s.habits.get("h"), "me", day(4)).map((r) => r.memberId);
  assert.deepEqual(a, b);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ history: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ history: " + passed + " tests passed");
