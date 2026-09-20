// season.js — the long game.
//
// A weekly leaderboard resets every Monday, which is fair and forgettable. Nothing carries, so a
// brilliant February is worth exactly as much as last week, and there is nothing to be proud of
// except the seven days you happen to be standing in.
//
// So the days are tallied. Every closed day adds its hundred to a running total, every whole week
// inside the season has a winner, the crowns stack up, and the total grows for as long as the
// season runs — a number that only ever goes up, that one bad week cannot dent, and that rewards
// the person who kept showing up over the person who had one enormous fortnight.
//
// ---- Derived, never stored ----
//
// Nothing here is written down anywhere. A tally kept as a counter is a second copy of the truth
// that drifts the first time a phone syncs late, replays out of order, or backfills a day — and
// then the standings and the days they came from disagree with nobody able to say which is right.
// Every figure below is computed from the same replayed log as everything else, so a late-arriving
// Tuesday moves the season the moment it lands, backwards if that is what actually happened.
//
// ---- Rules, and the windows they describe ----
//
// A season is a WINDOW of days, and windows come from RULES. Replay keeps `meta.seasonRules`, the
// trail of every season-affecting meta line in the order it was written (see the T.META case in
// habits.js). Two kinds:
//
//   { from, weeks }   started by hand: one window, `weeks` whole weeks long, or open-ended when
//                     weeks is null. The old model, and still the escape hatch.
//   { from, every }   a schedule: from `from`, a new season begins on the `every`-th of each month,
//                     on its own, with nobody pressing anything. The first window runs from `from`
//                     to the day before the next such date — a short run-in when `from` is not
//                     itself a cycle day — and every window after it is a month.
//
// Each rule is in force until the day before the next rule begins, which is how "start one by
// hand" ends a schedule and how a schedule ends a hand-started season: the newer rule is a hard
// stop for the older one, whatever its own length said. A season cut short that way is REPLACED
// rather than finished, because "finished" claims it ran its course.
//
// ---- Why a schedule is derived rather than fired ----
//
// The obvious way to roll a season over at midnight is a job that writes the next one. There is no
// server here and no phone that is reliably awake at midnight, so the job would run whenever
// somebody next opened the app — on one phone — and every other phone would show the old season
// until it synced. Deriving the windows from the rule means every device computes the same season
// from the same log the moment its clock passes the boundary, with nothing written and nothing to
// sync. The rollover cannot be missed, because there is nothing to miss.

import {
  periodsBetween, periodStart, periodEnd, addDays, daysBetween, isoWeekKey,
} from "./habits.js";
import { leaderboard, categoryOver, categoryFor, CATEGORY_ORDER } from "./score.js";
import { PERIOD } from "./schema.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Days of the month a schedule may use: the ones every month has. */
export const CYCLE_DAY_MIN = 1;
export const CYCLE_DAY_MAX = 28;

/** The day before there was anything to score: the earliest habit's birthday. */
function firstHabitDay(state) {
  let earliest = null;
  for (const habit of state.habits.values()) {
    if (!habit.createdDay) continue;
    if (earliest === null || habit.createdDay < earliest) earliest = habit.createdDay;
  }
  return earliest;
}

/** The trail of season rules, in the order they were written. Replay already validated them. */
function rulesOf(state) {
  const rules = state.meta && Array.isArray(state.meta.seasonRules) ? state.meta.seasonRules : [];
  return rules.filter((r) => r && ISO_DAY.test(r.from));
}

/**
 * The first `day`-th of a month STRICTLY after `from`.
 *
 * Strictly, so a schedule that begins on its own cycle day gets a whole month rather than a
 * zero-day first season: "every month from the 20th, starting 20 September" runs to 19 October.
 * Days are capped at 28 by the sheet and the store, so every month has the date and nothing here
 * has to know how long February is.
 */
export function nextCycleDay(from, day) {
  const [y, m, d] = from.split("-").map(Number);
  let yy = y;
  let mm = m;
  if (d >= day) {
    mm += 1;
    if (mm > 12) { mm = 1; yy += 1; }
  }
  return yy + "-" + String(mm).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

/**
 * The last day of a season that starts on [from] and runs [weeks] whole weeks.
 *
 * A season that starts mid-week gets the REST of that week plus its full weeks, rather than having
 * the stub consume one of them.
 *
 * It used to count from the Monday of the starting week unconditionally, which is defensible
 * arithmetic and produced a season shorter than a day: one week started on a Sunday ended that
 * same Sunday, so a real group's board read "Sun 06 Sept → Sun 06 Sept · Season over" before
 * anybody had played a day of it. Nobody choosing "1 week" means the remaining ninety minutes.
 *
 * Pure and shared, because the history list has to answer this for seasons the meta line no longer
 * points at — and a second copy of the rule is how the two would come to disagree about the same
 * season's dates.
 */
export function endFor(from, weeks) {
  if (!from || !weeks) return null;
  const monday = periodStart(isoWeekKey(from), PERIOD.WEEK);
  const firstFull = from === monday ? monday : addDays(monday, 7);
  return addDays(firstFull, weeks * 7 - 1);
}

/**
 * Every season the rules describe, oldest first — those that have run, the one running, and the
 * one booked next.
 *
 * A schedule is unrolled only as far as it needs to be: up to the window that contains `today`,
 * plus the one after it, so the board can say when the next begins. Nothing is generated for a
 * future nobody can see yet, and nothing is stored: a rule written once produces the same list on
 * every device, every day, for as long as it stands.
 */
export function seasonWindows(state, today) {
  const rules = rulesOf(state);
  const out = [];

  rules.forEach((rule, i) => {
    // In force until the day before the next rule begins. A later rule that starts on or before
    // this one's first day replaces it outright — booked, then re-booked — and it never ran.
    const next = rules[i + 1];
    const until = next ? addDays(next.from, -1) : null;
    if (until !== null && until < rule.from) return;

    if (rule.every) {
      let from = rule.from;
      for (;;) {
        const boundary = nextCycleDay(from, rule.every);
        let to = addDays(boundary, -1);
        let cut = false;
        if (until !== null && to > until) { to = until; cut = true; }
        out.push({
          from, to, weeks: null, every: rule.every, superseded: cut,
          // The run-in: a first season shorter than a month because the schedule began between
          // cycle days. Named so the sheet can say so, rather than leaving a six-day season to
          // look like a mistake beside the month-long ones.
          short: from.slice(8) !== String(rule.every).padStart(2, "0"),
        });
        // Past the window that holds today, one more is enough: it is the one being booked.
        if (cut || from > today) break;
        from = boundary;
      }
      return;
    }

    const own = endFor(rule.from, rule.weeks);
    const to = own && until !== null ? (own < until ? own : until) : (own || until);
    out.push({
      from: rule.from, to, weeks: rule.weeks || null, every: null,
      superseded: until !== null && (!own || until < own),
      short: false,
    });
  });

  return out.map((w, i) => ({
    ...w,
    index: i + 1,
    pending: w.from > today,
    // At most one, by construction: every window but the last is capped at the next one's start.
    current: w.from <= today && (!w.to || w.to >= today),
    ended: !!w.to && w.to < today,
  }));
}

/**
 * The window the board is about: the one running, or — between seasons — the one that just ended.
 *
 * A finished season's standings are what everybody played for. They stay on screen until the
 * morning the next one starts, rather than being swapped for an unrelated stretch from the
 * beginning of time; and while a schedule stands there is no gap to fall into at all.
 *
 * Null when nothing has run yet, which the callers read as "everything since the first habit".
 */
function resolveWindow(state, today) {
  const windows = seasonWindows(state, today);
  const live = windows.find((w) => w.current);
  if (live) return live;
  const done = windows.filter((w) => w.ended);
  return done.length ? done[done.length - 1] : null;
}

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
 * So a season rule moves the line. It is DERIVED-ONLY: nothing is deleted, no log is touched, no
 * streak breaks. Days before it stop being tallied and everything else — habits, targets, tapers,
 * history, per-habit streaks — is exactly as it was. Wiping the standings and wiping the data are
 * different requests, and this is the first one.
 *
 * Only ever moves the start FORWARD. A line before the first habit describes weeks that never
 * existed, so it is clamped to the habit's day. `today` is optional so that asking what the latest
 * line IS stays possible; every caller that renders a board passes it.
 */
export function seasonStart(state, today = null) {
  const earliest = firstHabitDay(state);
  let from = null;
  if (today) {
    const w = resolveWindow(state, today);
    from = w ? w.from : null;
  } else {
    const rules = rulesOf(state);
    from = rules.length ? rules[rules.length - 1].from : null;
  }
  if (from === null) return earliest;
  if (earliest === null) return from;
  return from > earliest ? from : earliest;
}

/**
 * The day the weekly BOARD opens on: this week's Monday, but never before the season it belongs to.
 *
 * The board resets on Mondays; a season resets it too. A season that begins mid-week — the 20th on
 * a Sunday — would otherwise let the board carry the Monday-to-Saturday tail of the season it
 * replaced into the new one, so a fresh contest opens with everybody already holding last season's
 * points instead of zero. Clamping the week to the season's own first day is what makes a new season
 * start everyone at zero, the same window the season view has always used. Pure, so the board's "from
 * here" and the season's "from here" cannot drift.
 */
export function boardStart(state, today) {
  const weekMonday = periodStart(isoWeekKey(today), PERIOD.WEEK);
  const start = seasonStart(state, today);
  return start && start > weekMonday ? start : weekMonday;
}

/**
 * The season that is coming but has not started, or null.
 *
 * Under a schedule there is always one — the next month's — and the board says so, because a
 * season that starts by itself is a season nobody was warned about otherwise. Started by hand, it
 * is only ever set between somebody booking one and the day it begins.
 */
export function pendingSeason(state, today) {
  const next = seasonWindows(state, today).find((w) => w.pending);
  return next ? next.from : null;
}

/** The schedule in force, or null when seasons are started by hand. */
export function seasonSchedule(state) {
  const rules = rulesOf(state);
  const last = rules.length ? rules[rules.length - 1] : null;
  return last && last.every ? { from: last.from, every: last.every } : null;
}

/**
 * How long a hand-started season runs, in whole ISO weeks — or null for one that never ends, and
 * null for a scheduled one, whose length is a month and not a count of weeks.
 */
export function seasonLength(state, today = null) {
  const w = today ? resolveWindow(state, today) : null;
  if (w) return w.weeks;
  const rules = rulesOf(state);
  const last = rules.length ? rules[rules.length - 1] : null;
  const n = last && !last.every ? last.weeks : null;
  return Number.isInteger(n) && n > 0 && n <= 104 ? n : null;
}

/** The last day of the season, or null if it has no end. */
export function seasonEnd(state, today = null) {
  const w = today ? resolveWindow(state, today) : null;
  if (w) return w.to;
  const start = seasonStart(state, today);
  return endFor(start, seasonLength(state, today));
}

/**
 * Where the season is: when it started, when it ends, how much is left, what comes next.
 *
 * One call, because every one of these is useless on its own — "ends Sunday" means nothing without
 * knowing whether that is this Sunday, and a progress bar with no dates is decoration.
 */
export function seasonProgress(state, today) {
  const start = seasonStart(state, today);
  if (!start) return null;

  const windows = seasonWindows(state, today);
  const w = resolveWindow(state, today);
  const next = windows.find((x) => x.pending) || null;
  const end = w ? w.to : null;
  const done = seasonTally(state, [], today).weeks;
  const base = {
    start,
    end,
    weeks: w ? w.weeks : null,
    done,
    index: w ? w.index : null,
    every: w ? w.every : null,
    short: !!(w && w.short),
    // The one booked, so the strip can say when — and, under a schedule, that it will happen on
    // its own.
    next: next ? { from: next.from, to: next.to, index: next.index, every: next.every, short: next.short } : null,
  };

  if (!end) return { ...base, daysLeft: null, ended: false, pct: null, days: null };

  const daysLeft = daysBetween(today, end);
  return {
    ...base,
    days: daysBetween(start, end) + 1,
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

/** Every whole week the season holds so far, oldest first. */
export function seasonWeeks(state, today) {
  const start = seasonStart(state, today);
  if (!start) return [];
  return weeksIn(start, seasonEnd(state, today), today);
}

/**
 * The WHOLE weeks inside a window, Monday to Sunday, that have begun by today.
 *
 * Crowns are for whole weeks. A season that starts on a Friday or ends on a Tuesday has days at
 * each end that count for XP — every day does — but a week of two days is not a week anybody can
 * be said to have won, so those stubs award nothing. That is what stops a season started on a
 * Sunday handing out a crown for one day, which it once did.
 */
export function weeksIn(from, to, today) {
  const last = to && to < today ? to : today;
  if (!from || last < from) return [];
  return periodsBetween(from, last, PERIOD.WEEK).filter((week) =>
    periodStart(week, PERIOD.WEEK) >= from && (!to || periodEnd(week, PERIOD.WEEK) <= to));
}

/**
 * Every season this group has run, newest first.
 *
 * Built from the rules replay leaves behind. Each entry carries only its window; the standings are
 * derived from the log on demand, so a season read back in a year is scored by today's engine
 * rather than by a snapshot taken at the time.
 */
export function seasonHistory(state, today) {
  return seasonWindows(state, today).slice().reverse();
}

/**
 * One week, ranked.
 *
 * Reuses the ordinary board rather than reimplementing it, so the crown a week awards is the same
 * crown the board showed at the time. A season built on a second opinion about who won would be a
 * season nobody believed.
 */
export function weekStandings(state, memberIds, weekKey, notBefore = null) {
  const weekOpens = periodStart(weekKey, PERIOD.WEEK);
  const to = periodEnd(weekKey, PERIOD.WEEK);
  // Never count days from before the line.
  //
  // Belt and braces now rather than the mechanism it once was: weeksIn only hands over weeks that
  // lie whole inside the season, so this cannot fire. It stays because the property it protects —
  // a season never scores a day that predates it — is one worth being unable to break by
  // accident, and the cost of keeping it is a comparison.
  const from = notBefore && notBefore > weekOpens ? notBefore : weekOpens;
  return leaderboard(state, memberIds, from, to, to);
}

/**
 * The running tally.
 *
 * XP is the sum of every CLOSED day in the season, at up to a hundred each — the day being played
 * is still being played. Crowns go to whole weeks, and only once the week is over: handing out its
 * trophy on a Tuesday, then taking it back on a Thursday, would make the tally something to
 * refresh rather than something to build.
 */
export function seasonTally(state, memberIds, today, window = null) {
  // `window` names a season explicitly, which is how a FINISHED one is read back. Without it the
  // answer is about the season the board is showing, and there is exactly one of those.
  const w = window || resolveWindow(state, today) || { from: seasonStart(state, today), to: null };
  if (!w.from) return { weeks: 0, days: 0, rows: [] };
  // Never before there was anything to score — see seasonStart.
  const earliest = firstHabitDay(state);
  const start = earliest && earliest > w.from ? earliest : w.from;

  // The closed days: yesterday at the latest, the season's last day once it is over.
  const last = w.to && w.to < today ? w.to : addDays(today, -1);
  const played = last >= start;
  const span = played ? leaderboard(state, memberIds, start, last, last) : [];

  const weeks = weeksIn(start, w.to, today);
  const done = weeks.filter((week) => periodEnd(week, PERIOD.WEEK) < today);

  const tally = new Map(memberIds.map((id) => [id, {
    memberId: id,
    name: id,
    crowns: 0,
    weeks: 0,
    days: 0,
    points: 0,
    // Kept apart from `points` as well as folded into it, because they answer different questions.
    // The total is where you stand; this is how much of it you earned by beating targets rather
    // than meeting them, which is the part somebody behind can actually use to close a gap.
    bonus: 0,
    pct: null,
    best: null,
    avg: null,
    // Weeks in a row with a crown. The thing worth protecting, and the thing that makes losing one
    // sting in a way a single week's percentage never does.
    crownStreak: 0,
    bestCrownStreak: 0,
  }]));

  // The total, from the closed days as one range — the same sum the board makes of a week, over
  // the whole season. A day is worth exactly a hundred and the total has to keep meaning that;
  // what beating the targets earned is its own column.
  for (const row of span) {
    const t = tally.get(row.memberId);
    if (!t) continue;
    t.name = row.name;
    t.points = row.points;
    t.bonus = row.bonusPoints || 0;
    t.days = row.scoredDays || 0;
    // "A day", the way the board says it: the mean of the days that were scored. A season with a
    // six-day run-in and a thirty-day month in it has no honest "a week" to average by.
    t.pct = row.pct;
    t.avg = row.pct;
  }

  // Then the weeks, for the crowns.
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
      if (!t.best || row.points > t.best.pct) t.best = { week, pct: row.points };
      if (row.crown) {
        t.crowns += 1;
        t.crownStreak += 1;
        t.bestCrownStreak = Math.max(t.bestCrownStreak, t.crownStreak);
      } else {
        t.crownStreak = 0;
      }
    }
  }

  const rows = [...tally.values()];

  // Ranked on POINTS, which is a change of game and worth saying so plainly.
  //
  // It used to rank on crowns, and crowns are all-or-nothing: three near-misses were worth exactly
  // as much as three terrible weeks, so the season was decided by a handful of Sundays and there
  // was nothing to play for the moment one person was clear. Points accrue every day, so a strong
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

  return { weeks: done.length, days: played ? daysBetween(start, last) + 1 : 0, rows };
}

/**
 * Where a member's score came from, by category.
 *
 * The board says 68%. It does not say that fitness carried it and discipline sank it, which is the
 * only part anybody can act on — a percentage tells you where you came, and this tells you what to
 * do about it on Monday.
 */
export function categoryBreakdown(state, memberId, from, to) {
  // Two different kinds of absent, and only one of them is worth drawing.
  //
  // A category the group does not RUN is not part of this group's game — a savings chip on a board
  // where nobody tracks money is a permanent blank asking a question with no answer. Those stay
  // filtered out, which is what they have always done.
  //
  // A category that exists but has nothing to judge YET is the opposite: it is a rule working —
  // a habit too young for this window, or a member away for all of it. Removing it left one row
  // showing three chips beside another showing four, with nothing anywhere saying why. Those are
  // drawn, and the board greys them.
  //
  // The Today screen has separated these two for a while, for exactly this reason; this is the
  // same fix one screen later.
  const played = new Set(
    [...state.habits.values()].filter((h) => h.scored).map((h) => categoryFor(h)),
  );
  return CATEGORY_ORDER
    .filter((category) => played.has(category))
    .map((category) => ({ category, ...categoryOver(state, memberId, from, to, category, addDays) }))
    .map((c) => ({ ...c, judged: c.pct !== null }));
}
