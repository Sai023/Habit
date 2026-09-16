// facts-patterns.test.mjs — the read-model-backed Insights facts ("Worth noticing", "A day to
// watch") fire in a designed month and word themselves correctly.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, PERIOD, AGGREGATE } from "../js/schema.js";
import { factsAbout } from "../js/facts.js";

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
const E = (spec, ts) => ({ eventId: "e" + String(++seq).padStart(4, "0"), ts, seq, author: "m1", ...spec });
const MISS = new Set([2, 4, 9, 11, 18]); // Wed/Fri misses — Fridays are the weak weekday

function month() {
  seq = 0;
  const events = [
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, period: PERIOD.DAY, aggregate: AGGREGATE.LAST, tz: TZ }), at(D0, 6)),
    E(ev.habit("puffs", { name: "Vape", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, aggregate: AGGREGATE.SUM, tz: TZ }), at(D0, 6)),
  ];
  for (let n = 0; n < 21; n += 1) {
    const miss = MISS.has(n);
    events.push(E(ev.log("steps", "m1", day(n), miss ? 6000 : 12000, SOURCE.MANUAL), at(day(n))));
    events.push(E(ev.log("puffs", "m1", day(n), miss ? 90 : 40, SOURCE.MANUAL), at(day(n))));
  }
  return replay(events);
}

test("'Worth noticing' surfaces the strongest behavioural link, worded as an improvement", () => {
  const facts = factsAbout(month(), "m1", day(20));
  const f = facts.find((x) => x.title === "Worth noticing");
  assert.ok(f, "the pattern fires with a full month of varied data");
  assert.match(f.text, /On the \d+ days you/);
  assert.match(f.text, /than the \d+ days you didn't\.$/);
});

test("'A day to watch' names the weak weekday", () => {
  const facts = factsAbout(month(), "m1", day(20));
  const f = facts.find((x) => x.title === "A day to watch");
  assert.ok(f, "a wide weekday gap fires the pattern");
  assert.match(f.text, /slips on Fridays/);
  assert.match(f.text, /\.$/);
});

test("neither pattern fires on a week of flat, too-short data", () => {
  seq = 0;
  const events = [
    E(ev.member("m1", "Sahil"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
  ];
  for (let n = 0; n < 7; n += 1) events.push(E(ev.log("steps", "m1", day(n), 12000, SOURCE.MANUAL), at(day(n))));
  const facts = factsAbout(replay(events), "m1", day(7));
  assert.equal(facts.find((x) => x.title === "Worth noticing"), undefined);
  assert.equal(facts.find((x) => x.title === "A day to watch"), undefined);
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ insights patterns: " + passed + " tests passed");
