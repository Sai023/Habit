// season.js — the long game.
//
// A weekly leaderboard resets every Monday, which is fair and forgettable. Nothing carries, so a
// brilliant February is worth exactly as much as last week, and there is nothing to be proud of
// except the seven days you happen to be standing in.
//
// So the weeks are tallied. Every completed week has a winner, the crowns stack up, and a running
// points total grows for as long as the group exists — a number that only ever goes up, that one
// bad week cannot dent, and that rewards the person who kept showing up over the person who had
// one enormous fortnight.
//
// ---- Derived, never stored ----
//
// Nothing here is written down anywhere. A tally kept as a counter is a second copy of the truth
// that drifts the first time a phone syncs late, replays out of order, or backfills a day — and
// then the standings and the days they came from disagree with nobody able to say which is right.
// Every figure below is computed from the same replayed log as everything else, so a late-arriving
// Tuesday moves the season the moment it lands, backwards if that is what actually happened.

import { periodsBetween, periodStart, periodEnd, addDays, isoWeekKey } from "./habits.js";
import { leaderboard, categoryOver, CATEGORY_ORDER } from "./score.js";
import { PERIOD } from "./schema.js";

/**
 * When the group started, as a day.
 *
 * The earliest habit's birthday: before that there was nothing to score, and starting the season
 * from a member's join date would give whoever joined last a shorter, easier season.
 */
export function seasonStart(state) {
  let earliest = null;
  for (const habit of state.habits.values()) {
    if (!habit.createdDay) continue;
    if (earliest === null || habit.createdDay < earliest) earliest = habit.createdDay;
  }
  return earliest;
}

/** Every week the season has touched, oldest first. */
export function seasonWeeks(state, today) {
  const start = seasonStart(state);
  if (!start) return [];
  return periodsBetween(start, today, PERIOD.WEEK);
}

/**
 * One week, ranked.
 *
 * Reuses the ordinary board rather than reimplementing it, so the crown a week awards is the same
 * crown the board showed at the time — including the rule that suppresses the clown when somebody
 * had a silent pipeline. A season built on a second opinion about who won would be a season nobody
 * believed.
 */
export function weekStandings(state, memberIds, weekKey) {
  const from = periodStart(weekKey, PERIOD.WEEK);
  const to = periodEnd(weekKey, PERIOD.WEEK);
  return leaderboard(state, memberIds, from, to, to);
}

/**
 * The running tally.
 *
 * Only COMPLETED weeks award a crown. The week you are standing in is still being played, and
 * handing out its trophy on a Tuesday — then taking it back on a Thursday — would make the tally
 * something to refresh rather than something to build.
 */
export function seasonTally(state, memberIds, today) {
  const weeks = seasonWeeks(state, today);
  const thisWeek = isoWeekKey(today);
  const done = weeks.filter((w) => w !== thisWeek);

  const tally = new Map(memberIds.map((id) => [id, {
    memberId: id,
    name: id,
    crowns: 0,
    weeks: 0,
    points: 0,
    best: null,
    avg: null,
    // Weeks in a row with a crown. The thing worth protecting, and the thing that makes losing one
    // sting in a way a single week's percentage never does.
    crownStreak: 0,
    bestCrownStreak: 0,
  }]));

  for (const week of done) {
    const rows = weekStandings(state, memberIds, week);
    for (const row of rows) {
      const t = tally.get(row.memberId);
      if (!t) continue;
      t.name = row.name;
      if (row.pct === null) {
        // A week nobody could score is not a week they lost. It breaks a crown run, because the
        // run is about weeks won, but it does not count as a week played.
        t.crownStreak = 0;
        continue;
      }
      t.weeks += 1;
      t.points += row.pct;
      if (!t.best || row.pct > t.best.pct) t.best = { week, pct: row.pct };
      if (row.crown) {
        t.crowns += 1;
        t.crownStreak += 1;
        t.bestCrownStreak = Math.max(t.bestCrownStreak, t.crownStreak);
      } else {
        t.crownStreak = 0;
      }
    }
  }

  const rows = [...tally.values()].map((t) => ({
    ...t,
    avg: t.weeks ? Math.round(t.points / t.weeks) : null,
  }));

  // Ranked on crowns, because that is the game being played. Points break the tie, since a season
  // of seconds is a real achievement and should not lose to a coin toss — and the name only ever
  // decides it last, so two devices always agree on the order.
  rows.sort((a, b) => {
    if (a.crowns !== b.crowns) return b.crowns - a.crowns;
    if (a.points !== b.points) return b.points - a.points;
    return a.name.localeCompare(b.name);
  });
  rows.forEach((r, i) => { r.rank = i + 1; });

  return { weeks: done.length, rows };
}

/**
 * Where a member's score came from, by category.
 *
 * The board says 68%. It does not say that fitness carried it and discipline sank it, which is the
 * only part anybody can act on — a percentage tells you where you came, and this tells you what to
 * do about it on Monday.
 */
export function categoryBreakdown(state, memberId, from, to) {
  return CATEGORY_ORDER
    .map((category) => ({ category, ...categoryOver(state, memberId, from, to, category, addDays) }))
    .filter((c) => c.pct !== null);
}
