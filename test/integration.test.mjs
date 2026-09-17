// integration.test.mjs — the seams between the data-layer waves, where this codebase's bugs live.
//
// The unit suites each prove one wave. This proves they COMPOSE: a merge, an exclusion, a unit
// change and mixed provenance in one replay; that validation mirrors the reducer exactly (never
// stricter); that replay is deterministic and the read-model is a pure function of state; and that
// a batch of poison events cannot derail a replay.

import assert from "node:assert/strict";
import { replay, valueOn, canonicalMember, isExcluded, addDays } from "../js/habits.js";
import { ev, SOURCE, METRIC, AT_LEAST, AT_MOST, PERIOD, T, validate } from "../js/schema.js";
import { dailyFacts, consistency } from "../js/dailyfacts.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const D0 = "2026-03-02";
const day = (n) => addDays(D0, n);
const at = (d, h = 20) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd, h - 2); };
let seq = 0;
const E = (spec, ts) => ({ eventId: "e" + String(++seq).padStart(4, "0"), ts, seq, author: "a", ...spec });
const H = (s, id) => s.habits.get(id);

// ---------------------------------------------------------------------------
// validation mirrors the reducer — never stricter (the regression the audit caught)
// ---------------------------------------------------------------------------

test("a log the reducer would skip, validate also rejects — and nothing else", () => {
  seq = 0;
  const habit = E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 1, period: PERIOD.DAY, tz: TZ }), at(D0, 6));
  const noHabit = { eventId: "x1", ts: at(day(0)), seq: 50, author: "a", type: T.LOG, payload: { v: 1, memberId: "m1", day: day(0), value: 5 } };
  assert.equal(validate(T.LOG, noHabit.payload), false, "no habitId → rejected");
  const s = replay([E(ev.member("m1", "M"), at(D0, 6)), habit, noHabit]);
  assert.equal(s.logs.size, 0, "and the reducer never stored it either — they agree");
});

test("a value-less log is accepted by both reducer and validate (coerced to 0), not dropped", () => {
  seq = 0;
  const raw = { eventId: "x2", ts: at(day(0)), seq: 60, author: "m1", type: T.LOG, payload: { v: 1, habitId: "steps", memberId: "m1", day: day(0), source: "manual" } };
  assert.equal(validate(T.LOG, raw.payload), true, "validate must not be stricter than the reducer on value");
  const s = replay([
    E(ev.member("m1", "M"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 1, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    raw,
  ]);
  assert.equal(valueOn(s, H(s, "steps"), "m1", day(0)), 0, "stored as a logged zero, same as the reducer");
});

// ---------------------------------------------------------------------------
// all four waves compose in one replay
// ---------------------------------------------------------------------------

test("merge × exclusion × unit-change × provenance compose without interfering", () => {
  seq = 0;
  const evs = [
    E(ev.member("a", "Ann"), at(day(0), 6)),
    E(ev.member("a2", "Ann"), at(day(2), 6)),
    E(ev.member("bot", "Bot"), at(day(0), 6)),
    E(ev.habit("water", { name: "Water", metric: METRIC.AMOUNT, direction: AT_LEAST, target: 8, period: PERIOD.DAY, tz: TZ }), at(day(0), 6)),
  ];
  for (let n = 0; n < 5; n++) evs.push(E(ev.log("water", "a", day(n), 8, SOURCE.MANUAL), at(day(n))));           // glasses, typed
  for (let n = 5; n < 8; n++) evs.push(E(ev.log("water", "a2", day(n), 8, SOURCE.HEALTH_CONNECT), at(day(n))));  // glasses, sensor, other id
  evs.push(E(ev.habit("water", { name: "Water", metric: METRIC.AMOUNT, unit: "ml", direction: AT_LEAST, target: 2000, period: PERIOD.DAY, tz: TZ }), at(day(7), 22)));
  for (let n = 8; n < 16; n++) evs.push(E(ev.log("water", "a2", day(n), 2000, SOURCE.MANUAL), at(day(n))));      // ml
  evs.push(E(ev.mergeMember("a2", "a"), at(day(16), 6)));
  evs.push(E(ev.log("bot", "bot", day(1), 8, SOURCE.MANUAL), at(day(1))));
  evs.push(E(ev.exclude({ memberId: "bot" }), at(day(16), 7)));
  const s = replay(evs);

  assert.equal(canonicalMember(s, "a2"), "a");
  assert.equal(s.members.has("a2"), false, "duplicate folded away");
  const cf = dailyFacts(s, { me: "a", to: day(15) });
  assert.ok(cf.some((f) => f.day === day(6) && f.method === "sensor"), "the folded id's sensor day surfaces on the person");
  assert.equal(consistency(cf, "water").reportedDays, 8, "reductions stay inside the current (ml) unit");
  assert.equal(cf.find((f) => f.day === day(0)).unit, "amount", "but the raw table keeps the dated unit");
  assert.equal(cf.find((f) => f.day === day(10)).unit, "ml");
  assert.deepEqual(dailyFacts(s, { me: "bot", to: day(15) }), [], "excluded member yields no facts");
  assert.ok(s.members.has("bot"), "though still on the board");
});

test("excluding via a merged-away id still excludes the person", () => {
  seq = 0;
  const s = replay([
    E(ev.member("a", "Ann"), at(day(0), 6)),
    E(ev.member("a2", "Ann"), at(day(0), 6)),
    E(ev.mergeMember("a2", "a"), at(day(1), 6)),
    E(ev.exclude({ memberId: "a2" }), at(day(2), 6)),
  ]);
  assert.equal(isExcluded(s, { memberId: "a" }), true);
});

// ---------------------------------------------------------------------------
// determinism, purity, poison resilience
// ---------------------------------------------------------------------------

function busy() {
  seq = 0;
  const evs = [
    E(ev.member("m1", "M"), at(D0, 6)),
    E(ev.habit("steps", { name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
    E(ev.habit("puffs", { name: "Vape", metric: METRIC.PUFFS, direction: AT_MOST, target: 80, period: PERIOD.DAY, tz: TZ }), at(D0, 6)),
  ];
  for (let n = 0; n < 40; n++) {
    evs.push(E(ev.log("steps", "m1", day(n), 8000 + (n % 5) * 1000, SOURCE.HEALTH_CONNECT), at(day(n))));
    evs.push(E(ev.log("puffs", "m1", day(n), (n % 3) * 30, SOURCE.MANUAL), at(day(n))));
  }
  return evs;
}

test("replay is order-independent and the read-model is a pure function of state", () => {
  const evs = busy();
  const a = replay(evs);
  const b = replay([...evs].sort(() => Math.random() - 0.5));
  assert.equal(a.logs.size, b.logs.size, "shuffled input, same state");
  const f1 = JSON.stringify(dailyFacts(a, { me: "m1", to: day(39) }));
  const f2 = JSON.stringify(dailyFacts(a, { me: "m1", to: day(39) }));
  assert.equal(f1, f2, "dailyFacts differs between identical reads");
});

test("a batch of poison events never derails or leaks into replay", () => {
  const evs = busy();
  const clean = replay(evs);
  const poison = [];
  for (let i = 0; i < 100; i++) poison.push({ eventId: "p" + i, seq: 90000 + i, ts: at(day(5)), author: "attacker", type: T.LOG, payload: { v: 1, habitId: "steps", memberId: "m1" /* no day */ } });
  let s, threw = false;
  try { s = replay([...evs, ...poison]); } catch { threw = true; }
  assert.equal(threw, false, "replay threw");
  assert.equal(s.logs.size, clean.logs.size, "poison leaked into state");
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ data-layer integration (seams): " + passed + " tests passed");
