// habits.js — pure functions. Given the group's event log, derive everything the UI shows.
//
// Nothing here touches storage, the network or the DOM, so the whole streak/grace/leaderboard
// model is testable with node built-ins and every device derives byte-identical results from the
// same log. That property is the entire reason this is a function and not a database trigger.
//
// ---- Why not a trigger ----
//
// Events arrive OUT OF ORDER by design: the offline queue drains days late, a watch backfills
// last night's sleep this morning, and (if it is ever built) a Strava webhook can land Tuesday's
// ride on Thursday. A trigger fires in INSERT order, so it would already have burned a grace
// token on a Tuesday that turns out to have been completed. Deriving on read, by walking days in
// CALENDAR order, is correct under any arrival order.
//
// ---- The four states ----
//
//   HIT      the day's value met the target, direction-aware
//   MISS     it did not, and we can tell
//   NO_DATA  an automatic source reported nothing — never breaks a streak, never counts as a hit
//   EXEMPT   a rest day, Travel Mode, or a grace token spent
//
// NO_DATA is the load-bearing one. Without it the friend on the older phone with the harder sync
// path loses their streak to a pipeline outage rather than to anything they did — which is also
// exactly the person the leaderboard would otherwise punish.

import {
  T, AT_LEAST, AT_MOST, AUTOMATIC_SOURCES, VISIBILITY, AGGREGATE, SOURCE,
  HEALTH_METRICS, PAUSE_METRICS, isInterventionHabit,
  PERIOD, GRACE_BY_PERIOD, MAX_BACKFILL_DAYS, HABIT_DEFAULTS, isKnown,
} from "./schema.js";

export const HIT = "HIT";
export const MISS = "MISS";
export const NO_DATA = "NO_DATA";
export const EXEMPT = "EXEMPT";

const MAX_WALK_DAYS = 400; // guard: nothing should ever walk further back than this

// ============================================================================
// Calendar helpers — day KEYS, not dates
// ============================================================================

const _fmt = new Map();
function formatter(tz) {
  let f = _fmt.get(tz);
  if (!f) {
    // "en-CA" formats as YYYY-MM-DD, which is exactly what we want a key to look like.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
    });
    _fmt.set(tz, f);
  }
  return f;
}

/**
 * The day an instant belongs to, in a PINNED timezone, with a configurable day start.
 *
 * Two edge cases this exists to kill:
 *   - 23:30 in Johannesburg is already tomorrow in UTC. A UTC date key silently moves half the
 *     group's evening activity onto the wrong day.
 *   - A puff at 01:00 belongs to yesterday in every human's mental model. dayStartHour (default
 *     04:00) makes the app agree with them.
 *
 * The timezone is a habit setting rather than the device's, so flying somewhere does not stretch
 * or squash a day and hand someone two chances at the same streak.
 */
export function dayKey(ts, tz = "UTC", dayStartHour = 0) {
  const parts = formatter(tz).formatToParts(new Date(ts));
  const get = (type) => parts.find((x) => x.type === type).value;
  const date = get("year") + "-" + get("month") + "-" + get("day");
  const hour = Number(get("hour")) % 24; // some ICU builds emit "24" for midnight
  return hour < dayStartHour ? addDays(date, -1) : date;
}

/** Calendar arithmetic on a day key. Pure string in, pure string out — no timezone involved. */
export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const pad = (x) => String(x).padStart(2, "0");
  return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate());
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export function isoDayOfWeek(day) {
  const [y, m, d] = day.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

// ============================================================================
// Periods — the unit a habit is actually judged over
// ============================================================================
//
// Not every commitment is daily, and forcing one to be makes it a lie: "exercise three times a
// week" is not "exercise 0.43 times a day", and a savings target is one question asked once a
// month. A period key is a day ("2026-03-02"), an ISO week ("2026-W10") or a month ("2026-03"),
// and status, streaks, grace and the board all work in whichever one a habit uses.
//
// Logs are unchanged: they still carry a day, and the period is derived from it. That is
// deliberate — changing a habit from daily to weekly must not orphan its history.

const MS_DAY = 86400000;

function utcOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function dayOf(ms) {
  const dt = new Date(ms);
  const pad = (x) => String(x).padStart(2, "0");
  return dt.getUTCFullYear() + "-" + pad(dt.getUTCMonth() + 1) + "-" + pad(dt.getUTCDate());
}

/**
 * The ISO week a day belongs to, as "YYYY-Www".
 *
 * ISO rather than "the week containing 1 January", because that convention produces a one- or
 * two-day stub week at the turn of the year — a week a weekly target cannot physically be met in,
 * handing everyone a guaranteed miss every new year.
 */
export function isoWeekKey(day) {
  const monday = utcOf(day) - (isoDayOfWeek(day) - 1) * MS_DAY;
  const thursday = monday + 3 * MS_DAY; // the week's Thursday decides which year it belongs to
  const isoYear = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * MS_DAY;
  const week = Math.round((monday - week1Monday) / (7 * MS_DAY)) + 1;
  return isoYear + "-W" + String(week).padStart(2, "0");
}

/** Which period a day falls in, for a habit on that cadence. */
export function periodKey(day, period) {
  if (period === PERIOD.MONTH) return day.slice(0, 7);
  if (period === PERIOD.WEEK) return isoWeekKey(day);
  return day;
}

/** The first day of a period. */
export function periodStart(key, period) {
  if (period === PERIOD.MONTH) return key + "-01";
  if (period === PERIOD.WEEK) {
    const [y, w] = key.split("-W").map(Number);
    const jan4 = Date.UTC(y, 0, 4);
    const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * MS_DAY;
    return dayOf(week1Monday + (w - 1) * 7 * MS_DAY);
  }
  return key;
}

/** The last day of a period. */
export function periodEnd(key, period) {
  if (period === PERIOD.MONTH) {
    const [y, m] = key.split("-").map(Number);
    return dayOf(Date.UTC(y, m, 1) - MS_DAY); // the day before the first of next month
  }
  if (period === PERIOD.WEEK) return addDays(periodStart(key, period), 6);
  return key;
}

/** Every day in a period, in order. */
export function daysInPeriod(key, period) {
  if (period === PERIOD.DAY) return [key];
  const out = [];
  const last = periodEnd(key, period);
  for (let d = periodStart(key, period); daysBetween(d, last) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The distinct periods a range of days touches, in order. */
export function periodsBetween(fromDay, toDay, period) {
  const out = [];
  let previous = null;
  for (let d = fromDay; daysBetween(d, toDay) >= 0; d = addDays(d, 1)) {
    const key = periodKey(d, period);
    if (key !== previous) { out.push(key); previous = key; }
  }
  return out;
}

// ============================================================================
// Event ordering
// ============================================================================

/**
 * Replay order, clamped to the server's view of when it saw each event.
 *
 * A device whose clock runs FAST would otherwise stamp its writes into the future and win every
 * last-write-wins race, even against someone who acted afterwards having seen the change. Taking
 * min(client ts, server arrival) clamps that down; a SLOW clock keeps its earlier stamp and loses,
 * which is the safe direction to be wrong in. `seq` then the id break ties, so the order is total
 * and identical on every device. (Same rule as Passport's model.js — deliberately.)
 */
export function orderKey(e) {
  const ts = Number(e && e.ts) || 0;
  const serverTs = Number(e && e.serverTs) || 0;
  return serverTs ? Math.min(ts, serverTs) : ts;
}

export function sortEvents(list) {
  return (list || []).slice().sort((a, b) => {
    const ka = orderKey(a), kb = orderKey(b);
    if (ka !== kb) return ka - kb;
    const sa = typeof a.seq === "number" ? a.seq : Infinity;
    const sb = typeof b.seq === "number" ? b.seq : Infinity;
    if (sa !== sb) return sa - sb;
    return String(a.eventId || "").localeCompare(String(b.eventId || ""));
  });
}

// ============================================================================
// Replay
// ============================================================================

function normalizeHabit(p, createdDay) {
  const h = { ...HABIT_DEFAULTS, ...p, createdDay };
  h.days = Array.isArray(h.days) && h.days.length ? h.days.map(Number) : HABIT_DEFAULTS.days;
  h.period = Object.values(PERIOD).includes(h.period) ? h.period : PERIOD.DAY;
  h.weight = Number(h.weight) > 0 ? Number(h.weight) : 1;
  // Grace defaults to the cadence rather than to a constant: one token per seven clean MONTHS is
  // unreachable, and one per seven clean days applied to a weekly habit forgives a third of the
  // year. An explicit setting still wins.
  h.grace = { ...(GRACE_BY_PERIOD[h.period] || HABIT_DEFAULTS.grace), ...(p.grace || {}) };
  h.target = Number(h.target) || 0;
  h.dayStartHour = Number.isFinite(Number(h.dayStartHour)) ? Number(h.dayStartHour) : 4;
  h.remindAt = Number.isFinite(Number(p.remindAt)) && Number(p.remindAt) >= 0
    ? Math.min(1439, Math.round(Number(p.remindAt)))
    : (p.remindAt === null ? null : (h.remindAt ?? null));
  // Reduce habits opt OUT of crown/clown by default. Being bottom of a quitting metric produces
  // hidden and falsified logs, not quitting — so scoring one takes a deliberate opt-in.
  h.scored = p.scored == null ? h.direction === AT_LEAST : Boolean(p.scored);
  return h;
}

const logKey = (habitId, memberId, day) => habitId + "|" + memberId + "|" + day;

/**
 * Fold the log into the current picture of the group. Unknown event types and future schema
 * versions are SKIPPED, never thrown on: three sideloaded phones will not all update on the same
 * day, and an old build must degrade quietly rather than corrupt a shared log.
 */
export function replay(events) {
  const habits = new Map();
  const members = new Map();
  const logs = new Map();     // "habit|member|day" -> [{ source, value, ts, externalId }]
  const exemptions = [];
  const bindings = new Map();  // "member|habit" -> source
  const goals = new Map();     // "member|habit" -> { target, active }
  let meta = {};

  for (const e of sortEvents(events)) {
    const p = e.payload || {};
    if (!isKnown(e.type, p)) continue;

    switch (e.type) {
      case T.META:
        meta = { ...meta, ...p };
        break;

      case T.MEMBER:
        if (p.memberId) members.set(p.memberId, { memberId: p.memberId, name: p.name || p.memberId });
        break;

      case T.HABIT_DEF: {
        if (!p.habitId) break;
        const prev = habits.get(p.habitId);
        // A habit's birthday is set once, by its first definition. Later edits must not move it,
        // or every taper step and every streak start would shift with a rename.
        const tz = p.tz || (prev && prev.tz) || HABIT_DEFAULTS.tz;
        const startHour = p.dayStartHour != null ? p.dayStartHour
          : (prev ? prev.dayStartHour : HABIT_DEFAULTS.dayStartHour);
        const createdDay = prev ? prev.createdDay : dayKey(e.ts, tz, startHour);
        const next = normalizeHabit({ ...(prev || {}), ...p }, createdDay);
        // The same cheat one level up: the group's target is the fallback for anybody without a
        // goal of their own, and editing it re-scored all of history too. A habit's first
        // definition counts from its birthday; later changes to the number count from the next
        // day, exactly like a personal goal.
        const targets = (prev && prev.targets) ? prev.targets.slice() : [];
        if (!targets.length) {
          targets.push({ from: createdDay, target: next.target });
        } else if (targets[targets.length - 1].target !== next.target) {
          targets.push({ from: addDays(dayKey(e.ts, tz, startHour), 1), target: next.target });
        }
        next.targets = targets;
        habits.set(p.habitId, next);
        break;
      }

      case T.HABIT_DELETE:
        habits.delete(p.habitId);
        break;

      case T.LOG: {
        if (!p.habitId || !p.memberId || !p.day) break;
        const h = habits.get(p.habitId);
        const tz = (h && h.tz) || HABIT_DEFAULTS.tz;
        const startHour = h ? h.dayStartHour : HABIT_DEFAULTS.dayStartHour;
        // Reject a log authored long after the day it describes. This is what stops history being
        // rewritten — otherwise last week's crown is winnable on Tuesday. It keys off when the
        // OBSERVATION was made, not when it synced, so a week offline still backfills correctly.
        const authoredDay = dayKey(e.ts, tz, startHour);
        if (daysBetween(p.day, authoredDay) > MAX_BACKFILL_DAYS) break;

        const k = logKey(p.habitId, p.memberId, p.day);
        if (!logs.has(k)) logs.set(k, []);
        logs.get(k).push({
          source: p.source || "manual",
          value: Number(p.value) || 0,
          ts: e.ts,
          externalId: p.externalId || null,
        });
        break;
      }

      case T.BINDING:
        if (p.memberId && p.habitId && p.source) bindings.set(p.memberId + "|" + p.habitId, p.source);
        break;

      case T.GOAL: {
        if (!p.memberId || !p.habitId) break;
        const key = p.memberId + "|" + p.habitId;
        const list = goals.get(key) || [];
        const h = habits.get(p.habitId);
        const tz = (h && h.tz) || HABIT_DEFAULTS.tz;
        const startHour = h ? h.dayStartHour : HABIT_DEFAULTS.dayStartHour;
        const authored = dayKey(e.ts, tz, startHour);
        const previous = list.length ? list[list.length - 1] : {};
        list.push({
          // WHEN it starts counting, which used to be "always, including every day already
          // behind you". A goal is one number that the whole of a member's history was scored
          // against, latest value wins, so a bad week could be turned into a good one by lowering
          // the number on Sunday night — and `active: false` was better still, because it made
          // every past day EXEMPT and deleted the week outright. Off, then on again, and it was
          // gone. Nothing in the log said it had happened.
          //
          // Setting a goal for the first time is not changing one: it counts from that day, or a
          // joiner's first day would be judged against a number they never chose. Every change
          // after that counts from the next day, so today is always scored against what was
          // already true when it started.
          from: list.length ? addDays(authored, 1) : authored,
          // An edit sends only what changed, so a target left out keeps the old one rather than
          // silently reverting this person to the group's default.
          target: p.target != null ? Number(p.target) : previous.target,
          active: p.active != null ? Boolean(p.active) : (previous.active !== false),
          setOn: authored,
        });
        goals.set(key, list);
        break;
      }

      case T.EXEMPT:
        if (p.memberId && p.from && p.to) {
          // "I was away last week" is not something that can be decided after the week. Travel is
          // known in advance or within a day or two of getting back, and without this an exemption
          // was the cleanest cheat in the app: any run of bad days could simply be excused, after
          // the fact, by the person who had them. Same window logs get, for the same reason.
          const eh = habits.get(p.habitId);
          const etz = (eh && eh.tz) || HABIT_DEFAULTS.tz;
          const eStart = eh ? eh.dayStartHour : HABIT_DEFAULTS.dayStartHour;
          if (daysBetween(p.from, dayKey(e.ts, etz, eStart)) > MAX_BACKFILL_DAYS) break;
          exemptions.push({
            memberId: p.memberId,
            habitId: p.habitId || null,
            from: p.from, to: p.to,
            reason: p.reason || "travel",
          });
        }
        break;

      default:
        break; // unreachable today; here so a new type is inert rather than fatal
    }
  }

  return { meta, habits, members, logs, exemptions, bindings, goals };
}

// ============================================================================
// Reading a single day
// ============================================================================

/**
 * The day's value, or null when nothing reported.
 *
 * Within one source, `aggregate: "last"` takes the newest reading (Health Connect re-reports a
 * running daily TOTAL, so summing would multiply it), while `"sum"` adds discrete events (urges,
 * workouts) after de-duplicating on externalId. Across sources we take the MAX: two pipelines
 * describing the same day must not double it, and the fuller record is the honest one.
 */
export function valueOn(state, habit, memberId, day) {
  const entries = state.logs.get(logKey(habit.habitId, memberId, day));
  if (!entries || !entries.length) return null;

  const bySource = new Map();
  for (const e of entries) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }

  const perSource = new Map();
  for (const [source, list] of bySource) {
    let v;
    if (habit.aggregate === "sum") {
      const seen = new Set();
      v = 0;
      for (const e of list) {
        if (e.externalId) {
          if (seen.has(e.externalId)) continue;
          seen.add(e.externalId);
        }
        v += e.value;
      }
    } else {
      v = list[list.length - 1].value; // entries are already in replay order
    }
    perSource.set(source, v);
  }

  // A number somebody typed in WINS outright, rather than joining the max.
  //
  // Max is the right rule between two sensors describing the same day — neither is lying and the
  // fuller record is the honest one. It is the wrong rule against a person: correcting a watch
  // that over-counted would be silently discarded for being smaller, which makes the correction
  // button look broken. If you have explicitly written a number for a day, you are overruling the
  // machine, and that is the whole point of being able to.
  if (perSource.has("manual")) return perSource.get("manual");

  let best = null;
  for (const v of perSource.values()) best = best === null ? v : Math.max(best, v);
  return best;
}

/** The target on a given day, after any taper has stepped it. */
/** The group's target as it stood on a given day, before any taper. */
function baseTargetOn(habit, day) {
  const list = habit.targets;
  if (!list || !list.length) return habit.target;
  let found = list[0].target;
  for (const t of list) {
    if (t.from <= day) found = t.target;
    else break;
  }
  return found;
}

export function targetOn(habit, day) {
  return taperedTarget(habit, day, baseTargetOn(habit, day));
}

/**
 * The goal this member had in force on a given day, or null before they set one.
 *
 * Entries are appended in replay order and their `from` days only ever move forward, so the last
 * one that has started is the one that counts.
 */
export function goalOn(state, habitId, memberId, day) {
  const list = state.goals.get(memberId + "|" + habitId);
  if (!list || !list.length) return null;
  let found = null;
  for (const g of list) {
    if (g.from <= day) found = g;
    else break;
  }
  return found;
}

/** The goal as most recently SET, whether or not it has started counting yet. */
export function latestGoal(state, habitId, memberId) {
  const list = state.goals.get(memberId + "|" + habitId);
  return list && list.length ? list[list.length - 1] : null;
}

function taperedTarget(habit, day, base) {
  if (!habit.taper) return base;
  const { amount = 1, everyDays = 7, floor = 0 } = habit.taper;
  const elapsed = Math.max(0, daysBetween(habit.createdDay, day));
  const steps = Math.floor(elapsed / Math.max(1, everyDays)) * amount;
  return habit.direction === AT_MOST ? Math.max(floor, base - steps) : base + steps;
}

/**
 * This member's own target, falling back to the group's.
 *
 * The group agrees on WHAT it tracks; each person sets their own number. Ten thousand steps is a
 * stretch for one of them and a slow morning for another, and scoring both against one figure
 * measures fitness rather than effort — which is not what anybody joined a habit tracker for.
 * A taper still applies, to whichever number is theirs.
 */
export function targetFor(state, habit, memberId, day, goalDay = day) {
  // Two days, because they answer different questions. `day` is where the taper has got to;
  // `goalDay` is which goal was in force. For a daily habit they are the same. For a weekly one
  // the taper looks at the end of the week and the goal at its start, so a target lowered on
  // Wednesday cannot quietly re-score the Monday and Tuesday of the same week.
  const goal = goalOn(state, habit.habitId, memberId, goalDay);
  const fallback = baseTargetOn(habit, goalDay);
  const base = goal && Number.isFinite(goal.target) && goal.target > 0 ? goal.target : fallback;
  return taperedTarget(habit, day, base);
}

/**
 * Is this member doing this habit at all?
 *
 * Opting out is not the same as failing, and has to be sayable: a group can track five things
 * without everyone signing up for all five. An untracked habit is EXEMPT for that person and
 * leaves their board score untouched, rather than dragging it to zero.
 */
export function isTracking(state, habit, memberId, day = null) {
  // With no day, the question is "am I signed up for this", and the answer is whatever they last
  // said — the screens that ask are showing intent. Scoring passes a day, because there the
  // question is what was true THEN, and opting out on Sunday must not excuse the Tuesday.
  const goal = day == null
    ? latestGoal(state, habit.habitId, memberId)
    : goalOn(state, habit.habitId, memberId, day);
  return !goal || goal.active !== false;
}

/**
 * Which source feeds this habit for this member — their own binding, else the habit's default.
 *
 * The whole NO_DATA rule hangs off this answer, so it is deliberately a lookup rather than a
 * habit field: the group shares one "Steps" habit, but only some of them have a watch reporting
 * into it.
 */
export function sourceFor(state, habit, memberId) {
  const bound = state.bindings.get(memberId + "|" + habit.habitId) || habit.source;

  // A binding that names a sensor which cannot read this metric is not a promise about where the
  // number comes from — it is a leftover, and the engine must not act on it. Earlier builds bound
  // every habit on a phone to one source, so a vape-puff habit on a Galaxy with Health Connect
  // ended up bound to a watch that has never heard of vaping. Those bindings are in the shared log
  // for good; what stops mattering is whether they are believed.
  //
  // It matters because of what a binding decides: an automatic source going quiet is NO_DATA and
  // costs nothing, so a habit wrongly marked automatic can never be missed. Somebody who never
  // logs a puff would show a clean record forever.
  if (bound === SOURCE.HEALTH_CONNECT && !HEALTH_METRICS.has(habit.metric)) return SOURCE.MANUAL;
  if (bound === SOURCE.PAUSE
      && !PAUSE_METRICS.has(habit.metric)
      && !isInterventionHabit(habit)) return SOURCE.MANUAL;
  return bound;
}

function exemptReason(state, habit, memberId, day) {
  for (const x of state.exemptions) {
    if (x.memberId !== memberId) continue;
    if (x.habitId && x.habitId !== habit.habitId) continue;
    if (daysBetween(x.from, day) >= 0 && daysBetween(day, x.to) >= 0) return x.reason;
  }
  return null;
}

/**
 * The value for a whole period, or null when nothing was reported in it.
 *
 * A daily habit is simply its day. Longer ones combine their days the way a day combines its
 * sources: `sum` adds them up (three gym sessions across a week), `last` takes the most recent
 * reading (a savings balance, which is a running total already — adding the weekly reports of it
 * together would claim you saved four times what you did).
 */
export function valueForPeriod(state, habit, memberId, key) {
  if (habit.period === PERIOD.DAY) return valueOn(state, habit, memberId, key);
  let total = null;
  for (const day of daysInPeriod(key, habit.period)) {
    const value = valueOn(state, habit, memberId, day);
    if (value === null) continue;
    total = habit.aggregate === AGGREGATE.SUM ? (total || 0) + value : value;
  }
  return total;
}

/**
 * A period's status BEFORE grace tokens are considered. Tokens need the running walk (you can only
 * spend what you had banked by then), so they are applied in walk() rather than here.
 *
 * Order matters: an explicit exemption beats a rest day, a rest day beats any measurement, and a
 * missing measurement means different things depending on who was supposed to take it.
 */
export function rawPeriodStatus(state, habit, memberId, key) {
  // Not signed up for this one. Different from failing it, and must not cost them anything.
  //
  // Asked as of the period's START. A week you began committed to is a week you are judged on,
  // whatever you decided about it on the Saturday.
  const opensOn = periodStart(key, habit.period);
  if (!isTracking(state, habit, memberId, opensOn)) return EXEMPT;

  const days = daysInPeriod(key, habit.period);
  // A period is exempt only when EVERY day in it is. Three days away does not excuse a whole week
  // of a weekly goal — you had four other days to do it in.
  if (days.every((d) => exemptReason(state, habit, memberId, d))) return EXEMPT;
  // Weekday scheduling is a daily-habit idea. "Mon/Wed/Fri" says nothing about a monthly target.
  if (habit.period === PERIOD.DAY && !habit.days.includes(isoDayOfWeek(key))) return EXEMPT;

  const value = valueForPeriod(state, habit, memberId, key);
  if (value === null) {
    // An AUTOMATIC source that said nothing means the pipeline was silent — which is not the same
    // as the user failing, and must not be scored as one.
    //
    // A MANUAL habit with no entry is a real miss, in both directions, and the ceilings are not the
    // exception they briefly looked like. The argument for excusing them was that no observation of
    // a quiet day separates "I had none" from "I forgot to say so" — which is true of a ceiling
    // nobody counts, and false of every ceiling this app actually has. The vape keeps the puff
    // count; the number exists whether or not it is entered. So silence is not an unknowable day,
    // it is an unreported one, and reporting is part of what was agreed to.
    //
    // The cost of the other reading was worse than it looked: a habit you can score full marks on
    // by never opening the app is not a habit. This is also why the daily reminder exists.
    return AUTOMATIC_SOURCES.has(sourceFor(state, habit, memberId)) ? NO_DATA : MISS;
  }
  const target = targetFor(state, habit, memberId, periodEnd(key, habit.period), opensOn);
  const met = habit.direction === AT_MOST ? value <= target : value >= target;
  return met ? HIT : MISS;
}

/**
 * How far through a period someone is, from 0 to 1.
 *
 * The board needs this for the period still running. A month-long savings goal would otherwise
 * contribute nothing to this week's standings until the month closed — which is both useless and
 * discouraging, since the whole point of showing up on the board is seeing the effort land.
 */
export function progressFor(state, habit, memberId, key) {
  const target = targetFor(state, habit, memberId, periodEnd(key, habit.period));
  const value = valueForPeriod(state, habit, memberId, key);
  if (target <= 0) return 1;
  if (habit.direction === AT_MOST) {
    // Nothing logged against a ceiling means nothing spent, which is a perfect score so far.
    if (value === null) return 1;
    return value <= target ? 1 : Math.max(0, 1 - (value - target) / target);
  }
  if (value === null) return 0;
  return Math.min(1, value / target);
}

/** Daily convenience wrapper, and what most of the UI actually asks for. */
export function rawDayStatus(state, habit, memberId, day) {
  return rawPeriodStatus(state, habit, memberId, periodKey(day, habit.period));
}

// ============================================================================
// The walk — streaks, grace tokens, per-day final status
// ============================================================================

/**
 * Walk a member's days in calendar order, banking and spending grace tokens as it goes.
 *
 * Tokens are earned by clean running (default: one per 7 consecutive HIT days) and capped
 * (default: 2). Uncapped, you would bank 52 a year and the streak would stop meaning anything.
 * A banked token is spent AUTOMATICALLY on a miss — this app's premise is friction elimination,
 * so nobody should have to remember to save their own streak.
 *
 * `through` defaults to YESTERDAY. Today is deliberately not judged as a miss while it is still
 * running, which is the difference between a streak that survives the morning and one that resets
 * at 00:01. Today is folded back in below only when it is ALREADY won — a hit cannot later become
 * a miss, so counting it early is safe, and it lets the number tick up the moment you earn it.
 */
export function walk(state, habitId, memberId, today, through = null) {
  const habit = state.habits.get(habitId);
  if (!habit) return null;

  const endDay = through || today;
  let startDay = habit.createdDay;
  if (daysBetween(startDay, endDay) > MAX_WALK_DAYS) startDay = addDays(endDay, -MAX_WALK_DAYS);

  const currentKey = periodKey(today, habit.period);
  const statuses = new Map();
  const spent = [];
  let tokens = 0, cleanRun = 0, length = 0;
  let todayStatus = null;
  const { earnEvery, cap } = habit.grace;

  for (const key of periodsBetween(startDay, endDay, habit.period)) {
    const raw = rawPeriodStatus(state, habit, memberId, key);

    // The period still running is never a miss — it has not finished yet. This is the difference
    // between a streak that survives the morning and one that resets at 00:01, and it matters far
    // more once periods can be a month long: a savings goal must not read as failed on the 2nd.
    if (key === currentKey) {
      todayStatus = raw;
      statuses.set(key, raw);
      if (raw === HIT || raw === EXEMPT) length += 1; // counts the moment it is won
      continue;
    }

    let status = raw;
    if (status === MISS && tokens > 0) {
      tokens -= 1;
      spent.push(key);
      status = EXEMPT;
    }

    if (status === HIT) { length += 1; cleanRun += 1; }
    else if (status === EXEMPT) { length += 1; }      // preserved, but earns no progress
    else if (status === NO_DATA) { /* preserved, earns no progress */ }
    else { length = 0; cleanRun = 0; }                // a miss with nothing banked

    if (earnEvery > 0 && cleanRun >= earnEvery) {
      cleanRun = 0;
      tokens = Math.min(tokens + 1, cap);
    }
    statuses.set(key, status);
  }

  return { habit, statuses, streak: length, tokens, spent, todayStatus, currentKey };
}

/** Convenience: just the streak length for a member's habit. */
export function streak(state, habitId, memberId, today) {
  const w = walk(state, habitId, memberId, today);
  return w ? w.streak : 0;
}

// ============================================================================
// Leaderboard
// ============================================================================

/**
 * Completion across every SCORED habit, for the window [from, to].
 *
 * ---- Why each habit is scored on its own before anything is combined ----
 *
 * Pooling every period into one hits-over-eligible ratio quietly makes the shortest habit the only
 * one that counts. Over a month, a daily step goal produces about thirty results and a monthly
 * savings target produces one: pooled, the savings target moves the number by three percent and
 * the steps decide everything. No weighting fixes that — you would need a weight of thirty just to
 * get back to even, and the arithmetic would still be at the mercy of how many days were in the
 * window.
 *
 * So each habit is reduced to its own completion ratio first, and only then are those combined,
 * weighted. A month of steps and one savings target count the same by default, and `weight`
 * becomes a deliberate statement that one of them matters more — rather than a correction for a
 * broken denominator.
 *
 * Two further rules keep the crown and the clown fair rather than an accident of hardware:
 *
 *   - EXEMPT and NO_DATA periods leave the denominator entirely. You are measured on the periods
 *     you were actually asked to show up for, and where we could tell whether you did.
 *   - The period still RUNNING contributes partial progress rather than a verdict. Without it a
 *     monthly goal would contribute nothing to this week's board until the month closed, which is
 *     both useless and discouraging.
 */
export function leaderboard(state, memberIds, from, to, today = to) {
  const scored = [...state.habits.values()].filter((h) => h.scored);

  const rows = memberIds.map((memberId) => {
    let hits = 0, eligible = 0, noData = 0, spentTokens = 0, bestStreak = 0;
    let weighted = 0, weightSum = 0;
    const perHabit = [];

    for (const habit of scored) {
      const w = walk(state, habit.habitId, memberId, today, to);
      if (!w) continue;
      bestStreak = Math.max(bestStreak, w.streak);

      const keys = periodsBetween(from, to, habit.period);
      spentTokens += w.spent.filter((k) => keys.includes(k)).length;

      let scoreSum = 0, judged = 0;
      for (const key of keys) {
        const status = w.statuses.get(key);
        if (status === undefined || status === EXEMPT) continue; // before it existed, or excused
        if (status === NO_DATA) { noData += 1; continue; }

        if (key === w.currentKey) {
          scoreSum += progressFor(state, habit, memberId, key);
        } else {
          scoreSum += status === HIT ? 1 : 0;
          if (status === HIT) hits += 1;
          eligible += 1;
        }
        judged += 1;
      }

      if (judged > 0) {
        const ratio = scoreSum / judged;
        perHabit.push({ habitId: habit.habitId, name: habit.name, ratio, weight: habit.weight });
        weighted += ratio * habit.weight;
        weightSum += habit.weight;
      }
    }

    const member = state.members.get(memberId);
    return {
      memberId,
      name: (member && member.name) || memberId,
      hits, eligible, noData, spentTokens, perHabit,
      streak: bestStreak,
      pct: weightSum > 0 ? Math.round((weighted / weightSum) * 100) : null,
    };
  });

  // Rank by completion. Someone with no measurable days ranks last but is never crowned or clowned.
  //
  // Ties break on days actually completed, then on streak. Percentage alone would hand the crown
  // to whoever had the fewest days measured — a week where three of five days were rest days or
  // travel is 100%, and it should not beat a perfect seven out of seven. Name is only ever the
  // last resort, so that ordering stays deterministic across devices.
  const ranked = rows.slice().sort((a, b) => {
    if (a.pct === null && b.pct === null) return a.name.localeCompare(b.name);
    if (a.pct === null) return 1;
    if (b.pct === null) return -1;
    if (a.pct !== b.pct) return b.pct - a.pct;
    if (a.hits !== b.hits) return b.hits - a.hits;
    if (a.streak !== b.streak) return b.streak - a.streak;
    return a.name.localeCompare(b.name);
  });
  ranked.forEach((r, i) => { r.rank = i + 1; });

  const measurable = ranked.filter((r) => r.pct !== null);
  const crown = measurable.length > 0 ? measurable[0] : null;

  // Nobody is the clown for coming bottom of a field of one. And when the bottom row had a silent
  // pipeline, the week produces NO clown at all — the tag is NOT promoted to the person above
  // them, who by definition did better. Suppressing upward would punish a good week to keep a
  // joke alive, which is precisely the unfairness this rule exists to remove.
  let clown = null, clownSuppressedFor = null;
  if (measurable.length > 1) {
    const last = measurable[measurable.length - 1];
    if (last.noData > 0) clownSuppressedFor = last.memberId;
    else if (!crown || last.memberId !== crown.memberId) clown = last;
  }

  for (const r of ranked) {
    r.crown = !!crown && r.memberId === crown.memberId;
    r.clown = !!clown && r.memberId === clown.memberId;
    // Why this row is NOT wearing the tag, so the UI can say so and offer the fix.
    r.clownSuppressed = r.memberId === clownSuppressedFor;
  }

  return ranked;
}

// ============================================================================
// Two habits, side by side
// ============================================================================

/**
 * Days needed on BOTH sides before a comparison is worth showing.
 *
 * The number exists because the interesting version of this feature is also the dishonest one. Two
 * days against one will happily produce "you walk 40% more when you stay off your phone", and it
 * will be noise, and somebody will believe it. Four is not statistical significance either — this
 * is three friends over a month, not a study — but it is enough that the claim survives one unusual
 * Saturday, and the card says "on the days you did" rather than anything causal.
 */
export const MIN_COMPARE_DAYS = 4;

/**
 * How one habit's numbers actually looked on days another was met, versus days it was not.
 *
 * The whole reason screen time became a synced habit rather than a private Pause statistic: once
 * both sides are in the same log, the question "do I move more on the days I stay off my phone"
 * is a pure replay away, with nothing crossing the bridge to ask it. If this had to reach into
 * Kotlin for one half, it would be a second engine deciding what a good day was.
 *
 * What is deliberately excluded, and why each one matters:
 *
 *   - Non-daily habits. Pairing a weekly total with a single day is a category error; asked of a
 *     weekly habit this returns null rather than a number that looks fine.
 *   - NO_DATA and EXEMPT days on the gate. A day the pipeline was silent is not a day you failed,
 *     and counting it as one is exactly the mistake the four-state model exists to prevent.
 *   - Days the value habit reported nothing. Treating that silence as a zero would drag the
 *     average of whichever side the outage happened to land on, and outages are not random —
 *     a phone that is off all day reports neither steps nor screen time.
 *
 * Returns null when the comparison cannot honestly be made, so a caller cannot render half of one.
 */
export function compareDays(state, gateHabitId, valueHabitId, memberId, fromDay, toDay) {
  const gate = state.habits.get(gateHabitId);
  const subject = state.habits.get(valueHabitId);
  if (!gate || !subject || gate === subject) return null;
  if (gate.period !== "day" || subject.period !== "day") return null;

  const met = { days: 0, total: 0, average: null };
  const missed = { days: 0, total: 0, average: null };

  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    const status = rawDayStatus(state, gate, memberId, day);
    if (status !== HIT && status !== MISS) continue;
    const value = valueOn(state, subject, memberId, day);
    if (value === null) continue;
    const side = status === HIT ? met : missed;
    side.days += 1;
    side.total += value;
  }

  if (met.days < MIN_COMPARE_DAYS || missed.days < MIN_COMPARE_DAYS) return null;
  met.average = met.total / met.days;
  missed.average = missed.total / missed.days;

  // Signed against the SUBJECT's own direction rather than against the arithmetic, so a positive
  // delta always means "better on the days you held the line". For a reduce habit fewer is better,
  // and reporting a drop as a negative would invert the only sentence the card ever says.
  const raw = met.average - missed.average;
  return {
    met, missed,
    delta: subject.direction === AT_MOST ? -raw : raw,
    // Meaningless when nothing happened on the days it did not go well, and a division by zero
    // besides. Null is honest; Infinity renders.
    ratio: missed.average === 0 ? null : met.average / missed.average,
  };
}

/** What the group may see of a member's number, per the habit's visibility setting. */
export function publicValue(habit, value) {
  if (habit.visibility === VISIBILITY.PRIVATE) return null;
  if (habit.visibility === VISIBILITY.PROGRESS) {
    if (value === null) return null;
    const t = habit.target || 1;
    const pct = habit.direction === AT_MOST
      ? Math.max(0, Math.min(100, Math.round((1 - value / t) * 100)))
      : Math.max(0, Math.min(100, Math.round((value / t) * 100)));
    return { pct };
  }
  return { value };
}
