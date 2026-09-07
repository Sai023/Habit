// season-lifecycle.test.mjs — a season from the day it starts to the day it is replaced.
//
// The other two season files test the pieces: what a week is worth, what a line does. This one
// walks the whole arc in order, because the failures that matter to a group of three are the ones
// that only appear in sequence — a week counted twice, a crown that moves after it was awarded, a
// total that changes when nothing happened.
//
// ---- What "the end" means here, and does not ----
//
// There is no end date. A season runs from its line until somebody starts another one, and that is
// the only way one finishes. So the last act below is a restart, because a restart IS the ending —
// the standings the group played for are read one final time, and then they are gone.
//
// That is worth stating plainly rather than leaving implied: nothing in this engine will ever
// declare a winner and close the book by itself.

import assert from "node:assert/strict";
import { replay, addDays, periodStart, isoWeekKey, daysBetween } from "../js/habits.js";
import {
  seasonStart, seasonWeeks, seasonTally, pendingSeason, weekStandings,
  seasonLength, seasonEnd, seasonProgress, seasonHistory, endFor,
} from "../js/season.js";
import { ev, SOURCE, AT_LEAST, AGGREGATE, METRIC, PERIOD } from "../js/schema.js";

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
const E = (spec, ts) => ({ eventId: "L" + ++seq, ts, seq, ...spec });

const ME = "me";
const RIVAL = "rival";
const BOTH = [ME, RIVAL];

/**
 * Six weeks of a two-person group on one daily habit.
 *
 * `mine` and `theirs` are how many of the seven days each hit, week by week, so a week can be won,
 * lost or drawn on purpose rather than by arithmetic accident.
 */
function season({ mine, theirs, extra = [] } = {}) {
  const events = [
    E(ev.member(ME, "You"), at(0)),
    E(ev.member(RIVAL, "Rival"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 100,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
      grace: { earnEvery: 0, cap: 0 },
    }), at(0)),
  ];
  mine.forEach((hits, week) => {
    for (let d = 0; d < 7; d += 1) {
      const n = week * 7 + d;
      events.push(E(ev.log("steps", ME, day(n), d < hits ? 500 : 0, SOURCE.MANUAL), at(n)));
      events.push(E(ev.log("steps", RIVAL, day(n), d < theirs[week] ? 500 : 0, SOURCE.MANUAL), at(n)));
    }
  });
  return replay([...events, ...extra]);
}

/** Six weeks: I take four, they take two. */
const MINE = [7, 7, 3, 7, 7, 2];
const THEIRS = [3, 2, 7, 4, 1, 7];
const AFTER_SIX = day(42);          // the Monday after the sixth week

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

test("the season runs from the first habit when nobody has drawn a line", () => {
  const s = season({ mine: MINE, theirs: THEIRS });
  assert.equal(seasonStart(s, AFTER_SIX), MON);
  assert.equal(pendingSeason(s, AFTER_SIX), null, "nothing booked");
});

test("six weeks played, six weeks counted — and the week in progress is not one of them", () => {
  const s = season({ mine: MINE, theirs: THEIRS });
  // Standing on the Monday after: six finished weeks behind, a seventh being played.
  assert.equal(seasonTally(s, BOTH, AFTER_SIX).weeks, 6);
  assert.equal(seasonWeeks(s, AFTER_SIX).length, 7, "seven touched, six done");

  // Mid-week, the week you are standing in still does not count. Handing out its crown on a
  // Wednesday and taking it back on a Friday would make the tally something to refresh.
  assert.equal(seasonTally(s, BOTH, day(45)).weeks, 6);
});

test("crowns land on the weeks that were actually won", () => {
  const s = season({ mine: MINE, theirs: THEIRS });
  const rows = seasonTally(s, BOTH, AFTER_SIX).rows;
  const me = rows.find((r) => r.memberId === ME);
  const them = rows.find((r) => r.memberId === RIVAL);
  assert.equal(me.crowns + them.crowns, 6, "every finished week awarded exactly one");
  assert.equal(me.crowns, 4);
  assert.equal(them.crowns, 2);
});

test("the leader is the one with the points, and crowns only break a tie", () => {
  const s = season({ mine: MINE, theirs: THEIRS });
  const [first] = seasonTally(s, BOTH, AFTER_SIX).rows;
  assert.equal(first.memberId, ME);
  assert.ok(first.points > 0);
});

test("asking twice gives the same answer", () => {
  // Nothing is stored: the tally is derived on every replay. A season that moved when you looked
  // at it again would be one nobody could argue about.
  const s = season({ mine: MINE, theirs: THEIRS });
  const a = JSON.stringify(seasonTally(s, BOTH, AFTER_SIX).rows);
  const b = JSON.stringify(seasonTally(s, BOTH, AFTER_SIX).rows);
  assert.equal(a, b);
});

test("a finished week never changes again", () => {
  // The whole point of only counting completed weeks. Week one's result on the Monday after week
  // one must be week one's result six weeks later.
  const s = season({ mine: MINE, theirs: THEIRS });
  const early = seasonTally(s, BOTH, day(7)).rows.find((r) => r.memberId === ME);
  const late = seasonTally(s, BOTH, AFTER_SIX).rows.find((r) => r.memberId === ME);
  assert.equal(early.weeks, 1);
  assert.ok(late.points > early.points, "later totals only grow");
  assert.ok(late.crowns >= early.crowns, "and a crown once won is not taken back");
});

// ---------------------------------------------------------------------------
// Ending — which is to say, starting the next one
// ---------------------------------------------------------------------------

test("a season only ends when the next one starts", () => {
  // Stated as a test because it is a design decision people will assume the other way: nothing in
  // here declares a winner or closes the book on a date. Six weeks in, the season is still running,
  // and it would still be running in a year.
  const s = season({ mine: MINE, theirs: THEIRS });
  assert.equal(seasonTally(s, BOTH, AFTER_SIX).weeks, 6);
  assert.equal(seasonTally(s, BOTH, day(365)).weeks, 52, "a year later, still the same season");
});

test("the final standings are readable right up to the handover", () => {
  // The last thing a group does before a reset is look at who won. That has to work on the morning
  // the new season starts, not just before it was booked.
  const nextMonday = day(49);
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: nextMonday }), at(42))],
  });
  const before = seasonTally(s, BOTH, day(48));   // the Sunday
  assert.ok(before.weeks >= 6, "the old season is still whole the day before");
  assert.equal(before.rows[0].memberId, ME, "and still shows who won it");
});

test("the new season starts empty, and takes nothing from the old one", () => {
  const nextMonday = day(49);
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: nextMonday }), at(42))],
  });
  const after = seasonTally(s, BOTH, nextMonday);
  assert.equal(after.weeks, 0);
  for (const row of after.rows) {
    assert.equal(row.points, 0, row.name + " starts level");
    assert.equal(row.crowns, 0);
    assert.equal(row.crownStreak, 0);
    assert.equal(row.best, null);
  }
});

test("a season can be restarted again, and the newest line is the one that counts", () => {
  // Two resets. A group that decides the new season started badly and wants another go must not
  // end up with the first line still quietly in force.
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [
      E(ev.meta({ seasonFrom: day(21) }), at(20)),
      E(ev.meta({ seasonFrom: day(35) }), at(34)),
    ],
  });
  assert.equal(seasonStart(s, AFTER_SIX), day(35));
  assert.equal(seasonTally(s, BOTH, AFTER_SIX).weeks, 1, "only the week since the newer line");
});

test("everything that is not the scoreboard survives the handover", () => {
  // The promise the confirm sheet makes, checked against the log rather than against the copy.
  const nextMonday = day(49);
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: nextMonday }), at(42))],
  });
  assert.equal(s.habits.size, 1, "the habit is still there");
  const habit = s.habits.get("steps");
  assert.equal(habit.target, 100, "with its target");
  assert.equal(s.members.size, 2, "and everybody is still in the group");
});

// ---------------------------------------------------------------------------
// Starting one with a ghost in the room
// ---------------------------------------------------------------------------

test("a duplicate identity can be taken off the board before a season is played on it", () => {
  // One person, two member ids — a rejoin, a reinstall, one wrong code pasted once. The second sat
  // at zero per cent for ever, pulled "nobody is the clown this week" out of the engine every week,
  // and would have carried into every future season, because members were append-only.
  const withGhost = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.member("ghost", "Rival"), at(1))],
  });
  assert.equal(withGhost.members.size, 3, "the ghost is there to begin with");
  assert.ok(
    seasonTally(withGhost, [...withGhost.members.keys()], AFTER_SIX).rows.some((r) => r.pct === null
      || r.points === 0),
    "and shows as a member who scored nothing",
  );

  const cleaned = season({
    mine: MINE, theirs: THEIRS,
    extra: [
      E(ev.member("ghost", "Rival"), at(1)),
      E(ev.member("ghost", "Rival", { removed: true }), at(42)),
    ],
  });
  assert.equal(cleaned.members.size, 2);
  assert.ok(!cleaned.members.has("ghost"));
});

test("removing somebody takes their row, not their history", () => {
  // Rewriting the log would be the more dangerous half of the same job, and nothing reads a
  // non-member's numbers anyway: every board, tally and summary is driven by the member list.
  const cleaned = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.member(RIVAL, "Rival", { removed: true }), at(42))],
  });
  assert.ok(!cleaned.members.has(RIVAL), "off the board");
  const theirs = [...cleaned.logs.keys()].filter((k) => k.split("|")[1] === RIVAL);
  assert.ok(theirs.length > 0, "their readings are still in the log");
});

test("a removal survives a replay in any order", () => {
  // Events arrive from three phones over a flaky connection. A removal that only worked when it
  // happened to replay last would come back whenever somebody synced an older event afterwards.
  const removal = E(ev.member(RIVAL, "Rival", { removed: true }), at(20));
  const late = E(ev.log("steps", RIVAL, day(41), 500, SOURCE.MANUAL), at(41));
  const s = season({ mine: MINE, theirs: THEIRS, extra: [removal, late] });
  assert.ok(!s.members.has(RIVAL), "still gone, even with a later log from them");
});

// ---------------------------------------------------------------------------
// Starting one mid-week, which is what a short test season needs
// ---------------------------------------------------------------------------

/** One week where I win the first four days and they win the last three. */
function splitWeek(extra = []) {
  const events = [
    E(ev.member(ME, "You"), at(0)),
    E(ev.member(RIVAL, "Rival"), at(0)),
    E(ev.habit("steps", {
      name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 100,
      aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL, tz: TZ, dayStartHour: 0,
      grace: { earnEvery: 0, cap: 0 },
    }), at(0)),
  ];
  for (let n = 0; n < 7; n += 1) {
    events.push(E(ev.log("steps", ME, day(n), n < 4 ? 500 : 0, SOURCE.MANUAL), at(n)));
    events.push(E(ev.log("steps", RIVAL, day(n), n >= 4 ? 500 : 0, SOURCE.MANUAL), at(n)));
  }
  return replay([...events, ...extra]);
}

test("the days before the first whole week are warm-up, and score nothing", () => {
  // This reverses an earlier rule, and the reversal is the point.
  //
  // A season starting mid-week used to score that stub as a completed week, floored to the days it
  // was actually running. Internally tidy, and it produced two things nobody wanted: a season
  // started on a SUNDAY awarded a crown for one day, and a season set to run "1 week" finished
  // with two weeks and two crowns in its table — because endFor treats the stub as extra while
  // this counted it as one of the N. Two rules disagreeing about what a week was.
  //
  // It also put the season's first number a week behind the board's, which is how it surfaced:
  // "why is All time 59 when This week says 66%". They were different weeks.
  //
  // The cost is real and worth naming: a season started on a Friday now waits until the Sunday
  // after next for its first crown, where it used to produce one that weekend. Consistent length
  // is worth more than fast first feedback — and starting on a Monday, which is the default, gives
  // both.
  const s = splitWeek([E(ev.meta({ seasonFrom: day(4) }), at(4))]);
  const t = seasonTally(s, BOTH, day(7));
  assert.equal(t.weeks, 0, "the stub is not a week");
  assert.equal(t.rows.find((r) => r.memberId === ME).points, 0);
  assert.equal(t.rows.find((r) => r.memberId === RIVAL).points, 0);
});

test("and the whole week that follows a mid-week start does score", () => {
  // The other half: warm-up is skipped, not the season. Day 4 is a Friday, so the first whole week
  // is the one beginning day 7, and it lands when that week closes on day 13.
  const s = splitWeek([E(ev.meta({ seasonFrom: day(4) }), at(4))]);
  assert.equal(seasonTally(s, BOTH, day(14)).weeks, 1);
});

test("the same week, started on the Monday, belongs to the other one", () => {
  // The control. Same logs, line a few days earlier, opposite result — which is what makes the
  // test above a statement about the floor rather than about this fixture.
  const s = splitWeek([E(ev.meta({ seasonFrom: day(0) }), at(0))]);
  assert.equal(seasonTally(s, BOTH, day(7)).rows[0].memberId, ME);
});

test("a full week is unaffected by the floor", () => {
  // The floor only ever clamps forward, so a season already running scores its weeks whole.
  const s = splitWeek();
  const whole = weekStandings(s, BOTH, isoWeekKey(day(0)));
  const floored = weekStandings(s, BOTH, isoWeekKey(day(0)), day(0));
  assert.deepEqual(floored.map((r) => r.pct), whole.map((r) => r.pct));
});

test("a season started ON a Monday produces its crown that Sunday", () => {
  // The quick-feedback case, which is why the sheet offers Monday first and why "Monday" now means
  // TODAY when today is one. Six days to a crown, with no stub to skip.
  const s = splitWeek([E(ev.meta({ seasonFrom: day(0) }), at(0))]);
  assert.equal(seasonTally(s, BOTH, day(5)).weeks, 0, "nothing while the week is still running");
  const done = seasonTally(s, BOTH, day(7));
  assert.equal(done.weeks, 1, "and one week the moment it finishes");
  assert.equal(done.rows[0].crowns, 1);
});

test("a one-week season tallies exactly one week", () => {
  // The property that was violated, stated plainly. It held for a Monday start and failed for
  // every other day, which is why nobody caught it until a season was started on a Sunday.
  for (let startsOn = 0; startsOn < 7; startsOn += 1) {
    const s = splitWeek([E(ev.meta({ seasonFrom: day(startsOn), seasonWeeks: 1 }), at(startsOn))]);
    const t = seasonTally(s, BOTH, day(60));
    assert.equal(t.weeks, 1, "a season starting on day " + startsOn + " tallied " + t.weeks);
  }
});

// ---------------------------------------------------------------------------
// A season with a finish line
// ---------------------------------------------------------------------------

test("no length means no end, which is the old behaviour and still the default", () => {
  const s = season({ mine: MINE, theirs: THEIRS, extra: [E(ev.meta({ seasonFrom: MON }), at(0))] });
  assert.equal(seasonLength(s), null);
  assert.equal(seasonEnd(s, AFTER_SIX), null);
  assert.equal(seasonProgress(s, AFTER_SIX).end, null, "and nothing to count down to");
});

test("a length gives it a last day, counted from the Monday of its first week", () => {
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: MON, seasonWeeks: 4 }), at(0))],
  });
  // Four whole weeks from the Monday: twenty-eight days, ending on a Sunday.
  assert.equal(seasonEnd(s, AFTER_SIX), day(27));
});

test("a season started mid-week ends on a Sunday, after a whole week of scoring", () => {
  // Two properties, and the second one replaced an earlier rule.
  //
  // It always ended on a Sunday, counted from the Monday of the week it began in — defensible
  // arithmetic that let the stub of the starting week consume one of the N. At four weeks that is
  // barely noticeable. At one it is fatal: a season started on a Sunday ended that same Sunday, and
  // a real group created one and watched the board say "Sun 06 Sept → Sun 06 Sept · Season over"
  // before anybody had played a day of it.
  //
  // So the partial week is now extra rather than counted. "1 week" means at least one whole week,
  // which is the only reading of it nobody has to be talked out of.
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: day(3), seasonWeeks: 1 }), at(3))],
  });
  assert.equal(seasonEnd(s, day(7)), day(13), "the rest of that week, then a full one");
});

test("a season started ON a Monday is exactly its length", () => {
  // The other half: with no stub there is nothing to add, so the common case is unchanged.
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: MON, seasonWeeks: 1 }), at(0))],
  });
  assert.equal(seasonEnd(s, day(3)), day(6), "seven days, Monday to Sunday");
});

test("a one-week season is never shorter than a week", () => {
  // Stated as the property rather than as an example, because the example that broke was the one
  // nobody thought to write: the last possible day of a week.
  for (let startsOn = 0; startsOn < 7; startsOn += 1) {
    const s = season({
      mine: MINE, theirs: THEIRS,
      extra: [E(ev.meta({ seasonFrom: day(startsOn), seasonWeeks: 1 }), at(startsOn))],
    });
    const end = seasonEnd(s, day(startsOn));
    assert.ok(
      daysBetween(day(startsOn), end) >= 6,
      "a season starting on day " + startsOn + " ran " + daysBetween(day(startsOn), end) + " days",
    );
  }
});

test("a finished season stops counting", () => {
  // Otherwise the standings keep growing after the final whistle, and "final" is the one thing they
  // are not.
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: MON, seasonWeeks: 2 }), at(0))],
  });
  const atEnd = seasonTally(s, BOTH, day(14)).weeks;
  assert.equal(atEnd, 2);
  assert.equal(seasonTally(s, BOTH, day(42)).weeks, 2, "four weeks later, still two");
  assert.equal(seasonTally(s, BOTH, day(365)).weeks, 2, "a year later, still two");
});

test("the countdown runs down and then says it is over", () => {
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: MON, seasonWeeks: 4 }), at(0))],
  });
  const on = (n) => seasonProgress(s, day(n));
  assert.equal(on(0).daysLeft, 27);
  assert.equal(on(26).daysLeft, 1);
  assert.equal(on(27).daysLeft, 0, "the last day is not yet over");
  assert.equal(on(27).ended, false);
  assert.equal(on(28).ended, true, "the morning after");
});

test("the bar moves every day, not once a week", () => {
  // A bar that only advances on Mondays sits still for six days at a time, which reads as broken
  // rather than as patient.
  const s = season({
    mine: MINE, theirs: THEIRS,
    extra: [E(ev.meta({ seasonFrom: MON, seasonWeeks: 4 }), at(0))],
  });
  const pcts = [0, 1, 2, 3].map((n) => seasonProgress(s, day(n)).pct);
  assert.equal(new Set(pcts).size, 4, "four different days, four different figures: " + pcts);
  assert.equal(seasonProgress(s, day(27)).pct, 100, "full on the last day");
});

// ---------------------------------------------------------------------------
// Booking the next one while the last one has finished
// ---------------------------------------------------------------------------
//
// Reported from a real group. A one-week season ran Thu 3 Sept to Sun 6 Sept and finished. On
// Monday the 7th somebody started the next one, and the board went on showing "Thu 03 Sept →
// Sun 06 Sept · Season over" as though nothing had happened.
//
// Two bugs, and they hid each other. The sheet's "Monday" option offered the Monday AFTER the one
// they were standing on, so the season was booked a week away; and while a line sits in the future
// seasonStart fell all the way back to the first habit's day — which in that group WAS 3 Sept, so
// the board showed a season that had been replaced, with dates that happened to match.

const lifecycleMeta = (extra) => replay([
  E(ev.member("me", "You"), at(0)),
  E(ev.habit("h", {
    name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 100,
    period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
    tz: TZ, dayStartHour: 4,
  }), at(0)),
  ...extra,
]);

test("a booked season does not erase the one it replaces", () => {
  // The finished season's standings are what everybody played for. They stay until the morning the
  // new one starts, rather than being swapped for an unrelated week from the beginning of time.
  const s = lifecycleMeta([
    E(ev.meta({ seasonFrom: day(7), seasonWeeks: 1 }), at(7)),
    E(ev.meta({ seasonFrom: day(28), seasonWeeks: 4 }), at(21)),
  ]);
  assert.equal(seasonStart(s, day(21)), day(7), "still the season that ran");
  assert.equal(pendingSeason(s, day(21)), day(28), "and the next one is announced");
});

test("and it keeps its OWN length, not the new one's", () => {
  // The subtler half. seasonWeeks already describes the booked season, so reading the old start
  // against the new length invents an end date neither season has — a one-week season that
  // suddenly claims to run for four.
  const s = lifecycleMeta([
    E(ev.meta({ seasonFrom: day(7), seasonWeeks: 1 }), at(7)),
    E(ev.meta({ seasonFrom: day(28), seasonWeeks: 4 }), at(21)),
  ]);
  assert.equal(seasonLength(s, day(21)), 1, "the finished season was one week");
  assert.equal(seasonLength(s, day(28)), 4, "and the new one is four");
});

test("the moment it starts, the new season takes over completely", () => {
  const s = lifecycleMeta([
    E(ev.meta({ seasonFrom: day(7), seasonWeeks: 1 }), at(7)),
    E(ev.meta({ seasonFrom: day(28), seasonWeeks: 4 }), at(21)),
  ]);
  assert.equal(seasonStart(s, day(28)), day(28));
  assert.equal(pendingSeason(s, day(28)), null);
});

test("a first season still falls back to the first habit before it begins", () => {
  // The behaviour the fallback was written for, and which must survive: with nothing to replace,
  // a pending line leaves the board showing everything since the group started.
  const s = lifecycleMeta([E(ev.meta({ seasonFrom: day(28), seasonWeeks: 4 }), at(21))]);
  assert.equal(seasonStart(s, day(21)), day(0), "back to the first habit");
  assert.equal(pendingSeason(s, day(21)), day(28));
});

// ---------------------------------------------------------------------------
// Every season, not just the one the meta line points at
// ---------------------------------------------------------------------------
//
// There is one `seasonFrom`, and starting a season overwrites it — so a group on their third
// season could not see who won either of the first two. The standings were still derivable from
// the log the whole time; nothing recorded WHICH windows to derive.

const runs = (lines) => replay([
  E(ev.member(ME, "Me"), at(0)),
  E(ev.member(RIVAL, "Them"), at(0)),
  E(ev.habit("h", {
    name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 100,
    period: PERIOD.DAY, aggregate: AGGREGATE.LAST, source: SOURCE.MANUAL,
    tz: TZ, dayStartHour: 4,
  }), at(0)),
  ...lines.map(([from, weeks, when]) =>
    E(ev.meta({ seasonFrom: from, seasonWeeks: weeks }), at(when))),
]);

test("every season run is remembered, newest first", () => {
  const s = runs([[day(0), 1, 0], [day(7), 1, 7], [day(14), 1, 14]]);
  const h = seasonHistory(s, day(16));
  assert.deepEqual(h.map((x) => x.from), [day(14), day(7), day(0)]);
  assert.deepEqual(h.map((x) => x.index), [3, 2, 1], "numbered from the group's first");
});

test("each one carries its own dates and state", () => {
  const s = runs([[day(0), 1, 0], [day(7), 2, 7]]);
  const [current, first] = seasonHistory(s, day(9));
  assert.equal(first.to, day(6), "a one-week season");
  assert.ok(first.ended);
  assert.equal(current.to, day(20), "and a two-week one");
  assert.ok(current.current && !current.ended);
});

test("a booked season is listed as booked, not as running", () => {
  const s = runs([[day(0), 1, 0], [day(14), 1, 7]]);
  const [next, done] = seasonHistory(s, day(9));
  assert.ok(next.pending, "not started yet");
  assert.ok(!next.current);
  assert.ok(done.ended);
});

test("a finished season can still be tallied by naming its window", () => {
  // The thing the list is for. seasonTally answers about the CURRENT season unless a window says
  // otherwise, and every past season is exactly a window.
  const s = runs([[day(0), 1, 0], [day(7), 1, 7]]);
  const [, first] = seasonHistory(s, day(9));
  const tally = seasonTally(s, [ME, RIVAL], day(9), { from: first.from, to: first.to });
  assert.equal(tally.weeks, 1, "the one week it ran");
  assert.equal(tally.rows.length, 2);
});

test("with no season ever started the list is empty", () => {
  const s = runs([]);
  assert.deepEqual(seasonHistory(s, day(9)), []);
});

test("the list and the board agree about a season's dates", () => {
  // Both derive the end from endFor, which exists so they cannot answer differently — the list has
  // to date seasons the meta line no longer points at.
  const s = runs([[day(3), 2, 3]]);
  const [only] = seasonHistory(s, day(5));
  assert.equal(only.to, seasonEnd(s, day(5)));
  assert.equal(only.to, endFor(day(3), 2));
});

test("only one season is ever running", () => {
  // Reported from a live board showing three seasons, two of them labelled Running. The first had
  // been started with "No end", so it had no end date and stayed current for ever — being REPLACED
  // was an ending nothing modelled.
  const s = runs([[day(0), null, 0], [day(1), 1, 1], [day(14), 1, 2]]);
  const h = seasonHistory(s, day(3));
  assert.equal(h.filter((x) => x.current).length, 1, "exactly one");
  assert.equal(h.filter((x) => x.pending).length, 1);
});

test("a season with no end still ends when the next one starts", () => {
  const s = runs([[day(0), null, 0], [day(7), 1, 7]]);
  const [, first] = seasonHistory(s, day(9));
  assert.equal(first.to, day(6), "the day before its replacement");
  assert.ok(first.ended);
  assert.ok(first.superseded, "cut short rather than run out");
});

test("a season that runs its full length is not marked replaced", () => {
  // The distinction the label rests on: "finished" claims it ran its course, and one somebody
  // ended after a day did not.
  const s = runs([[day(0), 1, 0], [day(7), 1, 7]]);
  const [, first] = seasonHistory(s, day(9));
  assert.equal(first.to, day(6), "its own end, which the next start does not shorten");
  assert.ok(!first.superseded);
});

test("the last season keeps its own end, capped by nothing", () => {
  const s = runs([[day(0), 1, 0]]);
  const [only] = seasonHistory(s, day(3));
  assert.equal(only.to, day(6));
  assert.ok(only.current);
  assert.ok(!only.superseded);
});

test("a no-end season that has never been replaced runs on", () => {
  // The reason "no end" exists at all, and it must survive the fix.
  const s = runs([[day(0), null, 0]]);
  const [only] = seasonHistory(s, day(90));
  assert.equal(only.to, null);
  assert.ok(only.current, "still going, three months later");
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ season lifecycle: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ season lifecycle: " + passed + " tests passed");
