// levels.js — lifetime XP, and the level it has reached.
//
// ---- What this is ----
//
// Every day the engine already prices: 0–100 XP for the day, up to 15 more for beating targets.
// Lifetime XP is those days added up, every day since the person joined, across every season.
// Nothing new is invented here — no second currency, no multiplier, no way to earn that the board
// does not already have — so there is nothing new to game. A day still cannot be worth more than
// 115, and a day that went unreported still adds nothing.
//
// ---- The three rules ----
//
// It only goes up. A bad week costs nothing already earned, and a level once reached is never
// lost. That is the whole behavioural point: a streak is something to protect, which is stressful;
// a total is something to grow, which is not.
//
// Days bank when they close. Today's XP can still fall — a ceiling habit can turn a hit into a
// miss at eleven at night — so today is shown as a translucent tip on the bar, not counted in the
// level. A level reached at six in the evening and lost by midnight would be the worst thing this
// feature could do, so it cannot happen.
//
// Recognition, not power. Levels unlock nothing in the scoring and there is no lifetime
// leaderboard: somebody who joined a year later would never catch up, and the league lives on the
// week and the season where everybody starts level. The level is your own story.
//
// ---- The curve ----
//
// Each level asks 25 XP more than the one before, starting at 300. Level 2 lands on day three;
// level 10 in six weeks; 20 in four months; 50 in a year and a half; 100 — the last — in about
// five years of showing up at 85 a day. Late levels are nine times rarer than early ones, which is
// what makes them worth reaching, and the top is a real place rather than an asymptote.

import { dayScore } from "./score.js";
import { addDays } from "./habits.js";

export const LEVEL_MAX = 100;
export const FIRST_GAP = 300;
export const GAP_STEP = 25;

/** The titles, one per ten levels. A level between two keeps the lower. */
export const TITLES = [
  [1, "Starter"], [10, "Regular"], [20, "Steady"], [30, "Solid"], [40, "Committed"],
  [50, "Relentless"], [60, "Veteran"], [70, "Iron"], [80, "Unbroken"], [90, "Master"], [100, "Legend"],
];

/** XP asked to go from level−1 to level. Level 1 is free. */
export function gapTo(level) {
  if (level <= 1) return 0;
  return FIRST_GAP + GAP_STEP * (level - 2);
}

/** Lifetime XP at which a level begins. Level 1 begins at 0. */
export function thresholdFor(level) {
  const n = Math.max(0, Math.min(LEVEL_MAX, level) - 1);
  // Sum of the first n gaps: n·FIRST + STEP·(0+1+…+n−1).
  return n * FIRST_GAP + (GAP_STEP * n * (n - 1)) / 2;
}

export function titleFor(level) {
  let title = TITLES[0][1];
  for (const [at, name] of TITLES) if (level >= at) title = name;
  return title;
}

/**
 * The band a level sits in: where its title began, and which title comes next and when.
 *
 * For the pips under the bar. A bar that runs from Level 3 to Level 4 answers "how far to the
 * next level"; the pips answer the other question a bar at eight per cent provokes — "so is the
 * end of it the next title?" — by drawing the ten levels of the band with the reached ones lit.
 * At Legend there is no next, and `nextAt` is null.
 */
export function titleBand(level) {
  let from = TITLES[0][0];
  let next = null;
  for (const [at, name] of TITLES) {
    if (level >= at) from = at;
    else { next = { name, at }; break; }
  }
  return { from, name: titleFor(level), nextName: next ? next.name : null, nextAt: next ? next.at : null };
}

/**
 * Where a lifetime total stands: the level, the title, and the distance to the next.
 *
 * `need` is the number the screen states: "1,100 XP to Level 8". `fill` is what the bar and the
 * ring draw: lifetime XP on a scale from zero to the NEXT level's threshold — 654 of 975 is 67%
 * — so the bar refills toward each level rather than resetting to empty. Asked for as "a lifetime
 * XP bar, till the next level", and it reads fuller than the within-level fraction (`pct`, kept
 * for anything that wants how far through this level you are). At the top, `next` is null and
 * both are full.
 */
export function levelFor(xp) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 1;
  while (level < LEVEL_MAX && total >= thresholdFor(level + 1)) level += 1;
  const at = thresholdFor(level);
  const next = level < LEVEL_MAX ? thresholdFor(level + 1) : null;
  const span = next === null ? 0 : next - at;
  const into = next === null ? 0 : total - at;
  return {
    level,
    title: titleFor(level),
    xp: total,
    at,
    next,
    into,
    span,
    need: next === null ? 0 : next - total,
    pct: next === null ? 100 : Math.floor((into / span) * 100),
    fill: next === null ? 100 : Math.floor((total / next) * 100),
    max: level >= LEVEL_MAX,
  };
}

/**
 * A member's lifetime: what has banked, what today would add, and the level.
 *
 * Banked is every closed day from the day they joined to yesterday. Today rides along separately
 * as `today` so a bar can draw it as a tip, and `levelUpToday` says whether it would already be
 * enough — "banks at midnight" is a better sentence when it is also "and that's Level 8".
 */
export function lifetime(state, memberId, today) {
  // Cached per replayed state. The store hands out the same state object until a new event
  // lands, so the header, the board rows and the shell's summary — which all ask on every paint —
  // share one walk, and only a new event pays for another. Two years of a person is ~120ms on a
  // laptop (scripts/perf-levels.mjs); if that ever shows on a phone, the days before the current
  // week can be banked once, since a finished week cannot be re-scored.
  let perState = CACHE.get(state);
  if (!perState) { perState = new Map(); CACHE.set(state, perState); }
  const key = memberId + "|" + today;
  if (perState.has(key)) return perState.get(key);
  const out = computeLifetime(state, memberId, today);
  perState.set(key, out);
  return out;
}

const CACHE = new WeakMap();

function computeLifetime(state, memberId, today) {
  const member = state.members.get(memberId);
  const since = member && member.since ? member.since : firstHabitDay(state);
  const empty = {
    ...levelFor(0), banked: 0, today: 0, days: 0, since: since || null, levelUpToday: false,
  };
  if (!since || since > today) return empty;

  const yesterday = addDays(today, -1);
  let banked = 0;
  let days = 0;
  // One memo for the whole walk. A weekly or monthly habit is scored once per period rather than
  // once per day, which is most of the cost of two years of days.
  const memo = new Map();
  for (let d = since; d <= yesterday; d = addDays(d, 1)) {
    const score = dayScore(state, memberId, d, today, memo);
    if (!score.scored) continue;
    banked += score.pct + score.bonus;
    days += 1;
  }
  const now = dayScore(state, memberId, today, today, memo);
  const provisional = now.scored ? now.pct + now.bonus : 0;

  const standing = levelFor(banked);
  return {
    ...standing,
    banked,
    today: provisional,
    days,
    since,
    levelUpToday: levelFor(banked + provisional).level > standing.level,
  };
}

function firstHabitDay(state) {
  let earliest = null;
  for (const habit of state.habits.values()) {
    if (habit.createdDay && (earliest === null || habit.createdDay < earliest)) earliest = habit.createdDay;
  }
  return earliest;
}
