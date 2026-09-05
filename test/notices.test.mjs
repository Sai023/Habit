// notices.test.mjs — what is worth interrupting somebody for, and how often.
//
// The engine stores nothing: every figure is derived on each replay, so this function runs again on
// every sync and returns the same notices for as long as they remain true. A milestone is true all
// day. A taper week is true for seven of them.
//
// That is fine, and it is only fine because of the id. Stable for the same event, different for a
// genuinely new one, so the shell can post each exactly once without this needing to become a queue
// somebody has to drain. Getting an id wrong in either direction is the whole failure mode here:
// too stable and a real second milestone never arrives, too volatile and the phone buzzes daily.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import { noticesFor, MILESTONES } from "../js/notices.js";
import { ev, SOURCE, AT_MOST, AT_LEAST, AGGREGATE, METRIC } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const MON = "2026-03-02";
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "n" + ++seq, ts, seq, ...spec });

/** A member on a tapering puff habit, logging cleanly unless told otherwise. */
function world({ over = [], baseline = 80 } = {}) {
  const events = [
    E(ev.member("me", "You"), at(0)),
    E(ev.habit("puffs", {
      name: "Puffs", metric: METRIC.PUFFS, direction: AT_MOST, target: baseline,
      aggregate: AGGREGATE.SUM, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
      taper: { percent: 10, everyDays: 7, floor: 0 },
    }), at(0)),
    E(ev.goal("me", "puffs", { target: baseline }), at(0)),
  ];
  // Far enough to reach the end of the taper. An unlogged manual day is a miss, and three of them
  // hold the week — so a fixture that stops short does not test a quiet taper, it tests a held one.
  for (let n = 0; n <= 80; n += 1) {
    events.push(E(ev.log("puffs", "me", day(n), over.includes(n) ? 9999 : 0, SOURCE.MANUAL), at(n)));
  }
  return replay(events);
}

const idsOf = (list) => list.map((n) => n.id);
const kindsOf = (list) => list.map((n) => n.kind);

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

test("a milestone is announced on the day it is crossed", () => {
  const s = world();
  const notices = noticesFor(s, "me", day(10), 20);
  assert.equal(kindsOf(notices).filter((k) => k === "milestone").length, 1);
  assert.ok(notices[0].body.includes("20"));
  // The badge is named in the notice, because "20 days" and "Silver" are the same news and
  // only one of them is worth showing somebody.
  assert.ok(notices[0].title.includes("Silver"), notices[0].title);
});

test("and on no other day, however long the run gets", () => {
  // The id would be enough to stop a repeat, but the notice should not exist at all on day 31 —
  // otherwise a phone that misses one day of syncing announces yesterday's milestone as today's.
  const s = world();
  for (const streak of [19, 21, 45, 99]) {
    assert.equal(
      kindsOf(noticesFor(s, "me", day(10), streak)).includes("milestone"), false,
      "no milestone at " + streak,
    );
  }
});

test("only the lengths worth saying out loud", () => {
  const s = world();
  assert.deepEqual(MILESTONES, [7, 20, 50, 100]);
  for (const streak of MILESTONES) {
    assert.ok(kindsOf(noticesFor(s, "me", day(10), streak)).includes("milestone"), String(streak));
  }
  // A nudge at every round number is one nobody reads by the third.
  for (const streak of [10, 14, 30, 60, 200, 365]) {
    assert.equal(kindsOf(noticesFor(s, "me", day(10), streak)).includes("milestone"), false);
  }
});

// ---------------------------------------------------------------------------
// Somebody else's milestone
// ---------------------------------------------------------------------------

const other = (memberId, name, streak) => ({ memberId, name, streak });

test("a friend reaching a milestone is worth telling you about", () => {
  // The half of a group tracker that was missing. Until this, the app only ever talked to you
  // about you — in an app whose whole premise is three people watching each other.
  const s = world();
  const out = noticesFor(s, "me", day(10), 3, [
    other("me", "Me", 3),
    other("thabo", "Thabo", 20),
  ]);
  const mine = out.filter((n) => n.kind === "milestone");
  assert.equal(mine.length, 1);
  assert.ok(mine[0].title.includes("Thabo"), mine[0].title);
  assert.ok(mine[0].title.includes("20"), mine[0].title);
  assert.ok(mine[0].body.includes("Silver"), mine[0].body);
});

test("you are never told about your own streak twice", () => {
  // `others` carries everybody, this member included, because the caller has no reason to filter.
  // Announcing it from both branches would post the same day twice with two different wordings.
  const s = world();
  const out = noticesFor(s, "me", day(10), 20, [other("me", "Me", 20)]);
  assert.equal(out.filter((n) => n.kind === "milestone").length, 1);
  assert.ok(!out[0].title.includes("Me hit"), out[0].title);
});

test("two people crossing on the same day both get said", () => {
  const s = world();
  const out = noticesFor(s, "me", day(10), 3, [
    other("thabo", "Thabo", 7),
    other("lerato", "Lerato", 7),
  ]);
  const said = out.filter((n) => n.kind === "milestone");
  assert.equal(said.length, 2);
  // Distinct ids, or the shell fires one and swallows the other.
  assert.equal(new Set(said.map((n) => n.id)).size, 2);
});

test("only on the day they cross it", () => {
  const s = world();
  for (const streak of [6, 8, 19, 21, 99, 101]) {
    const out = noticesFor(s, "me", day(10), 3, [other("thabo", "Thabo", streak)]);
    assert.equal(
      out.filter((n) => n.kind === "milestone").length, 0,
      "nothing at " + streak,
    );
  }
});

test("a friend with no name still reads as a sentence", () => {
  // Members arrive over sync, and a row can exist before its name event has landed.
  const s = world();
  const out = noticesFor(s, "me", day(10), 3, [other("x", "", 50)]);
  assert.ok(out[0].title.startsWith("Someone hit"), out[0].title);
});

test("a rebuilt streak is worth saying again, and carries a different id", () => {
  // Reaching seven, losing it, and clawing back to seven is a second achievement — arguably a
  // harder one. The day in the id is what lets it through.
  const s = world();
  const first = noticesFor(s, "me", day(3), 7)[0];
  const again = noticesFor(s, "me", day(25), 7)[0];
  assert.ok(first && again);
  assert.notEqual(first.id, again.id);
});

test("the same day asked twice gives the same id, so it is posted once", () => {
  const s = world();
  assert.deepEqual(idsOf(noticesFor(s, "me", day(10), 20)), idsOf(noticesFor(s, "me", day(10), 20)));
});

test("no streak at all is not an occasion", () => {
  assert.deepEqual(noticesFor(world(), "me", day(10), 0), []);
});

// ---------------------------------------------------------------------------
// The taper week turning over
// ---------------------------------------------------------------------------

test("the allowance stepping down is announced on the day it changes", () => {
  const s = world();
  const notices = noticesFor(s, "me", day(7), 0); // first day of taper week two
  const taper = notices.find((n) => n.kind === "taper");
  assert.ok(taper, "a taper notice on the turnover day");
  assert.ok(taper.body.includes("72"), "names the new number: " + taper.body);
  assert.ok(taper.body.includes("80"), "and the one it came from");
});

test("and on no other day of that week", () => {
  const s = world();
  for (const n of [8, 9, 10, 11, 12, 13]) {
    assert.equal(
      kindsOf(noticesFor(s, "me", day(n), 0)).includes("taper"), false,
      "quiet on day " + n + " of the week",
    );
  }
});

test("a held week says so, and says what it cost", () => {
  // Three days over in week one holds week two. A limit that failed to move without explanation
  // reads as a bug, and this one was earned.
  const s = world({ over: [0, 1, 2] });
  const taper = noticesFor(s, "me", day(7), 0).find((n) => n.kind === "taper");
  assert.ok(taper, "a notice on the turnover day");
  assert.ok(taper.body.includes("80"), "still at the baseline: " + taper.body);
  assert.ok(/three days|no bonus/i.test(taper.body), "names the cause and the cost");
  assert.ok(taper.id.endsWith("|held"), "and is a different notice from a step down");
});

test("the week it reaches zero is said differently", () => {
  const s = world();
  const taper = noticesFor(s, "me", day(70), 0).find((n) => n.kind === "taper");
  assert.ok(taper);
  assert.ok(/zero/i.test(taper.body), "that was the whole plan: " + taper.body);
});

test("a habit with no taper never produces one", () => {
  const s = replay([
    E(ev.member("me", "You"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
    }), at(0)),
  ]);
  for (const n of [0, 7, 14]) {
    assert.equal(kindsOf(noticesFor(s, "me", day(n), 0)).includes("taper"), false);
  }
});

test("the first week is not a step down and is not announced", () => {
  // Day zero is the baseline being set, not the allowance moving.
  assert.equal(kindsOf(noticesFor(world(), "me", day(0), 0)).includes("taper"), false);
});

// ---------------------------------------------------------------------------

test("two occasions on one day are both returned, in order", () => {
  const s = world();
  const notices = noticesFor(s, "me", day(7), 7); // a milestone AND a taper turnover
  assert.deepEqual(kindsOf(notices), ["milestone", "taper"]);
  assert.equal(new Set(idsOf(notices)).size, 2, "and they cannot collide");
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ notices: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ notices: " + passed + " tests passed");
