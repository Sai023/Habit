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
  MANUAL:         "manual",
};
export const AUTOMATIC_SOURCES = new Set([SOURCE.HEALTH_CONNECT, SOURCE.STRAVA, SOURCE.PAUSE]);

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
  days: [1, 2, 3, 4, 5, 6, 7],   // ISO weekdays the habit is active (1 = Mon .. 7 = Sun)
  dayStartHour: 4,               // 01:00 counts as yesterday — see dayKey()
  tz: "Africa/Johannesburg",     // PINNED, not read from the device: travel must not move the boundary
  source: SOURCE.MANUAL,
  aggregate: "last",           // see AGGREGATE — urges and workouts want "sum"
  visibility: VISIBILITY.PROGRESS,
  scored: null,                  // null = decide from direction (reduce habits opt OUT by default)
  grace: { earnEvery: 7, cap: 2 },
  taper: null,                   // { amount: 1, everyDays: 7, floor: 0 }
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
