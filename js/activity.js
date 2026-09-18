// activity.js — the Board's activity feed, decided as data.
//
// This module owns two questions and nothing else: WHAT belongs in the feed, and IN WHAT ORDER.
// The phrasing and the DOM stay in the dashboard; here it is plain objects, so the ordering — the
// part that was silently wrong — can be unit-tested.
//
// ---- Why it was wrong ----
//
// The feed walked the event array backwards for "newest first". But that array is db.allEvents(),
// which is IndexedDB getAll() keyed on a RANDOM eventId — so backwards was random, not newest. The
// board beside it was right because replay() sorts its own copy; the feed did not. It now orders
// itself by the day a thing is ABOUT — a log's habit-day, a change's own day — newest first, and
// never trusts the order it was handed.
//
// ---- What counts as activity (highlights only) ----
//
// A watch writing a daily step total is not news: it happens every day, and a low or partial one
// ("78 steps") reads like an achievement it is not. So a routine automatic reading earns a line
// only when it MET the goal. A deliberate manual entry, a workout, and a goal change are always
// news, met or not.

import { T, METRIC, AUTOMATIC_SOURCES, VISIBILITY } from "./schema.js";
import { rawDayStatus, visibilityFor, HIT } from "./habits.js";

/** The ISO day (UTC) a timestamp falls on — for dating a goal change, which has no habit-day. */
function dayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * THEIRS, not the viewer's: a number joins a shared feed only if its owner shows it in full. Your
 * own is always shown to you — hiding your numbers from yourself is the one reading of "private"
 * nobody means.
 */
function publicNumber(state, habit, memberId, value, me) {
  if (memberId === me) return value;
  return visibilityFor(state, habit, memberId) === VISIBILITY.FULL ? value : null;
}

/**
 * The feed as data: the notable things people did, newest first, one line per person-habit-day.
 *
 * `ctx` is { events, state, me }. Pure — the same ctx yields the same list in the same order,
 * however the events happened to be stored. Returns descriptors the dashboard renders:
 *   { kind: "log",  day, ts, memberId, habitId, source, value, met }
 *   { kind: "goal", day, ts, memberId, habitId, payload }
 */
export function activityItems(ctx, limit = 8) {
  const { events, state, me } = ctx;
  const logs = new Map(); // habitId|memberId|day -> the latest log for that day
  const goals = [];

  for (const e of events || []) {
    if (e.type === T.GOAL) {
      const g = e.payload || {};
      if (!state.habits.get(g.habitId)) continue;
      goals.push({ kind: "goal", day: dayOf(e.ts), ts: e.ts, memberId: g.memberId, habitId: g.habitId, payload: g });
      continue;
    }
    if (e.type !== T.LOG) continue;
    const p = e.payload || {};
    if (!state.habits.get(p.habitId)) continue;
    const key = p.habitId + "|" + p.memberId + "|" + p.day;
    const prev = logs.get(key);
    if (prev && prev.ts >= e.ts) continue; // one line per day: keep the latest write
    logs.set(key, { kind: "log", day: p.day, ts: e.ts, memberId: p.memberId, habitId: p.habitId, source: p.source, value: p.value });
  }

  const items = [];
  for (const it of logs.values()) {
    const habit = state.habits.get(it.habitId);
    const met = rawDayStatus(state, habit, it.memberId, it.day) === HIT;
    const automatic = AUTOMATIC_SOURCES.has(it.source);
    const isWorkout = habit.metric === METRIC.SESSIONS;
    // Highlights only: a routine automatic reading shows only when the goal was met. A manual entry
    // or a workout is a deliberate thing that happened, and always news.
    if (automatic && !met && !isWorkout) continue;
    items.push({ ...it, met, value: publicNumber(state, habit, it.memberId, it.value, me) });
  }
  for (const g of goals) items.push({ ...g, met: false });

  // Newest day first; within a day, the latest write first. This is the whole fix: the feed owns
  // its order instead of inheriting the store's random one.
  items.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (b.ts || 0) - (a.ts || 0)));
  return items.slice(0, limit);
}
