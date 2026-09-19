// optout.test.mjs — declining a habit must cost nothing.
//
// ---- The question this answers ----
//
// The group tracks six things. Nobody does all six. Somebody who has never touched a vape is not
// going to add "vape puffs" to their list, and the moment declining one costs points the board is
// measuring willingness to sign up for other people's problems rather than anybody's week.
//
// The stakes are concrete: Vape puffs sits in Discipline beside Locked apps, and Discipline is 30
// of the 100 a day is worth. A naive scorer treats a habit nobody logged as a miss, which would
// hand every non-smoker a permanent half-empty Discipline — 15 points a day, for ever, for not
// smoking. It would look like a leaderboard and behave like a tax.
//
// Two separate rules have to hold, and only the first is obvious:
//
//   1. an opted-out habit is not scored — it is not a miss, it is not a zero, it is not there
//   2. a category with nothing left in it is DROPPED, and the remaining weights grow to fill the
//      hundred, so somebody running two categories is judged out of a hundred exactly like
//      somebody running four
//
// Without the second, opting out of every Discipline habit would cap your day at 70.

import assert from "node:assert/strict";
import { replay, addDays, rawDayStatus, MISS, EXEMPT } from "../js/habits.js";
import { dayScore, categoryScores, leaderboard, CATEGORY, CATEGORY_WEIGHT } from "../js/score.js";
import { ev, METRIC, AT_LEAST, AT_MOST, AGGREGATE, SOURCE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const MON = "2026-03-02";
const day = (n) => addDays(MON, n);
const at = (n) => Date.parse(day(n) + "T09:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "o" + ++seq, ts, seq, ...spec });

/** The six the group scores on, shaped the way the editor's presets shape them. */
const SIX = [
  ["steps", METRIC.STEPS, AT_LEAST, AGGREGATE.LAST, PERIOD.DAY, 10000],
  ["sleep", METRIC.SLEEP, AT_LEAST, AGGREGATE.LAST, PERIOD.DAY, 420],
  ["puffs", METRIC.PUFFS, AT_MOST, AGGREGATE.SUM, PERIOD.DAY, 80],
  ["screen", METRIC.SCREEN_MINUTES, AT_MOST, AGGREGATE.LAST, PERIOD.DAY, 120],
  ["gym", METRIC.SESSIONS, AT_LEAST, AGGREGATE.SUM, PERIOD.WEEK, 3],
  ["save", METRIC.AMOUNT, AT_LEAST, AGGREGATE.LAST, PERIOD.MONTH, 1000],
];

const DAYS = 21;

/**
 * Two people, the same six habits, the same numbers — and B declines whatever `bDeclines` names.
 *
 * Identical logging is the whole point of the fixture: any difference in their scores afterwards
 * is caused by the opt-out and by nothing else, so the assertions do not have to reason about
 * whose week was better.
 */
function group({ bDeclines = [], value = () => "hit" } = {}) {
  const events = [E(ev.member("a", "A"), at(0)), E(ev.member("b", "B"), at(0))];
  for (const [id, metric, direction, aggregate, period, target] of SIX) {
    events.push(E(ev.habit(id, {
      name: id, metric, direction, aggregate, period, target,
      source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
      grace: { earnEvery: 0, cap: 0 },
    }), at(0)));
  }
  for (const id of bDeclines) events.push(E(ev.goal("b", id, { active: false }), at(0)));

  for (const [id, , direction, , , target] of SIX) {
    for (const who of ["a", "b"]) {
      for (let n = 0; n < DAYS; n += 1) {
        const verdict = value(id, who, n);
        if (verdict === null) continue;
        // A hit lands EXACTLY on the goal, in whichever direction the goal runs. Deliberately not
        // comfortably inside it: beating a goal earns bonus, a habit scores up to BONUS_CAP rather
        // than 1, and every number below would then be 1.15 of something — which is true, and
        // would bury the thing being measured under arithmetic about overachievement.
        const v = verdict === "hit"
          ? target
          : (direction === AT_MOST ? target * 3 : 0);
        events.push(E(ev.log(id, who, day(n), v, SOURCE.MANUAL), at(n)));
      }
    }
  }
  return replay(events);
}

const disciplineOf = (state, who, d) =>
  categoryScores(state, who, d, day(DAYS - 1)).get(CATEGORY.DISCIPLINE);

// ---------------------------------------------------------------------------
// The question as asked: decline vape puffs
// ---------------------------------------------------------------------------

test("declining vape puffs does not touch Discipline", () => {
  // B logs nothing for puffs because B is not doing puffs. If that read as a miss, Discipline
  // would be the mean of one hit and one miss — half — instead of the one habit B actually runs.
  const s = group({ bDeclines: ["puffs"] });
  const d = day(10);
  assert.equal(disciplineOf(s, "a", d).score, disciplineOf(s, "b", d).score);
  assert.equal(disciplineOf(s, "b", d).score, 1, "screen alone, and it was a hit");
});

test("the un-tracked habit is not even eligible", () => {
  // The mechanism under the assertion above, stated on its own so the reason survives a rewrite.
  // Not scored zero — not scored at all.
  const s = group({ bDeclines: ["puffs"] });
  const bucket = disciplineOf(s, "b", day(10));
  const puffs = bucket.habits.find((h) => h.habit.habitId === "puffs");
  assert.ok(puffs, "the habit still exists in the group");
  assert.equal(puffs.eligible, false, "but B is not judged on it");
  assert.equal(bucket.habits.filter((h) => h.eligible).length, 1, "only screen counts for B");
});

test("declining vape puffs does not cost a point on the day", () => {
  const s = group({ bDeclines: ["puffs"] });
  for (const n of [0, 5, 10, 20]) {
    assert.equal(
      dayScore(s, "b", day(n), day(DAYS - 1)).pct,
      dayScore(s, "a", day(n), day(DAYS - 1)).pct,
      "day " + n,
    );
  }
});

test("declining vape puffs does not cost a place on the board", () => {
  // The one somebody would actually notice. A and B did identically on everything they share.
  const s = group({ bDeclines: ["puffs"] });
  const rows = leaderboard(s, ["a", "b"], day(0), day(DAYS - 1), day(DAYS - 1));
  const [ra, rb] = ["a", "b"].map((id) => rows.find((r) => r.memberId === id));
  assert.equal(ra.pct, rb.pct, "same percentage");
});

test("and a smoker having a bad week does not drag the non-smoker down", () => {
  // The inverse: A misses puffs constantly, B does not run it at all. B's Discipline must be
  // untouched by A's habit, and A's must be genuinely worse — otherwise the first test above is
  // passing because nothing is being scored at all.
  const s = group({
    bDeclines: ["puffs"],
    value: (id, who) => (id === "puffs" && who === "a" ? "miss" : "hit"),
  });
  const d = day(10);
  assert.equal(disciplineOf(s, "b", d).score, 1, "B is on screen alone and clean");
  assert.equal(disciplineOf(s, "a", d).score, 0.5, "A has one hit and one miss");
});

// ---------------------------------------------------------------------------
// The rule underneath it, for every category
// ---------------------------------------------------------------------------

test("declining EVERY discipline habit drops the category rather than zeroing it", () => {
  // The load-bearing half. Discipline is 30 of 100; if it stayed in the sum at zero, B's ceiling
  // would be 70 for ever and no amount of effort elsewhere could reach a hundred.
  const s = group({ bDeclines: ["puffs", "screen"] });
  const d = day(10);
  const score = dayScore(s, "b", d, day(DAYS - 1));
  const discipline = score.categories.find((c) => c.category === CATEGORY.DISCIPLINE);

  assert.ok(!discipline || !discipline.eligible, "Discipline is not judged");
  assert.equal(score.pct, 100, "a clean day is still a hundred");
  assert.equal(score.pct, dayScore(s, "a", d, day(DAYS - 1)).pct);
});

test("the remaining categories grow to fill the hundred", () => {
  // Not merely "the total is 100" — the shares themselves have to be re-cut, or the arithmetic
  // that produced 100 was a coincidence of everything being a hit.
  const s = group({ bDeclines: ["puffs", "screen"] });
  const score = dayScore(s, "b", day(10), day(DAYS - 1));
  const live = score.categories.filter((c) => c.eligible);
  const shares = live.reduce((t, c) => t + c.share, 0);

  assert.ok(Math.abs(shares - 100) < 0.01, "shares still sum to 100, got " + shares);
  const fitness = live.find((c) => c.category === CATEGORY.FITNESS);
  assert.ok(
    fitness.share > CATEGORY_WEIGHT[CATEGORY.FITNESS],
    "fitness grew from " + CATEGORY_WEIGHT[CATEGORY.FITNESS] + " to " + fitness.share,
  );
});

test("declining one habit does not quietly promote the other one in its category", () => {
  // Inside a category the live habits share equally, so dropping puffs makes screen worth the
  // whole 30 rather than 15. That is correct and worth pinning: it means a non-smoker's screen
  // time matters MORE to them, not that Discipline shrank.
  const s = group({
    bDeclines: ["puffs"],
    value: (id, who) => (id === "screen" && who === "b" ? "miss" : "hit"),
  });
  const score = dayScore(s, "b", day(10), day(DAYS - 1));
  const discipline = score.categories.find((c) => c.category === CATEGORY.DISCIPLINE);
  assert.equal(discipline.share, CATEGORY_WEIGHT[CATEGORY.DISCIPLINE], "still worth 30");
  assert.equal(discipline.points, 0, "and B lost all 30, because screen was the only one left");
});

// ---------------------------------------------------------------------------
// Silence is not the same as declining
// ---------------------------------------------------------------------------

test("a habit you ARE tracking and did not log is still a miss", () => {
  // The boundary that makes the opt-out meaningful. If simply not logging were as good as opting
  // out, nobody would ever score below a hundred and the four states would collapse into one.
  const s = group({ value: (id, who) => (id === "puffs" && who === "b" ? null : "hit") });
  const bucket = disciplineOf(s, "b", day(10));
  const puffs = bucket.habits.find((h) => h.habit.habitId === "puffs");
  assert.equal(puffs.eligible, true, "B never opted out, so B is judged on it");
  assert.ok(
    dayScore(s, "b", day(10), day(DAYS - 1)).pct < dayScore(s, "a", day(10), day(DAYS - 1)).pct,
    "and an unlogged at-most habit costs something",
  );
});

// ---------------------------------------------------------------------------
// Opting out cannot rescue a day already spent
// ---------------------------------------------------------------------------
//
// A member's FIRST goal counts from the day it was authored — the joiner concession, so a newcomer
// who declines a habit is free from day one. The loophole: that concession also let someone go over
// a ceiling and THEN decline the habit to erase the miss. The rule is now narrower — a decline is
// free forever EXCEPT it cannot un-happen an at-most breach already recorded on the very day it took
// effect. Everything else about opting out (the tests above) is unchanged.

// A ceiling of five puffs a day, and a member who only ever touches this one habit.
function ceiling({ log = null, declineAt = null } = {}) {
  const events = [
    E(ev.member("z", "Z"), at(0)),
    E(ev.habit("puffs", {
      name: "puffs", metric: METRIC.PUFFS, direction: AT_MOST, aggregate: AGGREGATE.SUM,
      period: PERIOD.DAY, target: 5, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4,
      grace: { earnEvery: 0, cap: 0 },
    }), at(0)),
  ];
  // A log at noon and a decline at 6pm, both on day 0, so the breach is on the board before the
  // opt-out lands — the shape of the exploit.
  if (log !== null) events.push(E(ev.log("puffs", "z", day(0), log, SOURCE.MANUAL), Date.parse(day(0) + "T12:00:00Z")));
  if (declineAt !== null) events.push(E(ev.goal("z", "puffs", { active: false }), Date.parse(day(0) + "T" + declineAt + ":00:00Z")));
  return replay(events);
}

const statusOf = (s, d) => rawDayStatus(s, s.habits.get("puffs"), "z", d);

test("declining after blowing the cap that same day does not erase the miss", () => {
  // Nine puffs at noon (cap is five), decline at six. The breach stands.
  const s = ceiling({ log: 9, declineAt: "18" });
  assert.equal(statusOf(s, day(0)), MISS, "the day you blew is still a miss");
  assert.equal(dayScore(s, "z", day(0), day(0)).pct, 0, "and it costs the day on the board, not a free 100");
});

test("but declining on a clean day is still free", () => {
  // Three puffs — under the cap — then decline. Nothing was blown, so nothing is kept: exempt.
  const s = ceiling({ log: 3, declineAt: "18" });
  assert.equal(statusOf(s, day(0)), EXEMPT, "a decline on a day you kept under the cap is free");
});

test("and declining a habit you never logged is free from day one", () => {
  // The joiner concession the rule protects: decline at signup, never log, and day one is exempt —
  // not a no-data miss.
  const s = ceiling({ declineAt: "06" });
  assert.equal(statusOf(s, day(0)), EXEMPT, "the day you opted out is exempt");
  assert.equal(statusOf(s, day(1)), EXEMPT, "and every day after");
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ opt-out: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ opt-out: " + passed + " tests passed");
