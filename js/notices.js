// notices.js — the things worth interrupting somebody for.
//
// ---- Why the engine decides and the shell only delivers ----
//
// Pause owns notifications because only it can post one. It does not own WHAT is worth posting,
// and it must not: working out that a streak has just reached thirty means knowing what a streak
// is, and that answer already exists once, here. A second implementation in Kotlin would be a
// second opinion about the number on the front of the app — and the first time the two disagreed,
// the group would stop believing either.
//
// So this produces a small list of already-worded notices and the shell fires whichever it has not
// fired before. It never learns why.
//
// ---- Why each one carries an id ----
//
// Nothing here is stored. The tally, the streaks and the taper are all derived on every replay, so
// this function runs again on every sync and produces the same notices for as long as they remain
// true — a milestone is "true" all day, and a taper week is true for seven of them. Left alone the
// shell would buzz on every pass.
//
// The id is what makes that safe: stable for the same event, different for a genuinely new one. It
// is the shell's dedupe key and the reason this can stay a pure function of the log rather than
// becoming a queue somebody has to drain.

import { taperWeekStart, targetFor, isTaperHeld, addDays, streak as habitStreak, isTracking } from "./habits.js";
import { AT_MOST, PERIOD } from "./schema.js";
import { MILESTONES, tierFor, habitCrossed } from "./milestones.js";

/** What a streak counts in, for the habit it belongs to. */
const UNIT = {
  [PERIOD.DAY]: ["day", "days"],
  [PERIOD.WEEK]: ["week", "weeks"],
  [PERIOD.MONTH]: ["month", "months"],
};

// The four live in milestones.js with the badges they earn, so the thing that fires the
// notification and the thing that draws the award can never disagree about what counts.
export { MILESTONES };

/**
 * Everything worth telling this member today.
 *
 * `streak` is the whole-app on-goal streak — the number the day hero leads with — rather than a
 * per-habit one. With six habits and three people, per-habit milestones would fire often enough to
 * become wallpaper; "every habit, on goal, for fifty days" happens rarely and means something.
 *
 * `others` is the same number for everybody else, as `{ memberId, name, streak }`. Computing it is
 * the caller's job because it needs the scorer, and this module deliberately cannot see it.
 */
export function noticesFor(state, memberId, today, streak, others = []) {
  const out = [];

  // ---- A milestone reached ----
  //
  // Only on the day it is CROSSED, which is what `=== n` buys: a streak sits at 30 for one day and
  // then moves on, so the notice exists for that day alone. If the run breaks and is rebuilt back
  // to thirty, the day is different and it is genuinely worth saying again.
  if (MILESTONES.includes(streak)) {
    out.push({
      id: "milestone|" + streak + "|" + today,
      kind: "milestone",
      title: streak + " days" + (tierFor(streak) ? " · " + tierFor(streak).name : ""),
      body: streak === 7
        ? "A full week with every habit on goal. That is the hard part done — and Bronze is yours."
        : "Every habit, on goal, " + streak + " days running. "
          + (tierFor(streak) ? tierFor(streak).name + " is yours." : ""),
    });
  }

  // ---- Somebody else got there ----
  //
  // The half of a group tracker that was missing. Until now the app only ever told you about you,
  // in an app whose entire premise is three people watching each other — a friend reaching fifty
  // days is more use to somebody's own streak than any nudge this app could invent about theirs.
  //
  // Same crossing rule as above, so it fires on the one day it is true. Keyed by member as well as
  // by number, because two people can cross the same milestone on the same day and both deserve
  // saying.
  for (const other of others) {
    if (other.memberId === memberId) continue;
    if (!MILESTONES.includes(other.streak)) continue;
    const tier = tierFor(other.streak);
    out.push({
      id: "milestone|" + other.memberId + "|" + other.streak + "|" + today,
      kind: "milestone",
      title: (other.name || "Someone") + " hit " + other.streak + " days",
      body: tier
        ? "Every habit, on goal, " + other.streak + " days running — that is " + tier.name + "."
        : "Every habit, on goal, " + other.streak + " days running.",
    });
  }

  // ---- One habit held on its own ----
  //
  // The small ones, and yours alone. A major milestone is every category met every day and the
  // whole group hears about it; this is thirty days of steps, which is a real thing to have done
  // and nobody else's business — announcing it would turn the group feed into a ticker.
  //
  // Thresholds are per cadence, because a streak counts PERIODS: thirty of a daily habit is a
  // month, thirty of a monthly one is nearly three years.
  for (const habit of state.habits.values()) {
    if (!isTracking(state, habit, memberId, today)) continue;
    const run = habitStreak(state, habit.habitId, memberId, today);
    if (!habitCrossed(run, habit.period)) continue;

    const [one, many] = UNIT[habit.period] || UNIT[PERIOD.DAY];
    const unit = run === 1 ? one : many;
    out.push({
      id: "habit-streak|" + habit.habitId + "|" + run + "|" + today,
      kind: "milestone",
      title: run + " " + unit + " of " + (habit.name || "it"),
      body: habit.direction === AT_MOST
        ? "Under your limit " + run + " " + unit + " running."
        : "On goal " + run + " " + unit + " running.",
    });
  }

  // ---- A taper week that has just turned over ----
  //
  // On the day the allowance actually changes, which is personal: the schedule counts from each
  // member's own baseline, so it is not everybody's Monday.
  for (const habit of state.habits.values()) {
    const weekStart = taperWeekStart(state, habit, memberId, today);
    if (weekStart !== today) continue; // not the first day of a taper week
    if (habit.direction !== AT_MOST) continue;

    const now = targetFor(state, habit, memberId, today);
    const before = targetFor(state, habit, memberId, addDays(today, -1));
    const held = isTaperHeld(state, habit, memberId, today);

    if (held) {
      out.push({
        id: "taper|" + habit.habitId + "|" + today + "|held",
        kind: "taper",
        title: habit.name || "Your limit",
        // Names the cause, because a limit that failed to move without explanation reads as a bug
        // and this one was earned.
        body: "Staying at " + now + " this week — you went over on three days, so the step waits. "
          + "No bonus points this week either.",
      });
    } else if (now < before) {
      out.push({
        id: "taper|" + habit.habitId + "|" + today,
        kind: "taper",
        title: habit.name || "Your limit",
        body: now === 0
          ? "This is the week it reaches zero. Nothing left on the allowance — that was the whole plan."
          : "Down to " + now + " a day this week, from " + before + ".",
      });
    }
  }

  return out;
}
