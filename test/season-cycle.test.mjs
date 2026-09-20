// season-cycle.test.mjs — seasons that start themselves.
//
// The group asked for a season a month, from the 20th, with nobody having to press anything — and
// one short season first, to get from the end of the one running to the 20th. This file is that
// arrangement, day by day, on the real dates: a one-week season ending Sunday 13 September 2026,
// a schedule written that day, and the months that follow.
//
// The failures worth catching are the quiet ones: a rollover that happens on one phone and not
// another, a run-in that scores nothing because it is not a whole week, a month whose first
// Sunday or last Monday fell outside every week and so outside the season.

import assert from "node:assert/strict";
import { replay, addDays } from "../js/habits.js";
import {
  seasonWindows, seasonHistory, seasonProgress, seasonStart, pendingSeason, seasonTally,
  seasonSchedule, nextCycleDay, seasonLength, seasonEnd, boardStart, CYCLE_DAY_MAX,
} from "../js/season.js";
import { leaderboard } from "../js/score.js";
import { buildSummary } from "../js/summary.js";
import { ev, SOURCE, METRIC, AT_LEAST, AGGREGATE, PERIOD } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const at = (day) => Date.parse(day + "T12:00:00Z");
let seq = 0;
const E = (spec, ts) => ({ eventId: "c" + ++seq, ts, seq, ...spec });

const STEPS = {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 100,
  aggregate: AGGREGATE.LAST, period: PERIOD.DAY, source: SOURCE.MANUAL, scored: true,
  tz: TZ, dayStartHour: 0, grace: { earnEvery: 0, cap: 0 },
};

const FIRST = "2026-09-01";      // the habit's birthday
const SUNDAY_13 = "2026-09-13";  // the last day of the hand-started week
const MONDAY_14 = "2026-09-14";

/**
 * Two people, one habit, every day logged from the first of September to `through`: Alice hits
 * every day, Bob every other day. Seasons as `extra` meta lines.
 */
function group(through, extra = []) {
  const events = [
    E(ev.member("a", "Alice"), at(FIRST)),
    E(ev.member("b", "Bob"), at(FIRST)),
    E(ev.habit("steps", STEPS), at(FIRST)),
    E(ev.bind("a", "steps", SOURCE.MANUAL), at(FIRST)),
    E(ev.bind("b", "steps", SOURCE.MANUAL), at(FIRST)),
  ];
  for (let d = FIRST, i = 0; d <= through; d = addDays(d, 1), i += 1) {
    events.push(E(ev.log("steps", "a", d, 500, SOURCE.MANUAL), at(d)));
    events.push(E(ev.log("steps", "b", d, i % 2 ? 500 : 0, SOURCE.MANUAL), at(d)));
  }
  return replay([...events, ...extra]);
}

/** The real arrangement: a one-week season from Sunday the 6th, then the schedule from the 14th. */
const ARRANGED = [
  E(ev.meta({ seasonFrom: "2026-09-06", seasonWeeks: 1 }), at("2026-09-06")),
  E(ev.meta({ seasonCycle: { from: MONDAY_14, day: 20 } }), at(SUNDAY_13)),
];

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

test("the next cycle day is the first such date strictly after the day asked from", () => {
  assert.equal(nextCycleDay("2026-09-14", 20), "2026-09-20");
  assert.equal(nextCycleDay("2026-09-20", 20), "2026-10-20", "on the day itself, a whole month");
  assert.equal(nextCycleDay("2026-09-21", 20), "2026-10-20");
  assert.equal(nextCycleDay("2026-12-25", 20), "2027-01-20", "and across the year");
  assert.equal(nextCycleDay("2026-01-31", 1), "2026-02-01");
});

test("the schedule unrolls into a short run-in and then a month at a time", () => {
  const s = group(MONDAY_14, ARRANGED);
  // On the 13th: the week being played and the one booked next. No further — a list of every
  // month until the end of time is not a list anybody asked for.
  assert.deepEqual(seasonWindows(s, SUNDAY_13).map((x) => [x.from, x.to]), [
    ["2026-09-06", "2026-09-13"],  // by hand: Sunday, then one whole week
    ["2026-09-14", "2026-09-19"],  // the run-in to the 20th
  ], "today's and the next");
  // On the 14th the run-in is today's, so the first month is the next.
  const w = seasonWindows(s, MONDAY_14);
  assert.deepEqual(w.map((x) => [x.from, x.to]), [
    ["2026-09-06", "2026-09-13"],
    ["2026-09-14", "2026-09-19"],
    ["2026-09-20", "2026-10-19"],  // the first month
  ]);
  assert.ok(w[1].short, "the run-in is marked as the short one");
  assert.ok(!w[2].short);
  assert.deepEqual(w.map((x) => x.index), [1, 2, 3], "numbered on from the group's first");
});

test("the hand-started season is not cut short by a schedule that begins after it", () => {
  const s = group(SUNDAY_13, ARRANGED);
  const [first] = seasonWindows(s, SUNDAY_13);
  assert.equal(first.to, "2026-09-13", "its own end");
  assert.ok(!first.superseded, "which the schedule did not shorten");
  assert.ok(first.current, "still running on its last day");
});

test("a schedule written while a season runs cuts that season off the day before", () => {
  const s = group(SUNDAY_13, [
    E(ev.meta({ seasonFrom: "2026-09-06", seasonWeeks: 4 }), at("2026-09-06")),
    E(ev.meta({ seasonCycle: { from: MONDAY_14, day: 20 } }), at(SUNDAY_13)),
  ]);
  const [first] = seasonWindows(s, SUNDAY_13);
  assert.equal(first.to, "2026-09-13", "the day before the schedule begins");
  assert.ok(first.superseded, "replaced rather than finished");
});

// ---------------------------------------------------------------------------
// Rolling over with nobody pressing anything
// ---------------------------------------------------------------------------

test("tomorrow the run-in is the season, and the week that ended is finished", () => {
  const s = group(MONDAY_14, ARRANGED);
  assert.equal(seasonStart(s, MONDAY_14), MONDAY_14);
  assert.equal(seasonEnd(s, MONDAY_14), "2026-09-19");
  const h = seasonHistory(s, MONDAY_14);
  assert.deepEqual(h.map((x) => [x.from, x.pending, x.current, x.ended]), [
    ["2026-09-20", true, false, false],
    ["2026-09-14", false, true, false],
    ["2026-09-06", false, false, true],
  ]);
});

test("on the 20th the month begins, and on the 20th of the next month the next one does", () => {
  // Nothing was written between the tests: the same two meta lines, a different clock.
  const s = group("2026-11-20", ARRANGED);
  assert.equal(seasonStart(s, "2026-09-20"), "2026-09-20");
  assert.equal(seasonEnd(s, "2026-09-20"), "2026-10-19");
  assert.equal(seasonStart(s, "2026-10-19"), "2026-09-20", "the last day is still inside");
  assert.equal(seasonStart(s, "2026-10-20"), "2026-10-20");
  assert.equal(seasonEnd(s, "2026-10-20"), "2026-11-19");
  assert.equal(seasonStart(s, "2026-11-20"), "2026-11-20");
  assert.equal(seasonEnd(s, "2026-11-20"), "2026-12-19");
});

test("the next season is always announced, because it will happen on its own", () => {
  const s = group("2026-10-01", ARRANGED);
  assert.equal(pendingSeason(s, SUNDAY_13), MONDAY_14);
  assert.equal(pendingSeason(s, MONDAY_14), "2026-09-20");
  assert.equal(pendingSeason(s, "2026-10-01"), "2026-10-20");
  const p = seasonProgress(s, "2026-10-01");
  assert.equal(p.index, 3);
  assert.equal(p.every, 20);
  assert.deepEqual([p.next.from, p.next.to, p.next.index], ["2026-10-20", "2026-11-19", 4]);
});

test("a scheduled season is never over — there is always a current one", () => {
  // The strip once read "Season over" for as long as nobody tapped it. Under a schedule that
  // state cannot occur: the day after one ends is the first day of the next.
  const s = group("2027-03-01", ARRANGED);
  for (let d = MONDAY_14; d <= "2027-03-01"; d = addDays(d, 1)) {
    const p = seasonProgress(s, d);
    assert.ok(!p.ended, "over on " + d);
    assert.ok(p.daysLeft >= 0, "counting down on " + d);
  }
});

test("the countdown and the bar run over the month, in days", () => {
  const s = group("2026-10-19", ARRANGED);
  assert.equal(seasonProgress(s, "2026-09-20").daysLeft, 29);
  assert.equal(seasonProgress(s, "2026-09-20").days, 30);
  assert.equal(seasonProgress(s, "2026-10-19").daysLeft, 0);
  assert.equal(seasonProgress(s, "2026-10-19").pct, 100);
  assert.equal(seasonLength(s, "2026-10-01"), null, "a month, not a count of weeks");
});

test("every device derives the same season from the same log", () => {
  // The whole reason it is derived: there is no phone reliably awake at midnight to write the
  // next one, and a rollover written by one phone is a rollover the others have not seen yet.
  const a = group("2026-10-25", ARRANGED);
  const b = group("2026-10-25", ARRANGED.slice().reverse());
  assert.deepEqual(seasonWindows(a, "2026-10-25"), seasonWindows(b, "2026-10-25"));
});

// ---------------------------------------------------------------------------
// What a scheduled season is worth
// ---------------------------------------------------------------------------

test("the run-in counts every one of its days, and has no week to win", () => {
  // Monday to Saturday: six days, no whole week. Under the old rule it would have scored nothing
  // at all — the days before the first whole week were warm-up — and a season the group agreed
  // to play would have been a season nobody could score in.
  const s = group("2026-09-20", ARRANGED);
  const t = seasonTally(s, ["a", "b"], "2026-09-20");
  assert.equal(t.weeks, 0);
  assert.equal(t.days, 0, "on the 20th the board is about the month, which has no closed day yet");

  const runIn = seasonTally(s, ["a", "b"], "2026-09-20", { from: MONDAY_14, to: "2026-09-19" });
  assert.equal(runIn.days, 6);
  assert.equal(runIn.weeks, 0, "six days is not a week");
  const alice = runIn.rows.find((r) => r.memberId === "a");
  assert.equal(alice.points, 600, "six hundreds");
  assert.equal(alice.days, 6);
  assert.equal(alice.crowns, 0);
  assert.equal(alice.rank, 1);
});

test("a month scores its first Sunday and its last Monday, and crowns its whole weeks", () => {
  // 20 September 2026 is a Sunday; 19 October is a Monday. Both are in the season. The whole
  // weeks inside it are Mon 21 Sept to Sun 18 Oct — four of them.
  const s = group("2026-10-20", ARRANGED);
  const t = seasonTally(s, ["a", "b"], "2026-10-20", { from: "2026-09-20", to: "2026-10-19" });
  assert.equal(t.days, 30);
  assert.equal(t.weeks, 4);
  const alice = t.rows.find((r) => r.memberId === "a");
  assert.equal(alice.points, 3000, "thirty days at a hundred");
  assert.equal(alice.crowns, 4, "every whole week");
  assert.equal(alice.weeks, 4);
  assert.equal(alice.avg, 100, "a day");
  const bob = t.rows.find((r) => r.memberId === "b");
  assert.equal(bob.crowns, 0);
  assert.ok(bob.points > 0 && bob.points < alice.points);
});

test("the day being played is not in the total until it closes", () => {
  const s = group("2026-09-25", ARRANGED);
  const wed = seasonTally(s, ["a"], "2026-09-23").rows[0];   // Sun 20, Mon 21, Tue 22 closed
  const thu = seasonTally(s, ["a"], "2026-09-24").rows[0];
  assert.equal(wed.points, 300);
  assert.equal(thu.points, 400, "one more closed day, one more hundred");
});

test("standings reset on the morning a scheduled season begins, and nothing else does", () => {
  const s = group("2026-10-20", ARRANGED);
  const lastDay = seasonTally(s, ["a", "b"], "2026-10-19").rows.find((r) => r.memberId === "a");
  const firstDay = seasonTally(s, ["a", "b"], "2026-10-20").rows.find((r) => r.memberId === "a");
  assert.ok(lastDay.points >= 2900, "the month, nearly all of it closed");
  assert.equal(firstDay.points, 0, "and the next morning, nothing yet");
  assert.equal(s.habits.get("steps").target, 100, "the habit is untouched");
  assert.equal(s.members.size, 2);
});

test("a finished scheduled season is still readable from the list", () => {
  const s = group("2026-11-05", ARRANGED);
  const h = seasonHistory(s, "2026-11-05");
  const sept = h.find((x) => x.from === "2026-09-20");
  assert.ok(sept.ended);
  const t = seasonTally(s, ["a", "b"], "2026-11-05", { from: sept.from, to: sept.to });
  assert.equal(t.days, 30);
  assert.equal(t.rows[0].memberId, "a");
});

// ---------------------------------------------------------------------------
// Changing your mind
// ---------------------------------------------------------------------------

test("a season started by hand takes over from a schedule, and the schedule stops", () => {
  const s = group("2026-10-10", [
    ...ARRANGED,
    E(ev.meta({ seasonFrom: "2026-10-05", seasonWeeks: 2 }), at("2026-10-04")),
  ]);
  assert.equal(seasonSchedule(s), null, "no schedule stands any more");
  const w = seasonWindows(s, "2026-10-10");
  const month = w.find((x) => x.from === "2026-09-20");
  assert.equal(month.to, "2026-10-04", "the month was cut off the day before");
  assert.ok(month.superseded);
  assert.equal(w[w.length - 1].from, "2026-10-05");
  assert.equal(w[w.length - 1].to, "2026-10-18");
  assert.equal(pendingSeason(s, "2026-10-19"), null, "and nothing follows it by itself");
});

test("a new schedule replaces the old one from its own first day", () => {
  const s = group("2026-10-10", [
    ...ARRANGED,
    E(ev.meta({ seasonCycle: { from: "2026-10-01", day: 1 } }), at("2026-09-28")),
  ]);
  assert.deepEqual(seasonSchedule(s), { from: "2026-10-01", every: 1 });
  const w = seasonWindows(s, "2026-10-10");
  assert.equal(w.find((x) => x.from === "2026-09-20").to, "2026-09-30");
  assert.equal(seasonStart(s, "2026-10-10"), "2026-10-01");
  assert.equal(seasonEnd(s, "2026-10-10"), "2026-10-31");
  assert.equal(pendingSeason(s, "2026-10-10"), "2026-11-01");
});

test("a schedule booked for the future leaves the running season alone until then", () => {
  const s = group(SUNDAY_13, [
    E(ev.meta({ seasonFrom: "2026-09-06", seasonWeeks: 1 }), at("2026-09-06")),
    E(ev.meta({ seasonCycle: { from: "2026-09-20", day: 20 } }), at(SUNDAY_13)),
  ]);
  assert.equal(seasonStart(s, SUNDAY_13), "2026-09-06");
  assert.equal(pendingSeason(s, SUNDAY_13), "2026-09-20");
  // And between the two — the week of the 14th — there is no season, honestly.
  assert.equal(seasonStart(s, "2026-09-16"), "2026-09-06", "the finished one stays on screen");
  assert.ok(seasonProgress(s, "2026-09-16").ended);
});

// ---------------------------------------------------------------------------
// Refusing to make things worse
// ---------------------------------------------------------------------------

test("a day of the month not every month has is refused", () => {
  assert.equal(CYCLE_DAY_MAX, 28);
  for (const bad of [0, 29, 30, 31, "20", 20.5, null]) {
    const s = group(SUNDAY_13, [E(ev.meta({ seasonCycle: { from: MONDAY_14, day: bad } }), at(SUNDAY_13))]);
    assert.equal(seasonSchedule(s), null, "ignored: " + JSON.stringify(bad));
  }
});

test("a malformed schedule is dropped, not obeyed", () => {
  for (const bad of [{ day: 20 }, { from: "tomorrow", day: 20 }, "20", 20, null, []]) {
    const s = group(SUNDAY_13, [E(ev.meta({ seasonCycle: bad }), at(SUNDAY_13))]);
    assert.equal(seasonSchedule(s), null, "ignored: " + JSON.stringify(bad));
    assert.equal(seasonStart(s, SUNDAY_13), FIRST, "and the board is as it was");
  }
});

test("the rule trail cannot be handed in by a client", () => {
  // Replay derives it; a payload claiming a history is a payload claiming a history.
  const s = group(SUNDAY_13, [E(ev.meta({ seasonRules: [{ from: "2020-01-01", weeks: 1 }] }), at(SUNDAY_13))]);
  assert.deepEqual(s.meta.seasonRules, []);
});

// ---------------------------------------------------------------------------
// What the shell is told
// ---------------------------------------------------------------------------

test("the summary carries the season's dates, what is left, and when the next begins", () => {
  const s = group("2026-10-01", ARRANGED);
  const sum = buildSummary(s, "a", "2026-10-01", ["a", "b"]);
  assert.equal(sum.season.index, 3);
  assert.equal(sum.season.from, "2026-09-20");
  assert.equal(sum.season.to, "2026-10-19");
  assert.equal(sum.season.daysLeft, 18);
  assert.equal(sum.season.days, 11, "eleven closed days so far");
  assert.equal(sum.season.every, 20);
  assert.equal(sum.season.nextFrom, "2026-10-20");
  assert.ok(sum.season.dates.length > 0, "worded once, here");
  assert.equal(sum.season.left, "3 weeks left", "eighteen days, said the way the strip says it");
  assert.ok(sum.season.next.includes("4"), "names the next season: " + sum.season.next);
  assert.ok(sum.season.next.includes("a month, every month"), sum.season.next);
  // On the 13th the next one is the run-in, and the sentence must not call it a month.
  const eve = buildSummary(group(SUNDAY_13, ARRANGED), "a", SUNDAY_13, ["a", "b"]);
  assert.ok(eve.season.next.startsWith("Season 2 starts"), eve.season.next);
  assert.ok(eve.season.next.includes("a short one"), eve.season.next);
  assert.ok(eve.season.next.includes("then a month, every month from the 20th"), eve.season.next);
});

// ---------------------------------------------------------------------------
// The board never carries the old season's XP into the new one
// ---------------------------------------------------------------------------
//
// The weekly board opens on Monday; a season opens whenever the rule says — the 20th, which in 2026
// is a Sunday. So on the new season's FIRST day the board's "this week" reaches back to Monday the
// 14th, six days of the run-in it just replaced, and everyone opens the fresh contest already
// holding last season's points instead of zero. boardStart clamps the week to the season.

test("boardStart clamps this week to the season's first day", () => {
  const s = group("2026-09-20", ARRANGED);
  // Season 3 (the first full month) begins Sunday the 20th — the last day of the ISO week that
  // opened Monday the 14th. The board must open on the 20th, not the 14th.
  assert.equal(seasonStart(s, "2026-09-20"), "2026-09-20", "the season opens on the 20th");
  assert.equal(boardStart(s, "2026-09-20"), "2026-09-20", "and so does the board, not Monday the 14th");
  // A day squarely inside a month season is an ordinary week: the board opens on its Monday.
  assert.equal(boardStart(s, "2026-09-24"), "2026-09-21", "Thursday's board opens on Monday the 21st");
});

test("nobody carries the run-in's XP into the new season's board", () => {
  const s = group("2026-09-20", ARRANGED);
  const members = ["a", "b"];
  const today = "2026-09-20";
  // The bug: the week from Monday the 14th sweeps in the run-in (Alice hit six straight days).
  const leaky = leaderboard(s, members, "2026-09-14", today, today);
  assert.ok(leaky.find((r) => r.memberId === "a").scoredDays >= 6, "the unclamped week counts the run-in");
  // The fix: opened on boardStart, the board sees only the new season — its first day, nothing carried.
  const clean = leaderboard(s, members, boardStart(s, today), today, today);
  for (const r of clean) {
    assert.equal(r.scoredDays, 1, r.memberId + " starts the season with a single day, not a week");
  }
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ season schedule: " + passed + " tests passed");
