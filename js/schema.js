// schema.js — the event vocabulary, and the rules that keep old clients safe.
//
// Habit events ride in the SAME append-only `public.events` table as Passport's trip events
// (see supabase/schema.sql in the passport repo): one generic row of {uuid, code, type, author,
// ts, payload}. Reusing it means push_events/pull_events, the RLS model, the per-room cursors
// and the daily keepalive all work here with no new SQL at all.
//
// Two rules make that reuse safe:
//
//   1. Every type is prefixed `habit_`, so the two domains can never be confused by a reader
//      of either log, and Passport's analytics views (which filter on expense types) are
//      untouched.
//   2. Every payload carries `v`. A client that meets a type or a version it does not know
//      IGNORES the event rather than throwing — see replay() in habits.js. Pause ships as a
//      sideloaded APK to three phones that will not all update on the same day, so an old
//      build MUST degrade quietly instead of corrupting a shared log.

export const SCHEMA_VERSION = 1;

/** Event types. Anything not in here is ignored on replay (forward compatibility). */
export const T = {
  META:         "habit_meta",         // group name + group-wide settings (last write wins)
  MEMBER:       "habit_member",       // someone joined, or renamed themselves
  HABIT_DEF:    "habit_def",          // a habit's definition (last write wins per habitId)
  HABIT_DELETE: "habit_def_delete",   // retire a habit; its logs stay for history
  LOG:          "habit_log",          // ONE observation for one member, habit and day
  EXEMPT:       "habit_exempt",       // travel mode / planned rest — a range of days
  BINDING:      "habit_source",       // which source feeds one habit FOR ONE MEMBER
  GOAL:         "habit_goal",         // one member's own target, and whether they track it
};

/**
 * What a habit measures. The metric is group-wide (everyone's "Steps" means steps); the SOURCE
 * that supplies it is per member, because the same group has two phones on Health Connect and one
 * that types it in. See T.BINDING.
 *
 * Canonical units, so a target means the same thing whoever reported it:
 *   steps            a count
 *   sleep_minutes    minutes (Health Connect reports a duration; the native side converts)
 *   active_calories  kcal
 *   urges            a count of discrete events
 */
export const METRIC = {
  STEPS: "steps",
  SLEEP: "sleep_minutes",
  ACTIVE_CALORIES: "active_calories",
  PUFFS: "puffs",                 // puffs off the vape, counted through the day
  APP_OPENS: "app_opens",         // Pause already counts these
  SCREEN_MINUTES: "screen_minutes",
  SESSIONS: "sessions",           // workouts, meditations — things you did N of
  AMOUNT: "amount",               // money saved, in whatever the group counts in
};

/**
 * How long a habit gets to be judged over.
 *
 * Not every commitment is daily, and forcing one to be makes it a lie. "Exercise three times
 * a week" is not "exercise 0.43 times a day", and a savings target is a single question asked
 * once a month. A period changes what a streak counts, what a miss means, and — most of all —
 * how the leaderboard combines habits that produce wildly different numbers of results.
 */
export const PERIOD = { DAY: "day", WEEK: "week", MONTH: "month" };

/**
 * The six things the board is willing to score.
 *
 * ---- Why a fixed list ----
 *
 * Every habit used to count. `scored` defaulted to true, so anything anybody invented took a share
 * of the day and a place in the standings — and because the four category weights are fixed and
 * split between whatever is eligible, one person adding "read 20 pages" quietly re-weighted the
 * day for themselves against everybody else. Two people in one group could be running the same
 * habits and be scored on different arithmetic.
 *
 * A competition needs the same events for everyone. These are the six, and they are the ones the
 * group agreed on rather than the ones the engine happens to understand: ACTIVE_CALORIES and
 * APP_OPENS are both perfectly measurable and neither is on the list — app opens because "opens"
 * and "screen time" sitting side by side is a distinction nobody wants to have to draw.
 *
 * Anything else is still worth tracking. It shows on Today, it keeps its streak, and it is simply
 * not part of the contest — which the new-habit screen and the board both say out loud, because a
 * habit that silently does not count is worse than one you cannot create.
 */
export const SCORED_METRICS = new Set([
  METRIC.STEPS,
  METRIC.SLEEP,
  METRIC.SESSIONS,        // workouts
  METRIC.AMOUNT,          // savings
  METRIC.PUFFS,
  METRIC.SCREEN_MINUTES,
]);

/**
 * Metrics that no longer exist, and what they became.
 *
 * `urges` counted "times you gave in" and was meant for single digits. In practice the group used
 * it as a puff counter — a ceiling of eighty with seventy-eight logged on an ordinary day — so the
 * name described something nobody was measuring. Retiring it is a RENAME, not a unit change: the
 * numbers already were puffs, the category was already Discipline, and the breathing screen
 * already treated it the same way, so every past log keeps its meaning exactly.
 *
 * Applied at replay rather than by rewriting the room. The log is append-only and every device
 * replays all of it, so translating on read migrates all three phones at once and leaves the
 * history honest about what was actually written.
 */
export const LEGACY_METRIC = { urges: METRIC.PUFFS };

/**
 * Grace scales with the period, or it means nothing.
 *
 * One token per seven clean days is a fortnight of good behaviour for a daily habit. Applied
 * to a monthly goal it would be seven months, which nobody will ever reach; applied the other
 * way it would forgive a third of the year.
 */
export const GRACE_BY_PERIOD = {
  [PERIOD.DAY]: { earnEvery: 7, cap: 2 },
  [PERIOD.WEEK]: { earnEvery: 4, cap: 1 },
  [PERIOD.MONTH]: { earnEvery: 3, cap: 1 },
};

/** Goal direction. `at_least` counts up to a target; `at_most` stays under a ceiling. */
export const AT_LEAST = "at_least";
export const AT_MOST = "at_most";

/**
 * Where an observation came from. The distinction is load-bearing, not cosmetic: an AUTOMATIC
 * source that reports nothing for a day means the pipeline was silent, which is NOT the same as
 * the user failing. A MANUAL source reporting nothing means they did not log it, which is.
 * See dayStatus() in habits.js.
 */
export const SOURCE = {
  HEALTH_CONNECT: "health_connect",
  STRAVA:         "strava",
  PAUSE:          "pause",    // the intervention screen (urges resisted / given in)
  // The phone worked it out from its own behaviour rather than reading a sensor: sleep, guessed
  // from how long it was left alone overnight. Distinct from PAUSE, which means this app counted
  // something it did itself — one is a measurement, the other an inference, and a person is
  // entitled to know which they are being scored on.
  PHONE:          "phone",
  MANUAL:         "manual",
};
export const AUTOMATIC_SOURCES = new Set([
  SOURCE.HEALTH_CONNECT, SOURCE.STRAVA, SOURCE.PAUSE, SOURCE.PHONE,
]);

/**
 * What the phone can work out on its own, without a watch.
 *
 * Only sleep, and only as a fallback. A watch answers it properly — but most people take theirs
 * off at night, which is the one night it needed to be on, and the phone is on the bedside table
 * whether or not anybody decided it should be.
 */
export const PHONE_ESTIMATED = new Set([METRIC.SLEEP]);

/** What a watch can answer for, and what only the Pause shell can. */
export const HEALTH_METRICS = new Set([
  METRIC.STEPS, METRIC.SLEEP, METRIC.ACTIVE_CALORIES,
  // Health Connect keeps exercise sessions, which Samsung Health writes into. A workout is the
  // one health metric that is a COUNT OF EVENTS rather than a running total, so the shell sends
  // one row per session carrying Health Connect's own id and the engine de-duplicates on it.
  METRIC.SESSIONS,
]);
export const PAUSE_METRICS = new Set([METRIC.APP_OPENS, METRIC.SCREEN_MINUTES]);

/**
 * Which source THIS device can honestly claim to feed a metric from.
 *
 * A binding is a promise about where a number will come from, and the engine keeps it: an
 * automatic source that goes quiet is NO_DATA — a pipeline that broke rather than a person who
 * failed — while a manual one going quiet is a plain miss. Bind a browser to a watch it does not
 * have and every honest miss it ever records gets excused as an outage.
 *
 * The mirror of `bindingSourceFor` in the Kotlin shell, and it has to stay one: both sides write
 * bindings for the same member into the same log, so disagreeing about what this phone is would
 * have them overwriting each other every time either ran.
 */
/**
 * Is this a habit the breathing screen can interrupt?
 *
 * A rule about the habit's SHAPE, not about who feeds it. An urge is a discrete thing that happens
 * and can be talked out of; screen time is a running total nobody interrupts, and steps are not a
 * temptation. Keying this off the source instead meant it only ever fired for habits whose binding
 * had been written by hand, which no habit created in the app ever has.
 */
export function isInterventionHabit(habit) {
  if (!habit || habit.direction !== AT_MOST) return false;
  return habit.metric === METRIC.PUFFS;
}

export function sourceForDevice(metric, { pause = false, health = false } = {}) {
  if (PAUSE_METRICS.has(metric)) return pause ? SOURCE.PAUSE : SOURCE.MANUAL;
  if (HEALTH_METRICS.has(metric)) {
    if (health) return SOURCE.HEALTH_CONNECT;
    // A real automatic source rather than a consolation prize, and only inside the shell — a
    // browser tab cannot watch a screen go dark. The shell will not show its own habit screens
    // until the accessibility service is on, so being embedded is the same statement as being able
    // to observe this.
    if (pause && PHONE_ESTIMATED.has(metric)) return SOURCE.PHONE;
    return SOURCE.MANUAL;
  }
  return SOURCE.MANUAL;
}

/** How much of a habit the rest of the group can see. */
export const VISIBILITY = { FULL: "full", PROGRESS: "progress", PRIVATE: "private" };

/**
 * How a day's readings combine. This is not a detail — getting it wrong silently multiplies or
 * discards real data:
 *   LAST  each reading is the day's running TOTAL (Health Connect steps, sleep). Summing them
 *         would count the same steps every time the watch syncs.
 *   SUM   each reading is one discrete thing that happened (an urge, a workout). Taking the last
 *         would throw away everything but the most recent one.
 */
export const AGGREGATE = { LAST: "last", SUM: "sum" };

/**
 * A log authored more than this many days after the day it describes is ignored.
 *
 * This is what stops history being rewritten — without it, anyone could win last week's crown on
 * Tuesday. It keys off the event's OWN timestamp (when the observation was made), not when it
 * synced, so a phone that was offline for a week still backfills correctly: Health Connect read
 * Monday's steps on Monday, even if the row only reached the server on Friday.
 */
export const MAX_BACKFILL_DAYS = 2;

/** Defaults for a new habit. Every one of these is overridable per habit in the editor. */
export const HABIT_DEFAULTS = {
  direction: AT_LEAST,
  target: 1,
  period: PERIOD.DAY,            // day | week | month — see PERIOD
  weight: 1,                     // how much this habit counts on the board, relative to the rest
  days: [1, 2, 3, 4, 5, 6, 7],   // ISO weekdays the habit is active. Daily habits only.
  dayStartHour: 4,               // 01:00 counts as yesterday — see dayKey()
  tz: "Africa/Johannesburg",     // PINNED, not read from the device: travel must not move the boundary
  metric: null,                  // null = nothing automatic can feed it; see METRIC
  source: SOURCE.MANUAL,         // the DEFAULT binding; a member can override it (T.BINDING)
  aggregate: "last",           // see AGGREGATE — urges and workouts want "sum"
  visibility: VISIBILITY.PROGRESS,
  scored: null,                  // null = decide from direction (reduce habits opt OUT by default)
  grace: { earnEvery: 7, cap: 2 },
  // How a ceiling comes down over time. Null for a habit that does not taper.
  //
  //   { amount: 1,  everyDays: 7, floor: 0 }   minus one a week
  //   { percent: 10, everyDays: 7, floor: 0 }  minus a tenth of the ORIGINAL a week — linear, so
  //                                            eighty reaches zero in ten weeks rather than
  //                                            asymptoting the way compounding would
  //
  // The schedule runs from the MEMBER's baseline (their first goal), not the habit's birthday, so
  // somebody joining a six-month-old habit starts at the top of their own taper.
  taper: null,
  // Which weekdays the REMINDER fires on, or null for "the same days it is scored".
  //
  // Separate from `days` on purpose. For a daily habit the two coincide and null says so — the
  // days it nudges you are the days it judges you, which is the property `days` was given to
  // preserve. A weekly habit is different: "three workouts a week" says nothing about which three,
  // so the engine ignores `days` entirely for it, and a reminder had no choice but to fire every
  // morning. Writing the answer into `days` instead would have been the cheap fix and a bad one —
  // it is read by the taper's miss count, so "remind me Mon/Wed/Fri" would have started changing
  // what counts as a missed day.
  remindDays: null,
  // Minute of the day to be reminded, or null for no reminder. On the HABIT rather than in a
  // settings screen, so the days it nudges you are by construction the days it scores — a reminder
  // kept somewhere else drifts away from the commitment the moment either one is edited.
  remindAt: null,
  // Which of the four category shares it counts towards. Null means "work it out from the metric",
  // which is right for everything except the ones that are a judgement — reading is rest, not
  // fitness, and no metric can say so.
  category: null,
};

/** Build a payload with the version stamp every event needs. */
const p = (obj) => ({ v: SCHEMA_VERSION, ...obj });

export const ev = {
  meta:      (fields) => ({ type: T.META,         payload: p(fields) }),
  member:    (memberId, name) => ({ type: T.MEMBER, payload: p({ memberId, name }) }),
  habit:     (habitId, fields) => ({ type: T.HABIT_DEF, payload: p({ habitId, ...fields }) }),
  deleteHabit: (habitId) => ({ type: T.HABIT_DELETE, payload: p({ habitId }) }),

  /**
   * One observation. `day` is a day KEY (see dayKey()), not a date — the two differ whenever
   * dayStartHour is not midnight, which is most of the time.
   */
  log: (habitId, memberId, day, value, source, externalId = null) =>
    ({ type: T.LOG, payload: p({ habitId, memberId, day, value: Number(value) || 0, source, externalId }) }),

  /**
   * Bind a member's device to a source for one habit.
   *
   * This has to be per member, not per habit: in a group with two Samsung phones and one older
   * one, the same "Steps" habit is fed by Health Connect for two people and typed in by the
   * third — and the difference decides whether a silent day reads as NO_DATA or as a real miss.
   */
  bind: (memberId, habitId, source) =>
    ({ type: T.BINDING, payload: p({ memberId, habitId, source }) }),

  /**
   * One member's own goal for a shared habit.
   *
   * The group agrees on WHAT it is tracking; each person sets their own number. Ten thousand steps
   * is a stretch for one of them and a slow morning for another, and scoring both against the same
   * figure measures fitness rather than effort — which is not what anybody joined for.
   *
   * `active: false` means they are not doing this one at all, which is different from failing it.
   */
  goal: (memberId, habitId, { target, active = true } = {}) =>
    ({ type: T.GOAL, payload: p({ memberId, habitId, target, active }) }),

  /** Travel mode or a planned rest. `habitId` null exempts every habit. */
  exempt: (memberId, from, to, reason = "travel", habitId = null) =>
    ({ type: T.EXEMPT, payload: p({ memberId, habitId, from, to, reason }) }),
};

/** Is this a habit event this build understands? Used by replay() to skip the rest. */
export function isKnown(type, payload) {
  if (!Object.values(T).includes(type)) return false;
  const v = Number(payload && payload.v) || 1;
  return v <= SCHEMA_VERSION;
}
