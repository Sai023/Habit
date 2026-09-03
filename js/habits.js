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
  T, AT_LEAST, AT_MOST, AUTOMATIC_SOURCES, VISIBILITY,
  MAX_BACKFILL_DAYS, HABIT_DEFAULTS, isKnown,
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
  h.grace = { ...HABIT_DEFAULTS.grace, ...(p.grace || {}) };
  h.target = Number(h.target) || 0;
  h.dayStartHour = Number.isFinite(Number(h.dayStartHour)) ? Number(h.dayStartHour) : 4;
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
        habits.set(p.habitId, normalizeHabit({ ...(prev || {}), ...p }, createdDay));
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

      case T.EXEMPT:
        if (p.memberId && p.from && p.to) {
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

  return { meta, habits, members, logs, exemptions };
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

  let best = null;
  for (const list of bySource.values()) {
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
    best = best === null ? v : Math.max(best, v);
  }
  return best;
}

/** The target on a given day, after any taper has stepped it. */
export function targetOn(habit, day) {
  if (!habit.taper) return habit.target;
  const { amount = 1, everyDays = 7, floor = 0 } = habit.taper;
  const elapsed = Math.max(0, daysBetween(habit.createdDay, day));
  const steps = Math.floor(elapsed / Math.max(1, everyDays)) * amount;
  return habit.direction === AT_MOST
    ? Math.max(floor, habit.target - steps)
    : habit.target + steps;
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
 * A day's status BEFORE grace tokens are considered. Tokens need the running walk (you can only
 * spend what you had banked by that day), so they are applied in walk() rather than here.
 *
 * Order matters: an explicit exemption beats a rest day, a rest day beats any measurement, and a
 * missing measurement means different things depending on who was supposed to take it.
 */
export function rawDayStatus(state, habit, memberId, day) {
  if (exemptReason(state, habit, memberId, day)) return EXEMPT;
  if (!habit.days.includes(isoDayOfWeek(day))) return EXEMPT;

  const value = valueOn(state, habit, memberId, day);
  if (value === null) {
    // An AUTOMATIC source that said nothing means the pipeline was silent — which is not the same
    // as the user failing, and must not be scored as one. A MANUAL habit with no entry is a real
    // miss: logging it was the whole task.
    return AUTOMATIC_SOURCES.has(habit.source) ? NO_DATA : MISS;
  }
  const target = targetOn(habit, day);
  const met = habit.direction === AT_MOST ? value <= target : value >= target;
  return met ? HIT : MISS;
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

  const end = through || addDays(today, -1);
  let day = habit.createdDay;
  if (daysBetween(day, end) > MAX_WALK_DAYS) day = addDays(end, -MAX_WALK_DAYS);

  const statuses = new Map();
  const spent = [];
  let tokens = 0, cleanRun = 0, length = 0;
  const { earnEvery, cap } = habit.grace;

  for (; daysBetween(day, end) >= 0; day = addDays(day, 1)) {
    let status = rawDayStatus(state, habit, memberId, day);

    if (status === MISS && tokens > 0) {
      tokens -= 1;
      spent.push(day);
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
    statuses.set(day, status);
  }

  // Today counts only once it is already won.
  const todayStatus = rawDayStatus(state, habit, memberId, today);
  if (!statuses.has(today)) statuses.set(today, todayStatus);
  if (daysBetween(end, today) > 0 && (todayStatus === HIT || todayStatus === EXEMPT)) length += 1;

  return { habit, statuses, streak: length, tokens, spent, todayStatus };
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
 * Two rules make the crown and the clown fair rather than an accident of hardware:
 *
 *   - EXEMPT and NO_DATA days leave the denominator. You are measured on days you were actually
 *     asked to show up, and where we could actually tell.
 *   - The clown is SUPPRESSED for anyone with a NO_DATA day in the window. Otherwise the tag
 *     lands on whoever has the worst sync pipeline rather than the worst week — which, in a group
 *     with mixed watches, is a known person and a fixed outcome.
 */
export function leaderboard(state, memberIds, from, to, today = to) {
  const scored = [...state.habits.values()].filter((h) => h.scored);

  const rows = memberIds.map((memberId) => {
    let hits = 0, eligible = 0, noData = 0, spentTokens = 0, bestStreak = 0;

    for (const habit of scored) {
      const w = walk(state, habit.habitId, memberId, today, to);
      if (!w) continue;
      bestStreak = Math.max(bestStreak, w.streak);
      spentTokens += w.spent.filter((d) => daysBetween(from, d) >= 0).length;
      for (let d = from; daysBetween(d, to) >= 0; d = addDays(d, 1)) {
        const s = w.statuses.get(d);
        if (s === HIT) { hits += 1; eligible += 1; }
        else if (s === MISS) { eligible += 1; }
        else if (s === NO_DATA) { noData += 1; }
      }
    }

    const member = state.members.get(memberId);
    return {
      memberId,
      name: (member && member.name) || memberId,
      hits, eligible, noData, spentTokens,
      streak: bestStreak,
      pct: eligible > 0 ? Math.round((hits / eligible) * 100) : null,
    };
  });

  // Rank by completion. Someone with no measurable days ranks last but is never crowned or clowned.
  const ranked = rows.slice().sort((a, b) => {
    if (a.pct === b.pct) return a.name.localeCompare(b.name);
    if (a.pct === null) return 1;
    if (b.pct === null) return -1;
    return b.pct - a.pct;
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
