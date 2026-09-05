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

import { periodsBetween, periodStart, periodEnd, addDays, daysBetween, isoWeekKey } from "./habits.js";
import { leaderboard, categoryOver, CATEGORY_ORDER } from "./score.js";
import { PERIOD } from "./schema.js";

/**
 * When the season being played started, as a day.
 *
 * By default the earliest habit's birthday: before that there was nothing to score, and starting
 * from a member's join date would give whoever joined last a shorter, easier season.
 *
 * ---- Why it can be moved ----
 *
 * A group spends its first weeks getting the thing working, and those weeks are not a contest —
 * they are a phone syncing as the wrong person, a metric being renamed, a taper being argued
 * about. Carrying that into a standings table that is meant to last means the season opens with
 * results nobody agrees with and no way to draw a line under them.
 *
 * So `meta.seasonFrom` moves the line. It is a group-wide setting, last write wins, and it is
 * DERIVED-ONLY: nothing is deleted, no log is touched, no streak breaks. Weeks before it stop
 * being tallied and everything else — habits, targets, tapers, history, per-habit streaks — is
 * exactly as it was. Wiping the standings and wiping the data are different requests, and this
 * is the first one.
 *
 * An older build that does not know the key merges it into meta and never reads it, so it keeps
 * showing the whole season. That is the safe direction to be wrong in: it over-reports history
 * rather than inventing a reset nobody asked for.
 */
export function seasonStart(state, today = null) {
  let earliest = null;
  for (const habit of state.habits.values()) {
    if (!habit.createdDay) continue;
    if (earliest === null || habit.createdDay < earliest) earliest = habit.createdDay;
  }

  const line = state.meta && state.meta.seasonFrom;
  // Only ever moves the start FORWARD. A line before the first habit describes weeks that never
  // existed, and one that arrives malformed must not blank the standings.
  if (typeof line === "string" && /^\d{4}-\d{2}-\d{2}$/.test(line)) {
    // A line that has not arrived yet is not in force yet.
    //
    // A new season is always started FROM a Monday, so for up to six days the line sits in the
    // future — and the confirm sheet says, in as many words, "from Monday the 7th". Honouring it
    // the moment it is written made that a lie: the standings emptied on the tap, everybody dropped
    // to zero points with no explanation, and the week people were still playing vanished from
    // under them.
    //
    // `today` is optional so that asking what the line IS stays possible; every caller that renders
    // a board passes it.
    if (today && line > today) return earliest;
    if (earliest === null || line > earliest) return line;
  }
  return earliest;
}

/**
 * The season that is coming but has not started, or null.
 *
 * Only ever set between somebody starting one and the Monday it begins on. The board says so for
 * those few days, because a countdown nobody can see is indistinguishable from nothing happening —
 * and the person who tapped it is the one most likely to check whether it worked.
 */
export function pendingSeason(state, today) {
  const line = state.meta && state.meta.seasonFrom;
  if (typeof line !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(line)) return null;
  return today && line > today ? line : null;
}

/**
 * How long a season runs, in whole ISO weeks — or null for one that never ends.
 *
 * Null is the old behaviour and stays the default: a season with no length runs until somebody
 * starts another one. A number gives it a finish line, which is the only way a board can show a
 * countdown, and the only way "season two" means anything.
 *
 * Weeks rather than days, because a week is the unit the whole scoreboard is built on. A season
 * measured in days would end mid-week and its last week would be a partial one nobody could win.
 */
export function seasonLength(state) {
  const n = state.meta && state.meta.seasonWeeks;
  return Number.isInteger(n) && n > 0 && n <= 104 ? n : null;
}

/**
 * The last day of the season, or null if it has no end.
 *
 * Counted from the MONDAY of the week the season began in, so a season started mid-week still ends
 * on a Sunday and its final week is a whole one. A four-week season started on a Saturday therefore
 * runs three weeks and two days — which is the honest reading of "four weeks of scoring", because
 * the week it started in only ever had two days of season in it.
 */
export function seasonEnd(state, today = null) {
  const start = seasonStart(state, today);
  const weeks = seasonLength(state);
  if (!start || !weeks) return null;
  return addDays(periodStart(isoWeekKey(start), PERIOD.WEEK), weeks * 7 - 1);
}

/**
 * Where the season is: when it started, when it ends, how much is left.
 *
 * One call, because every one of these is useless on its own — "ends Sunday" means nothing without
 * knowing whether that is this Sunday, and a progress bar with no dates is decoration.
 */
export function seasonProgress(state, today) {
  const start = seasonStart(state, today);
  if (!start) return null;

  const end = seasonEnd(state, today);
  const weeks = seasonLength(state);
  const done = seasonTally(state, [], today).weeks;

  if (!end) return { start, end: null, weeks: null, done, daysLeft: null, ended: false, pct: null };

  const daysLeft = daysBetween(today, end);
  return {
    start,
    end,
    weeks,
    done,
    // Negative once it is over; the caller reads `ended` rather than the sign.
    daysLeft,
    ended: daysLeft < 0,
    // How far through, by days rather than by completed weeks — a bar that only moves on Mondays
    // reads as broken for the six days in between.
    pct: Math.max(0, Math.min(100, Math.round(
      ((daysBetween(start, today) + 1) / (daysBetween(start, end) + 1)) * 100,
    ))),
  };
}

/** Every week the season has touched, oldest first. */
export function seasonWeeks(state, today) {
  const start = seasonStart(state, today);
  if (!start) return [];
  // A season that has finished stops counting. Without this its standings would keep growing after
  // the final whistle, and "final" would be the one thing they were not.
  const end = seasonEnd(state, today);
  const last = end && end < today ? end : today;
  if (last < start) return [];
  return periodsBetween(start, last, PERIOD.WEEK);
}

/**
 * One week, ranked.
 *
 * Reuses the ordinary board rather than reimplementing it, so the crown a week awards is the same
 * crown the board showed at the time — including the rule that suppresses the clown when somebody
 * had a silent pipeline. A season built on a second opinion about who won would be a season nobody
 * believed.
 */
export function weekStandings(state, memberIds, weekKey, notBefore = null) {
  const weekOpens = periodStart(weekKey, PERIOD.WEEK);
  const to = periodEnd(weekKey, PERIOD.WEEK);
  // A season that begins mid-week scores only the days it was actually running.
  //
  // Without this, week one reaches back to the Monday and counts days from BEFORE the line — the
  // exact history somebody just asked to be rid of, folded into the first week of the thing meant
  // to replace it. It is also the whole reason a season otherwise starts on a Monday: with the
  // floor in place, starting one today is honest rather than merely allowed.
  const from = notBefore && notBefore > weekOpens ? notBefore : weekOpens;
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
  const start = seasonStart(state, today);
  const weeks = seasonWeeks(state, today);
  const thisWeek = isoWeekKey(today);
  const done = weeks.filter((w) => w !== thisWeek);

  const tally = new Map(memberIds.map((id) => [id, {
    memberId: id,
    name: id,
    crowns: 0,
    weeks: 0,
    points: 0,
    // Kept apart from `points` as well as folded into it, because they answer different questions.
    // The total is where you stand; this is how much of it you earned by beating targets rather
    // than meeting them, which is the part somebody behind can actually use to close a gap.
    bonus: 0,
    best: null,
    avg: null,
    // Weeks in a row with a crown. The thing worth protecting, and the thing that makes losing one
    // sting in a way a single week's percentage never does.
    crownStreak: 0,
    bestCrownStreak: 0,
  }]));

  for (const week of done) {
    const rows = weekStandings(state, memberIds, week, start);
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
      // Base plus bonus. A week is worth its percentage and up to fifteen more for beating the
      // targets rather than merely meeting them — which is what makes a season winnable from
      // behind by somebody having an exceptional month, without ever letting a single day be
      // worth more than a hundred.
      const earned = row.pct + (row.bonus || 0);
      t.points += earned;
      t.bonus += row.bonus || 0;
      if (!t.best || earned > t.best.pct) t.best = { week, pct: earned };
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

  // Ranked on POINTS, which is a change of game and worth saying so plainly.
  //
  // It used to rank on crowns, and crowns are all-or-nothing: three near-misses were worth exactly
  // as much as three terrible weeks, so the season was decided by a handful of Sundays and there
  // was nothing to play for the moment one person was clear. Points accrue every week, so a strong
  // run always closes ground — and bonus points, which only come from beating a target rather than
  // meeting it, are what let somebody behind close it faster than the leader coasting.
  //
  // Crowns stay, as the tie-break and as the thing to be proud of. A season of seconds should not
  // beat a season of wins on equal points, and the name decides it last so two devices agree.
  rows.sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    if (a.crowns !== b.crowns) return b.crowns - a.crowns;
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
