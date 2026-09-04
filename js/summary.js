// summary.js — the whole picture, small enough to hand to the shell.
//
// Pause's Home and Insights tabs are native, and they only ever knew about screen time, because
// that is the only thing Pause itself measures. Everything else — steps, sleep, the vape, the
// savings target — lives in this app's event log, so the two halves of a merged product each had
// their own idea of how the day was going and neither could show the other's.
//
// The fix is NOT to compute habits in Kotlin. That is the one rule this architecture has held to
// throughout: every verdict comes from habits.js, once, or the shell and the web drift into two
// answers for the same question and the board stops being trustworthy. So the web works it out and
// hands over the ANSWER — already decided, already formatted — and the shell renders it.
//
// Which makes this a wire format, and it is versioned like one. The shell caches whatever it was
// last given so Home still has something to draw with no WebView open and no signal, which means
// old shells will be reading new summaries and vice versa for as long as an APK takes to reach
// three phones.

import {
  walk, valueForPeriod, targetFor, rawPeriodStatus, isTracking, periodKey, periodStart, periodEnd, HIT, MISS, NO_DATA, EXEMPT,
} from "./habits.js";
import { leaderboard, dayScore, CATEGORY_LABEL, CATEGORY_ICON } from "./score.js";
import { seasonTally, categoryBreakdown } from "./season.js";
import { AT_MOST, PERIOD } from "./schema.js";
import * as fmt from "./ui/format.js";

export const SUMMARY_VERSION = 2;

/** How many days of history the shell gets. A week is what its screens actually draw. */
const WINDOW_DAYS = 7;

/**
 * Everything the shell needs to show a habit without knowing what a habit is.
 *
 * Values arrive pre-formatted as strings. The shell has no metric table, no notion that sleep is
 * stored in minutes and spoken in hours, and giving it one would be the second implementation this
 * whole design exists to avoid — a number that reads "450" in Pause and "7h 30m" in Goal Buddy is
 * two different numbers to the person holding the phone.
 */
function habitSummary(state, habit, me, today) {
  const key = periodKey(today, habit.period);
  const status = rawPeriodStatus(state, habit, me, key);
  const value = valueForPeriod(state, habit, me, key);
  const target = targetFor(
    state, habit, me, periodEnd(key, habit.period), periodStart(key, habit.period),
  );
  const w = walk(state, habit.habitId, me, today);
  const reduce = habit.direction === AT_MOST;

  return {
    id: habit.habitId,
    name: habit.name || "Habit",
    icon: habit.icon || "◆",
    period: habit.period,
    reduce,
    status,
    // What to show large. A ceiling counts DOWN — showing "6 of 20" for something you are quitting
    // puts the emphasis on the wrong number and makes a bad day look like progress.
    headline: reduce
      ? fmt.value(habit.metric, Math.max(0, target - (value || 0)))
      : fmt.value(habit.metric, value),
    caption: reduce
      ? "left of " + fmt.value(habit.metric, target)
      : status === NO_DATA ? "waiting for data" : fmt.goal(habit, target),
    streak: w ? w.streak : 0,
    // 0..100, or null when there is nothing to be a fraction of.
    progress: target > 0 && value != null
      ? Math.max(0, Math.min(100, Math.round(
          (reduce ? 1 - value / target : value / target) * 100,
        )))
      : null,
  };
}

/**
 * Build the snapshot.
 *
 * Deliberately a plain object with no Maps, Dates or undefined in it: it crosses to Kotlin as JSON
 * and back out of SharedPreferences days later, and anything that does not survive that round trip
 * is a bug that only appears on somebody else's phone.
 */
export function buildSummary(state, me, today, memberIds = null) {
  const habits = [...state.habits.values()]
    .filter((h) => isTracking(state, h, me, today))
    .map((h) => habitSummary(state, h, me, today));

  const members = memberIds || [...state.members.keys()];
  const from = shiftDay(today, -(WINDOW_DAYS - 1));
  const rows = members.length ? leaderboard(state, members, from, today, today) : [];
  const mine = rows.find((r) => r.memberId === me) || null;

  // Today, split the way the board splits it. The shell can then say what carried the day and what
  // sank it without knowing that a day is worth a hundred or how the four shares divide.
  const scored = dayScore(state, me, today, today);
  const season = members.length ? seasonTally(state, members, today) : { weeks: 0, rows: [] };
  const mySeason = season.rows.find((r) => r.memberId === me) || null;

  return {
    v: SUMMARY_VERSION,
    day: today,
    at: Date.now(),
    habits,
    // How the day went, as one line: the shell's Home screen wants a sentence, not a table.
    done: habits.filter((h) => h.status === HIT).length,
    due: habits.filter((h) => h.status === HIT || h.status === MISS).length,
    waiting: habits.filter((h) => h.status === NO_DATA).length,
    resting: habits.filter((h) => h.status === EXEMPT).length,
    // Out of 100 for today, and the categories behind it. Labels come pre-written for the same
    // reason the values do: the shell has no table of what a category is called.
    today_pct: scored.pct,
    categories: scored.categories
      .filter((c) => c.eligible)
      .map((c) => ({
        key: c.category,
        label: CATEGORY_LABEL[c.category],
        icon: CATEGORY_ICON[c.category],
        // Its own score, and the points it actually contributed. Both, because "80% of fitness"
        // and "29 of your 100" answer different questions and the screens want each.
        pct: Math.round(Math.min(1, c.score) * 100),
        points: Math.round(c.points),
        share: Math.round(c.share),
      })),
    week: categoryBreakdown(state, me, from, today).map((c) => ({
      key: c.category,
      label: CATEGORY_LABEL[c.category],
      icon: CATEGORY_ICON[c.category],
      pct: c.pct,
      days: c.days,
    })),
    // The long game. Weeks won, and a points total that only ever goes up.
    season: mySeason
      ? {
          weeks: season.weeks,
          rank: mySeason.rank,
          of: season.rows.length,
          crowns: mySeason.crowns,
          points: mySeason.points,
          avg: mySeason.avg,
          best: mySeason.best ? mySeason.best.pct : null,
          crownStreak: mySeason.crownStreak,
          bestCrownStreak: mySeason.bestCrownStreak,
        }
      : null,
    board: mine
      ? {
          rank: mine.rank,
          of: rows.length,
          pct: mine.pct,
          crown: !!mine.crown,
          clown: !!mine.clown,
          hits: mine.hits,
          eligible: mine.eligible,
          noData: mine.noData,
          streak: mine.streak,
        }
      : null,
  };
}

/** Local day arithmetic, kept here so this module does not need the engine's date helpers. */
function shiftDay(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Has anything the shell would draw actually changed? Keeps the bridge quiet on a repaint. */
export function summarySignature(summary) {
  return JSON.stringify({
    day: summary.day,
    done: summary.done,
    due: summary.due,
    waiting: summary.waiting,
    board: summary.board,
    today_pct: summary.today_pct,
    categories: summary.categories,
    season: summary.season,
    habits: summary.habits.map((h) => [h.id, h.status, h.headline, h.caption, h.streak, h.progress]),
  });
}
