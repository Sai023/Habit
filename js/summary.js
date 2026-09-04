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
  walk, valueForPeriod, targetFor, rawPeriodStatus, rawDayStatus, sourceFor, isTracking, periodKey, periodStart, periodEnd, HIT, MISS, NO_DATA, EXEMPT,
} from "./habits.js";
import { leaderboard, dayScore, CATEGORY_LABEL, CATEGORY_ICON } from "./score.js";
import { seasonTally, categoryBreakdown } from "./season.js";
import { noticesFor } from "./notices.js";
import { AT_MOST, PERIOD, AUTOMATIC_SOURCES } from "./schema.js";
import * as fmt from "./ui/format.js";

// 3 adds the bonus fields. Additive only: an older shell ignores what it does not know, and a
// newer one reads a missing bonus as zero, so three phones on three builds all stay readable.
export const SUMMARY_VERSION = 3;

/** How many days of history the shell gets. A week is what its screens actually draw. */
const WINDOW_DAYS = 7;

/**
 * Everything the shell needs to show a habit without knowing what a habit is.
 *
 * Values arrive pre-formatted as strings. The shell has no metric table, no notion that sleep is
 * stored in minutes and spoken in hours, and giving it one would be the second implementation this
 * whole design exists to avoid — a number that reads "450" on one screen and "7h 30m" on the next
 * is two different numbers to the person holding the phone.
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
  const streak = onGoalStreak(state, me, today);
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
    // The second currency, kept separate from the percentage on purpose — the day is still worth
    // exactly a hundred, and this is what beating the targets earned on top of it.
    today_bonus: scored.bonus,
    // Why it is zero when it is zero. A penalty nobody can see is indistinguishable from a bug,
    // and "you would have earned 12" is the sentence that makes it a reason to log tomorrow.
    bonus_held: !!scored.bonusForfeited,
    bonus_withheld: scored.bonusWithheld || 0,
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
        bonus: Math.round(c.bonus || 0),
      })),
    week: categoryBreakdown(state, me, from, today).map((c) => ({
      key: c.category,
      label: CATEGORY_LABEL[c.category],
      icon: CATEGORY_ICON[c.category],
      pct: c.pct,
      days: c.days,
    })),
    // Consecutive days everything due was met, across every habit. Pause draws its hero from this
    // now instead of from screen time alone.
    onGoalStreak: streak,
    // What the shell needs to work out, at nine in the evening, whether anything is still
    // outstanding — WITHOUT re-implementing scoring. See riskContract().
    risk: riskContract(state, me, today),
    // Already-worded things the shell should consider posting, each with a stable id it dedupes
    // on. The shell never learns why any of them is here — deciding that means knowing what a
    // streak is, and that answer exists once, in the engine.
    notices: noticesFor(state, me, today, streak),
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
          // Of the points total, how much came from beating targets rather than meeting them.
          bonus: mySeason.bonus,
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
          bonus: mine.bonus || 0,
          bonusWithheld: mine.bonusWithheld || 0,
        }
      : null,
  };
}

/**
 * Consecutive days you did everything that was asked of you — across every habit, not one of them.
 *
 * Pause has always shown an on-goal streak and it has always meant "days where the apps you slowed
 * stayed under their limit", because screen time is the only thing Pause measures itself. On a
 * phone that is also tracking steps, sleep and a vape, a streak counting one of the four is a
 * number that looks like the whole picture and is not.
 *
 * A day is on goal when every habit that was DUE was met. Days where nothing was due do not count
 * and do not break it — that is a rest day or a silent sensor, and neither is a failure. Today is
 * only counted once it is already won, the same rule the per-habit streak uses: a hit cannot later
 * become a miss, so counting it early is safe and lets the number tick up the moment it is earned.
 */
/**
 * What each daily habit is asking for today, in terms the shell can check on its own.
 *
 * ---- Why this is data and not a verdict ----
 *
 * The at-risk nudge has to fire at nine in the evening on a day nobody opened the app — which is
 * exactly the day it matters, and exactly the day this summary is stale. The shell cannot ask the
 * engine anything at that moment: there is no WebView running.
 *
 * So it is given the two things it cannot derive — the TARGET, which the taper makes
 * path-dependent and impossible to compute from a formula, and the STREAK, which is what decides
 * whether a habit is worth protecting — and it reads today's VALUE itself, fresh, from Health
 * Connect or its own counters or the room. Target and streak move slowly; the value moves all day.
 * Pairing a slow fact with a fresh one is what makes the answer honest without a second engine.
 *
 * The line this holds: the shell compares a number to a number and reports what it finds. It never
 * says a day is lost, because whether a day is lost is a verdict and verdicts are decided once,
 * here. "Nothing logged yet" and "6,200 of 8,000" are facts about data, true whatever the engine
 * would go on to conclude.
 *
 * Daily habits only. "Three times a week" cannot be outstanding on a Tuesday, and a monthly
 * savings goal is deliberately not judged until the month closes.
 */
function riskContract(state, me, today) {
  const out = [];
  for (const habit of state.habits.values()) {
    if (habit.period !== PERIOD.DAY) continue;
    if (!habit.scored) continue;
    if (!isTracking(state, habit, me, today)) continue;
    // A day already excused — travel, a rest day — is not one to chase somebody about.
    if (rawDayStatus(state, habit, me, today) === EXEMPT) continue;

    const w = walk(state, habit.habitId, me, today);
    out.push({
      id: habit.habitId,
      name: habit.name || "Habit",
      icon: habit.icon || "◆",
      metric: habit.metric || "",
      // "at_most" is a ceiling: outstanding means OVER. "at_least" is a floor: outstanding means
      // under. One field, because the shell has no table of what a metric means.
      dir: habit.direction,
      target: targetFor(state, habit, me, today),
      // Whether silence is a miss. An automatic source going quiet is a broken pipeline and must
      // not be reported as something the person failed to do.
      manual: !AUTOMATIC_SOURCES.has(sourceFor(state, habit, me)),
      streak: w ? w.streak : 0,
    });
  }
  return out;
}

function onGoalStreak(state, me, today) {
  let streak = 0;
  let day = today;

  // Today counts only if it is already complete; otherwise start from yesterday, so a streak does
  // not appear to reset every morning.
  const todayScore = dayScore(state, me, today, today);
  const todayDone = todayScore.categories.some((c) => c.eligible)
    && todayScore.categories.every((c) => !c.eligible || c.score >= 1);
  if (!todayDone) day = shiftDay(today, -1);

  // A year is further back than anybody will look, and stops a corrupt log spinning forever.
  for (let i = 0; i < 366; i += 1) {
    const score = dayScore(state, me, day, today);
    const live = score.categories.filter((c) => c.eligible);
    if (!live.length) {
      // Nothing was asked. Neither a win nor a loss — step over it.
      day = shiftDay(day, -1);
      continue;
    }
    if (!live.every((c) => c.score >= 1)) break;
    streak += 1;
    day = shiftDay(day, -1);
  }
  return streak;
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
    onGoalStreak: summary.onGoalStreak,
    categories: summary.categories,
    season: summary.season,
    habits: summary.habits.map((h) => [h.id, h.status, h.headline, h.caption, h.streak, h.progress]),
  });
}
