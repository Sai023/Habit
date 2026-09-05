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
import { MILESTONES, tierFor, habitCrossed, habitSpan } from "./milestones.js";

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
      // The tier's own line, which escalates with it, plus the badge named at the end. Somebody
      // reading this has done something rare and the sentence should sound like it knows that.
      body: tierFor(streak)
        ? tierFor(streak).line + " " + tierFor(streak).name + " is yours."
        : "Every habit, on goal, " + streak + " days running.",
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
    const who = other.name || "Someone";
    out.push({
      id: "milestone|" + other.memberId + "|" + other.streak + "|" + today,
      kind: "milestone",
      title: who + " hit " + other.streak + " days" + (tier ? " · " + tier.name : ""),
      // Their achievement, then where the reader stands — because this is a group tracker and the
      // second half is what makes the first half land. Only when the reader has a run of their own:
      // "you are on 0" beneath somebody's fifty days is a taunt, not a nudge.
      body: "Every habit, on goal, " + other.streak + " days running."
        + (tier ? " That is " + tier.name + "." : "")
        + (streak > 0 ? " You are on " + streak + "." : ""),
    });
  }

  // ---- One habit held on its own ----
  //
  // The small ones, and yours alone. A major milestone is every category met every day and the
  // whole group hears about it; this is thirty days of steps, which is a real thing to have done
  // and nobody else's business — announcing each would turn the group feed into a ticker.
  //
  // Gathered into ONE notice rather than one each. Three of these landing together is a good day,
  // and three separate buzzes in the same minute is how a good day becomes an annoyance — the
  // majors are the only ones that earn a notification to themselves.
  const crossed = [];
  for (const habit of state.habits.values()) {
    if (!isTracking(state, habit, memberId, today)) continue;
    const run = habitStreak(state, habit.habitId, memberId, today);
    if (!habitCrossed(run, habit.period)) continue;
    const [one, many] = UNIT[habit.period] || UNIT[PERIOD.DAY];
    crossed.push({
      habitId: habit.habitId,
      name: habit.name || "it",
      run,
      unit: run === 1 ? one : many,
      span: habitSpan(run, habit.period),
      reduce: habit.direction === AT_MOST,
    });
  }

  if (crossed.length) {
    // Longest first: if only some of them fit on a lock screen, the biggest should be the one that
    // does.
    crossed.sort((a, b) => b.run - a.run);
    out.push({
      // Keyed on the SET, not on the day.
      //
      // A streak can cross mid-morning and another mid-evening, so the day's set grows. Keying on
      // the day alone would fire once and silently swallow whatever crossed later — losing an
      // achievement outright. Keying on the set means the evening one arrives carrying both, which
      // repeats a line somebody already read. Repeating is the cheaper mistake by a distance.
      id: "habit-streaks|" + today + "|" + crossed.map((c) => c.habitId + ":" + c.run).join(","),
      kind: "milestone",
      title: crossed.length === 1
        ? crossed[0].run + " " + crossed[0].unit + " of " + crossed[0].name
        : countWord(crossed.length) + " streaks today",
      body: crossed.length === 1 ? soloLine(crossed[0]) : manyLine(crossed),
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

/**
 * One habit's streak, said in a way somebody would want to read twice.
 *
 * Names the habit, then translates the number. "60" is a figure a person has to convert before it
 * means anything; "two months" is the same fact already converted, and it is the half that makes
 * them stop. A ceiling gets a different verb from a floor, because "on goal" for something you are
 * quitting reads as nonsense.
 */
function soloLine(c) {
  const held = c.reduce ? "Under your limit" : "On goal";
  return held + " " + c.run + " " + c.unit + " running"
    + (c.span ? " — that is " + c.span + " without a slip." : ".");
}

/** Small counts read as words. "3 at once" is a receipt; "Three at once" is a remark. */
const COUNT_WORD = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
const countWord = (n) => COUNT_WORD[n] || String(n);

/** Several at once, listed longest first, with the total said out loud because it is the point. */
function manyLine(list) {
  const parts = list.map((c) => c.name + " " + c.run + " " + c.unit);
  const last = parts.pop();
  return parts.join(", ") + " and " + last + ". " + countWord(list.length) + " at once is a good day.";
}
