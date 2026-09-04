// demo.js — a believable three weeks, so the dashboard can be looked at before there is a backend.
//
// Reachable only via ?demo=1, and the header says so. It exists because the interesting states in
// this app take weeks to occur naturally — a spent grace token, a suppressed clown, a watch that
// stopped reporting — and those are exactly the states worth reviewing the design against.
//
// It builds a real event log and runs it through the real engine. Nothing here fakes a derived
// number, so if the leaderboard is wrong on this screen it is wrong in production too.

import { ev, METRIC, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, VISIBILITY, PERIOD } from "../schema.js";
import { replay, dayKey, addDays } from "../habits.js";

const TZ = "Africa/Johannesburg";
const DAY_START = 4;

/** 20:00 local on a given day key — when someone would plausibly have logged it. */
function evening(day, hour = 20) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - 2); // SAST is UTC+2 all year
}

let seq = 0;
function E(spec, ts) {
  seq += 1;
  return { eventId: "demo-" + String(seq).padStart(4, "0"), ts, seq, ...spec };
}

export const DEMO_ME = "me";

export function demoState(now = Date.now()) {
  seq = 0;
  const today = dayKey(now, TZ, DAY_START);
  const day = (n) => addDays(today, n);
  const start = day(-20);
  const t0 = evening(start, 7);

  const events = [
    E(ev.meta({ name: "The Accountability Club" }), t0),
    E(ev.member(DEMO_ME, "You"), t0),
    E(ev.member("thabo", "Thabo"), t0),
    E(ev.member("lerato", "Lerato"), t0),

    E(ev.habit("steps", {
      name: "Steps", icon: "👟", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      tz: TZ, dayStartHour: DAY_START, source: SOURCE.MANUAL, visibility: VISIBILITY.FULL,
    }), t0),
    E(ev.habit("sleep", {
      name: "Sleep", icon: "😴", metric: METRIC.SLEEP, direction: AT_LEAST, target: 420,
      tz: TZ, dayStartHour: DAY_START, source: SOURCE.MANUAL, visibility: VISIBILITY.FULL,
    }), t0),
    E(ev.habit("urges", {
      name: "Vape puffs", icon: "💨", metric: METRIC.PUFFS, direction: AT_MOST, target: 8,
      aggregate: AGGREGATE.SUM, tz: TZ, dayStartHour: DAY_START, source: SOURCE.PAUSE,
      visibility: VISIBILITY.PROGRESS,
      taper: { amount: 1, everyDays: 7, floor: 0 },
    }), t0),

    E(ev.habit("screen", {
      name: "Screen time", icon: "📱", metric: METRIC.SCREEN_MINUTES, direction: AT_MOST,
      target: 90, tz: TZ, dayStartHour: DAY_START, source: SOURCE.PAUSE,
      visibility: VISIBILITY.FULL,
    }), t0),

    // A weekly one, so the pace line has something to say: three a week, judged against the
    // whole number expected by tonight rather than against a fraction of a workout.
    E(ev.habit("gym", {
      name: "Workouts", icon: "🏋", metric: METRIC.SESSIONS, direction: AT_LEAST,
      target: 3, period: PERIOD.WEEK, aggregate: AGGREGATE.SUM, tz: TZ, dayStartHour: DAY_START,
      source: SOURCE.HEALTH_CONNECT, visibility: VISIBILITY.FULL,
    }), t0),

    // Two phones report automatically; the third types it in. This is the whole reason bindings
    // are per member rather than per habit.
    E(ev.bind(DEMO_ME, "steps", SOURCE.HEALTH_CONNECT), t0),
    E(ev.bind(DEMO_ME, "sleep", SOURCE.HEALTH_CONNECT), t0),
    E(ev.bind(DEMO_ME, "urges", SOURCE.PAUSE), t0),
    E(ev.bind(DEMO_ME, "gym", SOURCE.HEALTH_CONNECT), t0),
    E(ev.bind("thabo", "gym", SOURCE.HEALTH_CONNECT), t0),
    // Fed by the shell counting its own interventions, which is the binding that only exists
    // because the two apps became one.
    E(ev.bind(DEMO_ME, "screen", SOURCE.PAUSE), t0),
    E(ev.bind("thabo", "screen", SOURCE.PAUSE), t0),
    E(ev.bind("thabo", "steps", SOURCE.HEALTH_CONNECT), t0),
    E(ev.bind("thabo", "sleep", SOURCE.HEALTH_CONNECT), t0),
    E(ev.bind("lerato", "steps", SOURCE.HEALTH_CONNECT), t0),
  ];

  const log = (habitId, member, d, value, src) =>
    events.push(E(ev.log(habitId, member, d, value, src), evening(d)));

  // Explicit hits and misses rather than pseudo-random ones. The point of this fixture is to
  // show particular STATES — a spent grace token, a watch that went quiet — and a random walk
  // buries them. (An earlier version used n % k on negative n, which is negative in JavaScript
  // and quietly dragged every value just under target.)
  const yourStepMisses = new Set([-6, -13]);
  const yourSleepMisses = new Set([-2, -11, -17]);
  const spread = (n, span) => Math.abs(n * 89) % span;

  // The days the phone won. Chosen rather than generated, because the point of the fixture is to
  // make the correlation card appear with a real split behind it — seven heavy days against
  // fourteen light ones, which is above the minimum on both sides and so gets an answer.
  //
  // Two of them are also step misses, which matters: the card must not read as "phone use causes
  // fewer steps" on a fixture where the overlap was arranged. It says what the days did, and the
  // overlap here is deliberately partial so the sentence stays a comparison.
  const heavyPhone = new Set([-19, -16, -13, -9, -6, -3, -1]);

  for (let n = -20; n <= 0; n += 1) {
    const d = day(n);

    // Thabo: the metronome. Earns the crown honestly.
    log("steps", "thabo", d, 10400 + spread(n, 2600), SOURCE.HEALTH_CONNECT);
    if (n % 9 !== 0) log("sleep", "thabo", d, 432 + spread(n, 46), SOURCE.HEALTH_CONNECT);

    // You: strong, with two real misses. The older one is covered by a banked grace token, which
    // is the case worth being able to see — a streak that survived, and said so.
    log("steps", DEMO_ME, d, yourStepMisses.has(n) ? 6800 : 10300 + spread(n, 2400), SOURCE.HEALTH_CONNECT);
    log("sleep", DEMO_ME, d, yourSleepMisses.has(n) ? 372 : 426 + spread(n, 40), SOURCE.HEALTH_CONNECT);

    // Lerato: patchier — and for the last two days a watch that has simply stopped reporting.
    // Nothing arrived, so nothing can be scored, and the clown has nowhere fair to land.
    if (n < -1) log("steps", "lerato", d, n % 2 === 0 ? 10600 + spread(n, 1800) : 8300, SOURCE.HEALTH_CONNECT);

    // Screen time, counted by Pause itself. Two days missing near the start: the shell was not
    // reporting yet, and those days have to read as NO_DATA rather than as perfect ones.
    if (n > -19) {
      log("screen", DEMO_ME, d, heavyPhone.has(n) ? 140 + spread(n, 70) : 44 + spread(n, 38), SOURCE.PAUSE);
      log("screen", "thabo", d, 52 + spread(n, 30), SOURCE.PAUSE);
    }

    // Urges: the intervention screen resolving. 0 = resisted, 1 = gave in.
    const gaveIn = spread(n, 4);
    for (let i = 0; i < 6; i += 1) {
      events.push(E(ev.log("urges", DEMO_ME, d, i < gaveIn ? 1 : 0, SOURCE.PAUSE, "u" + n + "-" + i), evening(d, 9 + i * 2)));
    }
  }

  // Sessions carry the source's own id, so re-reporting one is harmless and two on a day are two.
  for (const n of [-6, -4, -1]) {
    events.push(E(ev.log("gym", DEMO_ME, day(n), 1, SOURCE.HEALTH_CONNECT, "w" + n), evening(day(n), 18)));
  }
  for (const n of [-5, -2]) {
    events.push(E(ev.log("gym", "thabo", day(n), 1, SOURCE.HEALTH_CONNECT, "t" + n), evening(day(n), 7)));
  }

  // A goal change, so the feed has one. It is the one thing somebody can do that moves their own
  // score without doing anything, and until recently it was completely silent.
  events.push(E(ev.goal("lerato", "steps", { target: 8000 }), evening(day(-3), 21)));

  // A trip that must not cost anyone their streak.
  events.push(E(ev.exempt("thabo", day(-4), day(-2), "travel"), evening(day(-5))));

  return { state: replay(events), events, today, me: DEMO_ME };
}
