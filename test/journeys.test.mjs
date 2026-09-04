// journeys.test.mjs — every habit type, from adding it to its place on the board.
//
// The other suites test rules. This one tests the nine things a person can actually pick from the
// editor, each walked the whole way: the shape it is created with, what a reading does to it, what
// a quiet day does to it, and what it contributes to the leaderboard. Rules can all be individually
// correct and still combine into a habit that cannot work — a one-minute daily screen-time ceiling
// is made of nothing but correct rules.
//
// The presets are duplicated here rather than imported, on purpose: js/ui/editor.js needs a DOM,
// and a test that imported it would be testing nothing on a Node runner. That makes this a
// SPECIFICATION of what the editor must produce, and PRESETS_MATCH_EDITOR below is the reminder
// that the two have to be changed together.

import assert from "node:assert/strict";
import {
  replay, walk, rawDayStatus, rawPeriodStatus, valueOn, valueForPeriod, leaderboard, periodKey,
  addDays, sourceFor, HIT, MISS, NO_DATA,
} from "../js/habits.js";
import {
  ev, SOURCE, METRIC, AT_LEAST, AT_MOST, AGGREGATE, PERIOD, AUTOMATIC_SOURCES, PAUSE_METRICS,
  HEALTH_METRICS, sourceForDevice, isInterventionHabit,
} from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "UTC";
const START = "2026-03-02"; // a Monday, so week boundaries are easy to reason about
const day = (n) => addDays(START, n);
let seq = 0;
const E = (spec) => ({ eventId: "j" + ++seq, ts: Date.parse(START + "T12:00:00Z") + seq, seq, ...spec });

/**
 * What js/ui/editor.js produces for each preset. Keep in step with TYPES there.
 *
 * `start` is the one that used to be missing: every preset shared a single default target of 1,
 * so "Screen time" arrived as a one-minute daily ceiling and "Active calories" as a goal of one.
 */
const PRESETS = {
  steps: { metric: METRIC.STEPS, direction: AT_LEAST, aggregate: AGGREGATE.LAST, start: 10000, period: PERIOD.DAY },
  sleep: { metric: METRIC.SLEEP, direction: AT_LEAST, aggregate: AGGREGATE.LAST, start: 420, period: PERIOD.DAY },
  calories: { metric: METRIC.ACTIVE_CALORIES, direction: AT_LEAST, aggregate: AGGREGATE.LAST, start: 400, period: PERIOD.DAY },
  puffs: { metric: METRIC.PUFFS, direction: AT_MOST, aggregate: AGGREGATE.SUM, start: 20, period: PERIOD.DAY },
  screen: { metric: METRIC.SCREEN_MINUTES, direction: AT_MOST, aggregate: AGGREGATE.LAST, start: 120, period: PERIOD.DAY },
  opens: { metric: METRIC.APP_OPENS, direction: AT_MOST, aggregate: AGGREGATE.LAST, start: 40, period: PERIOD.DAY },
  sessions: { metric: METRIC.SESSIONS, direction: AT_LEAST, aggregate: AGGREGATE.SUM, start: 3, period: PERIOD.WEEK },
  amount: { metric: METRIC.AMOUNT, direction: AT_LEAST, aggregate: AGGREGATE.LAST, start: 1000, period: PERIOD.MONTH },
  custom: { metric: null, direction: AT_LEAST, aggregate: AGGREGATE.SUM, start: 1, period: PERIOD.DAY },
};

/** Create a habit exactly as the editor would, for one member on one kind of device. */
function add(key, { tracked = null, device = { pause: true, health: true }, over = {} } = {}) {
  const p = PRESETS[key];
  const deviceSource = sourceForDevice(p.metric, device);
  const auto = tracked === null ? deviceSource !== SOURCE.MANUAL : tracked;
  const binding = auto ? deviceSource : SOURCE.MANUAL;
  const events = [
    E(ev.member("m1", "Me")),
    E(ev.habit("h", {
      name: key,
      metric: p.metric,
      direction: p.direction,
      aggregate: p.aggregate,
      target: p.start,
      period: p.period,
      tz: TZ,
      dayStartHour: 0,
      // The editor writes the best source the metric could ever have as the group default...
      source: sourceForDevice(p.metric, { pause: true, health: true }),
      scored: p.direction === AT_LEAST,
      ...over,
    })),
    // ...and this member's own answer as the binding.
    E(ev.bind("m1", "h", binding)),
  ];
  return { events, binding, preset: p };
}

const build = ({ events }, logs = []) => replay([
  ...events,
  ...logs.map(([d, v, src]) => E(ev.log("h", "m1", d, v, src || SOURCE.MANUAL))),
]);

const statusOn = (state, d) => rawDayStatus(state, state.habits.get("h"), "m1", d);
const periodStatus = (state, d) => {
  const h = state.habits.get("h");
  return rawPeriodStatus(state, h, "m1", periodKey(d, h.period));
};

// ===========================================================================
// Adding it — the shape each preset arrives with
// ===========================================================================

test("no preset arrives with a target that makes it unplayable", () => {
  // The bug this pins. Every preset shared one default of 1, and only two of the nine were ever
  // corrected by tapping their own chip. So "Screen time" was a one-minute daily ceiling you fail
  // every day forever, "Vape puffs" was a limit of one, and "Active calories" was a goal of one
  // kcal that scored a guaranteed 100% on the board.
  for (const [key, p] of Object.entries(PRESETS)) {
    if (key === "custom") continue; // genuinely 1: "did the thing once"
    assert.ok(p.start > 1, key + " starts at " + p.start + ", which is not a real goal");
  }
});

test("cadence matches how the goal is actually spoken", () => {
  // "Exercise three times a week" is not "exercise 0.43 times a day", and a savings target is one
  // question at the end of the month rather than an interrogation every morning.
  assert.equal(PRESETS.sessions.period, PERIOD.WEEK);
  assert.equal(PRESETS.amount.period, PERIOD.MONTH);
  assert.equal(PRESETS.steps.period, PERIOD.DAY);
});

test("direction and aggregation are never a combination that cannot work", () => {
  for (const [key, p] of Object.entries(PRESETS)) {
    // A running total re-reported all day must be LAST, or every poll multiplies it. A count of
    // separate events must be SUM, or all but the last is thrown away.
    if (p.metric === METRIC.STEPS || p.metric === METRIC.SLEEP || p.metric === METRIC.SCREEN_MINUTES) {
      assert.equal(p.aggregate, AGGREGATE.LAST, key);
    }
    if (p.metric === METRIC.PUFFS || p.metric === METRIC.SESSIONS) {
      assert.equal(p.aggregate, AGGREGATE.SUM, key);
    }
  }
});

test("reduce presets stay off the board; build presets go on it", () => {
  // A leaderboard that ranks people on how badly they are losing a thing they are quitting
  // produces hidden logs, not quitting.
  for (const [key, p] of Object.entries(PRESETS)) {
    const s = build(add(key));
    assert.equal(s.habits.get("h").scored, p.direction === AT_LEAST, key);
  }
});

// ===========================================================================
// Who feeds it — the choice, and what it costs to get wrong
// ===========================================================================

test("on a full phone, the automatic presets bind to a sensor and the rest to the person", () => {
  const on = (key) => build(add(key)).bindings.get("m1|h");
  assert.equal(on("steps"), SOURCE.HEALTH_CONNECT);
  assert.equal(on("sleep"), SOURCE.HEALTH_CONNECT);
  assert.equal(on("calories"), SOURCE.HEALTH_CONNECT);
  assert.equal(on("screen"), SOURCE.PAUSE);
  assert.equal(on("opens"), SOURCE.PAUSE);
  // Nothing can read these, on any device, however capable.
  assert.equal(on("puffs"), SOURCE.MANUAL);
  assert.equal(on("sessions"), SOURCE.MANUAL);
  assert.equal(on("amount"), SOURCE.MANUAL);
  assert.equal(on("custom"), SOURCE.MANUAL);
});

test("a browser binds everything to the person, whatever the group's default says", () => {
  const web = { pause: false, health: false };
  for (const key of Object.keys(PRESETS)) {
    const { events, binding } = add(key, { device: web });
    assert.equal(binding, SOURCE.MANUAL, key);
    // The habit's own default still names the best possible source, so somebody joining later on
    // a real phone inherits something useful rather than this browser's limitations.
    const s = replay(events);
    if (HEALTH_METRICS.has(PRESETS[key].metric)) {
      assert.equal(s.habits.get("h").source, SOURCE.HEALTH_CONNECT, key);
    }
  }
});

test("choosing to log it by hand is honoured even when the device could do it", () => {
  // The point of making this a choice rather than an inference. Someone whose watch is unreliable
  // can say so, and then their quiet days are read as misses rather than excused as outages.
  const s = build(add("steps", { tracked: false }));
  assert.equal(sourceFor(s, s.habits.get("h"), "m1"), SOURCE.MANUAL);
  assert.equal(statusOn(s, day(0)), MISS);

  const auto = build(add("steps", { tracked: true }));
  assert.equal(statusOn(auto, day(0)), NO_DATA);
});

test("the choice is what decides whether a quiet day costs anything on the board", () => {
  // Same person, same silence, two bindings — and the board must not treat them alike.
  const rows = (state) => leaderboard(state, ["m1"], day(0), day(6), day(7))[0];
  const claimed = rows(build(add("steps", { tracked: false })));
  const sensed = rows(build(add("steps", { tracked: true })));
  assert.equal(claimed.pct, 0);      // said they would log it, and did not
  assert.equal(sensed.pct, null);    // the watch said nothing; nothing to score
  assert.equal(sensed.noData, 7);
});

// ===========================================================================
// Tracking it — one journey per type
// ===========================================================================

test("steps: a running total re-reported all day is not counted twice", () => {
  const s = build(add("steps"), [
    [day(0), 4000, SOURCE.HEALTH_CONNECT],
    [day(0), 9000, SOURCE.HEALTH_CONNECT],
    [day(0), 10400, SOURCE.HEALTH_CONNECT],
  ]);
  assert.equal(valueOn(s, s.habits.get("h"), "m1", day(0)), 10400);
  assert.equal(statusOn(s, day(0)), HIT);
});

test("sleep: seven hours meets a target stored in minutes", () => {
  const s = build(add("sleep"), [[day(0), 430, SOURCE.HEALTH_CONNECT]]);
  assert.equal(s.habits.get("h").target, 420);
  assert.equal(statusOn(s, day(0)), HIT);
  assert.equal(statusOn(build(add("sleep"), [[day(0), 400, SOURCE.HEALTH_CONNECT]]), day(0)), MISS);
});

test("calories: a real goal, not one that every day clears by breathing", () => {
  assert.equal(statusOn(build(add("calories"), [[day(0), 410, SOURCE.HEALTH_CONNECT]]), day(0)), HIT);
  assert.equal(statusOn(build(add("calories"), [[day(0), 120, SOURCE.HEALTH_CONNECT]]), day(0)), MISS);
});

test("puffs: separate events add up, and the limit is what they are judged against", () => {
  const under = build(add("puffs"), [[day(0), 5], [day(0), 6], [day(0), 4]]);
  assert.equal(valueOn(under, under.habits.get("h"), "m1", day(0)), 15);
  assert.equal(statusOn(under, day(0)), HIT);
  const over = build(add("puffs"), [[day(0), 12], [day(0), 11]]);
  assert.equal(statusOn(over, day(0)), MISS);
});

test("puffs: no entry is a failure, because the number existed and was not given", () => {
  // The vape keeps the count, so there is no such thing as a day the user could not report. The
  // commitment is to read it off and enter it; a blank day is a day that was not reported, and a
  // habit you can score full marks on by never opening the app is not a habit.
  const quiet = build(add("puffs", { over: { scored: true } }));
  assert.equal(statusOn(quiet, day(0)), MISS);

  // Under the goal is a success, and a clean day is entered as a zero like any other number.
  assert.equal(statusOn(build(add("puffs", { over: { scored: true } }), [[day(0), 0]]), day(0)), HIT);
  assert.equal(statusOn(build(add("puffs", { over: { scored: true } }), [[day(0), 15]]), day(0)), HIT);
  assert.equal(statusOn(build(add("puffs", { over: { scored: true } }), [[day(0), 25]]), day(0)), MISS);
});

test("screen time: Pause reports it, and a perfect day is a real zero", () => {
  const s = build(add("screen"), [[day(0), 0, SOURCE.PAUSE]]);
  assert.equal(statusOn(s, day(0)), HIT);
  assert.equal(statusOn(build(add("screen"), [[day(0), 200, SOURCE.PAUSE]]), day(0)), MISS);
  // Pause going silent is an outage, not a flawless day.
  assert.equal(statusOn(build(add("screen")), day(0)), NO_DATA);
});

test("app opens: the same, with its own budget", () => {
  assert.equal(statusOn(build(add("opens"), [[day(0), 12, SOURCE.PAUSE]]), day(0)), HIT);
  assert.equal(statusOn(build(add("opens"), [[day(0), 90, SOURCE.PAUSE]]), day(0)), MISS);
});

test("workouts: three in a week, on whichever days they happened", () => {
  // The reason this one is weekly. Rest days are not failures, and a daily version would mark
  // four of every seven days a miss for somebody doing exactly what they said they would.
  const s = build(add("sessions"), [[day(0), 1], [day(2), 1], [day(4), 1]]);
  const h = s.habits.get("h");
  assert.equal(valueForPeriod(s, h, "m1", periodKey(day(4), PERIOD.WEEK)), 3);
  assert.equal(periodStatus(s, day(4)), HIT);
  // Two is a miss for the week, not for the days in between.
  assert.equal(periodStatus(build(add("sessions"), [[day(0), 1], [day(2), 1]]), day(4)), MISS);
});

test("money saved: a balance, asked once at the end of the month", () => {
  // LAST, not SUM. Reporting 400 and then 1100 means you have 1100, not 1500.
  const s = build(add("amount"), [[day(0), 400], [day(10), 1100]]);
  const h = s.habits.get("h");
  assert.equal(valueForPeriod(s, h, "m1", periodKey(day(10), PERIOD.MONTH)), 1100);
  assert.equal(periodStatus(s, day(10)), HIT);
});

test("something else: no metric, so nothing automatic ever claims it", () => {
  const { events, binding } = add("custom");
  assert.equal(binding, SOURCE.MANUAL);
  const s = replay(events);
  assert.equal(s.habits.get("h").metric, null);
  assert.ok(!AUTOMATIC_SOURCES.has(sourceFor(s, s.habits.get("h"), "m1")));
  assert.equal(statusOn(build(add("custom"), [[day(0), 1]]), day(0)), HIT);
});

test("the breathing screen reaches every habit it is meant to, and no others", () => {
  // The bug: this used to require a Pause-SOURCED habit. Nothing can read vape puffs, so every
  // puffs habit created in the editor binds to manual — and the intervention was unreachable for
  // all of them. It only ever worked in the demo, where the binding was written by hand.
  const shape = (key) => build(add(key)).habits.get("h");
  assert.equal(isInterventionHabit(shape("puffs")), true);
  // Whoever feeds it is beside the point; the habit is the same habit.
  assert.equal(isInterventionHabit({ ...shape("puffs"), source: SOURCE.MANUAL }), true);
  assert.equal(isInterventionHabit({ ...shape("puffs"), source: SOURCE.PAUSE }), true);

  // A running total nobody interrupts, and a goal that is not a temptation.
  assert.equal(isInterventionHabit(shape("screen")), false);
  assert.equal(isInterventionHabit(shape("opens")), false);
  assert.equal(isInterventionHabit(shape("steps")), false);
  // Direction still has to make sense of it: "at least 20 puffs" is not something to resist.
  assert.equal(isInterventionHabit({ metric: METRIC.PUFFS, direction: AT_LEAST }), false);
});

// ===========================================================================
// Streaks — the same journey, run long enough to matter
// ===========================================================================

test("a build habit's streak counts the days it was done", () => {
  const logs = [0, 1, 2, 3, 4].map((n) => [day(n), 11000, SOURCE.HEALTH_CONNECT]);
  const w = walk(build(add("steps"), logs), "h", "m1", day(5));
  assert.equal(w.streak, 5);
});

test("a broken watch does not break a streak; a bad day does", () => {
  const outage = [[day(0), 11000, SOURCE.HEALTH_CONNECT], [day(1), 11000, SOURCE.HEALTH_CONNECT],
    /* day 2 silent */ [day(3), 11000, SOURCE.HEALTH_CONNECT], [day(4), 11000, SOURCE.HEALTH_CONNECT]];
  assert.equal(walk(build(add("steps"), outage), "h", "m1", day(5)).streak, 4);

  // A recorded bad day is different, and spends a grace token rather than being ignored.
  const real = [[day(0), 11000, SOURCE.HEALTH_CONNECT], [day(1), 11000, SOURCE.HEALTH_CONNECT],
    [day(2), 200, SOURCE.HEALTH_CONNECT], [day(3), 11000, SOURCE.HEALTH_CONNECT],
    [day(4), 11000, SOURCE.HEALTH_CONNECT]];
  const w = walk(build(add("steps"), real), "h", "m1", day(5));
  assert.ok(w.streak < 5 || w.spent.length > 0, "a real miss must cost something");
});

test("a weekly habit's streak counts weeks, not days", () => {
  const logs = [];
  for (let n = 0; n < 21; n += 1) if (n % 7 < 3) logs.push([day(n), 1]);
  const w = walk(build(add("sessions"), logs), "h", "m1", day(21));
  assert.equal(w.habit.period, PERIOD.WEEK);
  assert.equal(w.streak, 3);
});

test("a reduce habit's streak is built from the days you actually reported", () => {
  // Entering the number is part of it, so a run of reported days builds a streak and a run of
  // blank ones does not.
  const said = [0, 1, 2, 3, 4].map((n) => [day(n), 2]);
  assert.equal(walk(build(add("puffs", { over: { scored: true } }), said), "h", "m1", day(5)).streak, 5);
  assert.equal(walk(build(add("puffs", { over: { scored: true } })), "h", "m1", day(5)).streak, 0);
});

test("a silent automatic ceiling is still an outage, not a failure", () => {
  // The distinction survives: Pause going quiet is a broken pipeline and must not be scored as a
  // flawless day OR as a bad one. Only habits somebody promised to type in are failed by silence.
  assert.equal(statusOn(build(add("screen")), day(0)), NO_DATA);
  assert.equal(statusOn(build(add("screen", { tracked: false })), day(0)), MISS);
});

// ===========================================================================
// The board — what each type contributes once it gets there
// ===========================================================================

test("a habit is reduced to its own ratio before any weighting happens", () => {
  // Otherwise a daily habit's thirty results a month drown a monthly one's single result, and the
  // weight nobody set silently becomes 30 to 1.
  const daily = build(add("steps"), [0, 1, 2, 3].map((n) => [day(n), 11000, SOURCE.HEALTH_CONNECT]));
  const row = leaderboard(daily, ["m1"], day(0), day(3), day(4))[0];
  assert.equal(row.pct, 100);
  assert.equal(row.perHabit.length, 1);
  assert.equal(row.perHabit[0].ratio, 1);
});

test("an unscored habit never reaches the board at all", () => {
  const s = build(add("puffs"), [[day(0), 50]]); // a bad day on a habit that opts out
  assert.equal(leaderboard(s, ["m1"], day(0), day(3), day(4))[0].pct, null);
});

test("every preset survives a week of real use without a nonsense score", () => {
  // A sweep rather than a specific claim: nine types, a week each, nothing thrown, and no habit
  // scoring on days it was not yet asked about.
  for (const key of Object.keys(PRESETS)) {
    const p = PRESETS[key];
    const logs = [];
    for (let n = 0; n < 7; n += 1) {
      const src = AUTOMATIC_SOURCES.has(sourceForDevice(p.metric, { pause: true, health: true }))
        ? sourceForDevice(p.metric, { pause: true, health: true }) : SOURCE.MANUAL;
      logs.push([day(n), p.direction === AT_MOST ? Math.max(0, p.start - 5) : p.start + 5, src]);
    }
    const s = build(add(key, { over: { scored: true } }), logs);
    const row = leaderboard(s, ["m1"], day(0), day(6), day(7))[0];
    assert.ok(row.pct === null || (row.pct >= 0 && row.pct <= 100), key + " scored " + row.pct);
    assert.equal(row.pct, 100, key + " met its own target every day and did not score 100");
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
console.log("✓ habit journeys: " + passed + " tests passed");
