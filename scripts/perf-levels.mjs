// perf-levels.mjs — time lifetime() at two years of three people. Run: node scripts/perf-levels.mjs
// Time lifetime() at real scale: 3 members, 6 habits, 2 years of daily logs.
import { replay, addDays } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, AGGREGATE, PERIOD } from "../js/schema.js";
import { lifetime, levelFor, thresholdFor } from "../js/levels.js";

const TZ = "Africa/Johannesburg";
const START = "2024-09-02";
const DAYS = 730;
const day = (n) => addDays(START, n);
const at = (n, h = 12) => Date.parse(day(n) + "T" + String(h).padStart(2, "0") + ":00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "p" + ++seq, ts, seq, ...spec });

const events = [
  E(ev.meta({ tz: TZ, name: "Perf" }), at(0)),
  E(ev.member("a", "Sahil"), at(0)), E(ev.member("b", "Ivan"), at(0)), E(ev.member("c", "Anj"), at(0)),
  E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 8000, aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT, tz: TZ, dayStartHour: 4, period: PERIOD.DAY }), at(0)),
  E(ev.habit("sleep", { name: "Sleep", metric: METRIC.SLEEP, direction: AT_LEAST, target: 420, aggregate: AGGREGATE.LAST, source: SOURCE.HEALTH_CONNECT, tz: TZ, dayStartHour: 4, period: PERIOD.DAY }), at(0)),
  E(ev.habit("puffs", { name: "Vape", metric: METRIC.PUFFS, direction: AT_MOST, target: 20, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4, period: PERIOD.DAY, taper: { amount: 1, everyDays: 7, floor: 0 } }), at(0)),
  E(ev.habit("screen", { name: "Locked apps", metric: METRIC.SCREEN_MINUTES, direction: AT_MOST, target: 90, aggregate: AGGREGATE.LAST, source: SOURCE.PAUSE, tz: TZ, dayStartHour: 4, period: PERIOD.DAY }), at(0)),
  E(ev.habit("work", { name: "Workouts", metric: METRIC.SESSIONS, direction: AT_LEAST, target: 3, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4, period: PERIOD.WEEK }), at(0)),
  E(ev.habit("money", { name: "Money", metric: METRIC.MONEY, direction: AT_LEAST, target: 5000, aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4, period: PERIOD.MONTH }), at(0)),
];
for (const m of ["a", "b", "c"]) {
  for (const h of ["steps", "sleep", "puffs", "screen", "work", "money"]) events.push(E(ev.bind(m, h, h === "steps" || h === "sleep" ? SOURCE.HEALTH_CONNECT : h === "screen" ? SOURCE.PAUSE : SOURCE.MANUAL), at(0)));
}
for (let n = 0; n < DAYS; n += 1) {
  for (const m of ["a", "b", "c"]) {
    if ((n + m.charCodeAt(0)) % 9 === 0) continue; // an unreported day now and then
    events.push(E(ev.log("steps", m, day(n), 6000 + ((n * 37 + m.charCodeAt(0)) % 6000), SOURCE.HEALTH_CONNECT), at(n, 20)));
    events.push(E(ev.log("sleep", m, day(n), 380 + ((n * 13) % 120), SOURCE.HEALTH_CONNECT), at(n, 8)));
    events.push(E(ev.log("puffs", m, day(n), (n * 7 + m.charCodeAt(0)) % 25, SOURCE.MANUAL), at(n, 21)));
    events.push(E(ev.log("screen", m, day(n), 40 + ((n * 11) % 80), SOURCE.PAUSE), at(n, 22)));
    if (n % 2 === 0) events.push(E(ev.log("work", m, day(n), 1, SOURCE.MANUAL), at(n, 18)));
    if (n % 30 === 25) events.push(E(ev.log("money", m, day(n), 6000, SOURCE.MANUAL), at(n, 18)));
  }
}
console.log("events:", events.length);
let t = performance.now();
const state = replay(events);
console.log("replay ms:", (performance.now() - t).toFixed(0));

const today = day(DAYS);
for (const pass of [1, 2]) {
  t = performance.now();
  const out = ["a", "b", "c"].map((m) => lifetime(state, m, today));
  const ms = performance.now() - t;
  console.log(`pass ${pass}: lifetime × 3 members = ${ms.toFixed(0)} ms`, out.map((o) => `L${o.level} ${o.title} ${o.banked} xp, ${o.days} days, today +${o.today}`));
  if (pass === 1) globalThis.__first = out;
}
// repeat reads must match — the perf probe once caught a cache bug exactly here
const again = ["a", "b", "c"].map((m) => lifetime(state, m, today));
console.log("repeat matches:", JSON.stringify(again) === JSON.stringify(globalThis.__first));
console.log("thresholds L2/L10/L20/L50/L100:", [2, 10, 20, 50, 100].map(thresholdFor).join(" / "));
console.log("levelFor(150975):", levelFor(150975).level, levelFor(150975).max, "levelFor(299):", levelFor(299).level, "levelFor(300):", levelFor(300).level);
