// activity.test.mjs — the Board's activity feed, as data.
//
// The feed shipped shuffled because it trusted the event array to be newest-first when it is stored
// in random (eventId) order. These tests hand activityItems a deliberately scrambled array and
// prove it orders itself by the day a thing is about; that "highlights only" keeps met days,
// manual logs, workouts and goal changes while dropping routine un-met sensor readings; that a day
// is one line, not one per write; and that feedDayLabel never shows two indistinguishable days.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, PERIOD } from "../js/schema.js";
import { activityItems } from "../js/activity.js";
import { feedDayLabel } from "../js/ui/format.js";

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

function world() {
  seq = 0;
  const evs = [
    E(ev.member("a", "Sahil"), at(D0, 6)),
    E(ev.member("b", "Ivan"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 5000, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.habit("vape", { name: "Vape urges", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.habit("gym", { name: "Workouts", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3, period: PERIOD.WEEK, tz: TZ }), at(D0, 6)),
    // steps: a met day (day 5), and a routine un-met partial (day 6)
    E(ev.log("steps", "a", day(5), 8000, SOURCE.HEALTH_CONNECT), at(day(5))),
    E(ev.log("steps", "a", day(6), 78, SOURCE.HEALTH_CONNECT), at(day(6))),
    // a manual vape log that MISSES its ceiling — still news, because it was a deliberate act
    E(ev.log("vape", "a", day(7), 200, SOURCE.MANUAL), at(day(7))),
    // a watch-detected workout: automatic, one-of-three so the week is not met, but a workout is news
    E(ev.log("gym", "a", day(4), 1, SOURCE.HEALTH_CONNECT, "hc-1"), at(day(4))),
    // a goal change
    E(ev.goal("a", "steps", { target: 6000 }), at(day(8), 9)),
  ];
  return evs;
}

const me = "a";

test("the feed orders itself by day, newest first, however the events were stored", () => {
  const evs = world();
  const state = replay(evs);
  // Hand it the events in a deliberately scrambled order — the bug was trusting this order.
  const scrambled = [...evs].sort(() => Math.random() - 0.5);
  const items = activityItems({ events: scrambled, state, me }, 10);
  const days = items.map((i) => i.day);
  const sorted = [...days].sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
  assert.deepEqual(days, sorted, "feed is not in newest-day-first order");
});

test("highlights only: met sensor day, manual log, workout and goal change are in; an un-met partial is out", () => {
  const evs = world();
  const state = replay(evs);
  const items = activityItems({ events: evs, state, me }, 20);
  const has = (kind, habitId, d) => items.some((i) => i.kind === kind && i.habitId === habitId && i.day === d);
  assert.ok(has("log", "steps", day(5)), "the met step day should show");
  assert.ok(!items.some((i) => i.habitId === "steps" && i.day === day(6)), "the 78-step partial should be dropped");
  assert.ok(has("log", "vape", day(7)), "a manual log shows even when it misses");
  assert.ok(has("log", "gym", day(4)), "a workout shows even though it did not meet the weekly goal alone");
  assert.ok(has("goal", "steps", day(8)), "a goal change shows");
});

test("the met flag rides only the days that met — the ✓ is earned", () => {
  const evs = world();
  const state = replay(evs);
  const items = activityItems({ events: evs, state, me }, 20);
  assert.equal(items.find((i) => i.habitId === "steps" && i.day === day(5)).met, true);
  assert.equal(items.find((i) => i.habitId === "vape" && i.day === day(7)).met, false, "over the ceiling is not met");
});

test("one line per person-habit-day: the latest write wins, not every tick", () => {
  const evs = world();
  evs.push(E(ev.log("steps", "a", day(5), 8500, SOURCE.HEALTH_CONNECT), at(day(5)) + 3600_000)); // a later, higher read
  const state = replay(evs);
  const items = activityItems({ events: evs, state, me }, 20);
  const stepFives = items.filter((i) => i.habitId === "steps" && i.day === day(5));
  assert.equal(stepFives.length, 1, "the day appears once, not per reading");
  assert.equal(stepFives[0].value, 8500, "and carries the latest value");
});

test("another member's private number is withheld, but their highlight still appears", () => {
  const evs = world();
  // Ivan logs a met step day but keeps his numbers private
  evs.push(E(ev.log("steps", "b", day(5), 9000, SOURCE.HEALTH_CONNECT), at(day(5))));
  evs.push(E(ev.goal("b", "steps", { visibility: "private" }), at(D0, 7)));
  const state = replay(evs);
  const items = activityItems({ events: evs, state, me }, 20);
  const ivan = items.find((i) => i.memberId === "b" && i.habitId === "steps" && i.day === day(5));
  assert.ok(ivan, "Ivan's met day is still on the feed");
  assert.equal(ivan.value, null, "but his number is withheld");
});

test("feedDayLabel is unambiguous: today, yesterday, a weekday inside the week, a dated one past it", () => {
  const today = "2026-09-18"; // a Friday
  assert.equal(feedDayLabel("2026-09-18", today), "today");
  assert.equal(feedDayLabel("2026-09-17", today), "yesterday");
  assert.equal(feedDayLabel("2026-09-14", today), "Mon");            // 4 days back — weekday alone is clear
  const old = feedDayLabel("2026-09-05", today);                     // 13 days back — must carry a date
  assert.ok(/\d/.test(old), "a day older than a week must be dated, not a bare weekday: " + old);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ activity feed: " + passed + " tests passed");
