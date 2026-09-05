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
import { replay, addDays, periodStart, isoWeekKey } from "../js/habits.js";
import { seasonStart, seasonWeeks, seasonTally, pendingSeason, weekStandings } from "../js/season.js";
import { ev, SOURCE, AT_LEAST, AGGREGATE, METRIC } from "../js/schema.js";

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

test("a season that starts mid-week is scored from the line, not from the Monday", () => {
  // The reason a season otherwise waits for a Monday, and the reason it no longer has to. Without
  // the floor, week one reaches back and counts days from BEFORE the line — the exact history
  // somebody just asked to be rid of, folded into the first week of the thing replacing it.
  //
  // Here I am perfect Monday to Thursday and they are perfect Friday to Sunday. A season starting
  // on the Friday belongs to them.
  const s = splitWeek([E(ev.meta({ seasonFrom: day(4) }), at(4))]);
  const rows = seasonTally(s, BOTH, day(7)).rows;
  assert.equal(rows[0].memberId, RIVAL, "the Friday-to-Sunday winner leads");
  assert.equal(rows.find((r) => r.memberId === ME).points, 0, "and my Monday to Thursday is gone");
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

test("a season started today produces a crown on the next Monday", () => {
  // What a few days of testing actually needs: start it now, and have something to look at when
  // the week turns over rather than a week on Monday.
  const s = splitWeek([E(ev.meta({ seasonFrom: day(4) }), at(4))]);
  assert.equal(seasonTally(s, BOTH, day(5)).weeks, 0, "nothing while the week is still running");
  const done = seasonTally(s, BOTH, day(7));
  assert.equal(done.weeks, 1, "and one week the moment it finishes");
  assert.equal(done.rows[0].crowns, 1);
});

if (failures.length) {
  for (const f of failures) console.error("✗ " + f.name + "\n  " + f.err.message);
  console.error("✗ season lifecycle: " + failures.length + " failed, " + passed + " passed");
  process.exit(1);
}
console.log("✓ season lifecycle: " + passed + " tests passed");
