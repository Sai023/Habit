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

import { taperWeekStart, targetFor, isTaperHeld, addDays } from "./habits.js";
import { AT_MOST } from "./schema.js";

/**
 * The streak lengths worth saying something about.
 *
 * Sparse on purpose. A nudge at every round number is a nudge nobody reads by the third one, and
 * the whole value of a milestone is that it is rare enough to feel like something.
 */
export const MILESTONES = [7, 30, 100, 365];

/**
 * Everything worth telling this member today.
 *
 * `streak` is the whole-app on-goal streak — the number the Home screen leads with — rather than a
 * per-habit one. With four habits and three people, per-habit milestones would fire often enough
 * to become wallpaper; "every habit, on goal, for thirty days" happens rarely and means something.
 */
export function noticesFor(state, memberId, today, streak) {
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
      title: streak + " days",
      body: streak === 7
        ? "A full week with every habit on goal. That is the hard part done."
        : "Every habit, on goal, " + streak + " days running.",
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
