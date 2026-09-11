// goals.js — "which of these are you in for, and what's your number?"
//
// Shown once when you join a group, and reachable afterwards from the Habits tab, because a goal
// that cannot be revised is a goal you eventually start lying about.
//
// The group agrees on WHAT it tracks. Each person picks which of those they are actually doing and
// sets their own target for it — ten thousand steps is a stretch for one of them and a slow
// morning for another, and scoring both against one number measures fitness rather than effort.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { setGoals, bindSource } from "../store.js";
import { targetFor, isTracking, sourceFor, latestGoal } from "../habits.js";
import { goalToShow } from "../edits.js";
import { caps } from "../bridge.js";
import {
  METRIC, AT_MOST, PERIOD, AUTOMATIC_SOURCES, SOURCE, HEALTH_METRICS, PAUSE_METRICS,
  VISIBILITY, sourceForDevice,
} from "../schema.js";

/** ISO weekdays, Monday first, which is how a week is spoken here. */
const WEEKDAYS = [[1, "M"], [2, "T"], [3, "W"], [4, "T"], [5, "F"], [6, "S"], [7, "S"]];

/** "07:00" from a minute of the day, and back. */
const toClock = (minute) =>
  String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
const fromClock = (text) => {
  const [h, m] = String(text || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(1439, h * 60 + m));
};

/** Could anything ever read this metric, and can THIS device? Two different questions. */
const couldBeAutomatic = (metric) => HEALTH_METRICS.has(metric) || PAUSE_METRICS.has(metric);
const deviceSourceFor = (metric) => {
  const c = caps();
  return sourceForDevice(metric, { pause: c.embedded, health: c.healthConnect });
};

const CADENCE = { [PERIOD.DAY]: "a day", [PERIOD.WEEK]: "a week", [PERIOD.MONTH]: "a month" };

/** Sleep is stored in minutes but nobody sets a goal in minutes. */
const SCALE = {
  [METRIC.SLEEP]: { toInput: (v) => Math.round((v / 60) * 100) / 100, fromInput: (v) => Math.round(v * 60), unit: "hours", step: 0.25 },
};
const unitFor = (habit) => SCALE[habit.metric]?.unit
  || ({ [METRIC.STEPS]: "steps", [METRIC.PUFFS]: "puffs", [METRIC.SESSIONS]: "times",
        [METRIC.ACTIVE_CALORIES]: "kcal", [METRIC.SCREEN_MINUTES]: "minutes",
        [METRIC.APP_OPENS]: "opens" }[habit.metric] || "");

export function openGoalsSheet(host, { state, me, firstRun = false, onDone }) {
  let saved = false;
  // onDone fires once however this went away — saved or dismissed — so the caller can refresh on
  // the way out without having to work out which happened.
  const sheet = openSheet(host, { onClose: () => onDone({ saved }) });

  const habits = [...state.habits.values()];

  const rows = habits.map((habit) => {
    const scale = SCALE[habit.metric];
    // What they last SET, not what is currently in force. The rule and the reason moved into
    // edits.js when the habit editor was found answering it differently — see goalToShow.
    const set = latestGoal(state, habit.habitId, me);
    const current = goalToShow(state, habit, me, habit.createdDay);
    const canAuto = deviceSourceFor(habit.metric) !== SOURCE.MANUAL;
    return {
      habit,
      active: isTracking(state, habit, me),
      // The group agreed WHAT is tracked; how it reaches the log is each person's own answer, and
      // on a phone with a watch it is a different answer from the same person's browser.
      tracked: canAuto && (firstRun || AUTOMATIC_SOURCES.has(sourceFor(state, habit, me))),
      target: scale ? scale.toInput(current) : current,
      // Mine, not the group's. Falls back to whatever the habit carries from before reminders were
      // personal, so an existing one keeps working until its owner touches this control.
      remindAt: set && set.remindAt !== undefined ? set.remindAt : (habit.remindAt ?? null),
      // Mon/Wed/Fri, not all seven. This list only exists for a habit judged over something longer
      // than a day, and defaulting it to every day would reinstate the exact behaviour it was
      // added to stop: four wasted notifications a week for a thing you do three times, which is
      // how somebody learns to swipe them away.
      // Mine too, with the habit as the fallback for a row written before it was personal.
      visibility: set && set.visibility !== undefined ? set.visibility : habit.visibility,
      remindDays: (set && set.remindDays && set.remindDays.length ? set.remindDays : null)
        || (habit.remindDays && habit.remindDays.length ? habit.remindDays : null)
        || [1, 3, 5],
    };
  });

  let busy = false;
  let error = "";

  function paint() {
    sheet.paint(
      el("div.form",
        el("h1", firstRun ? "What are you in for?" : "Your goals"),
        el("p.lede", firstRun
          ? "Your friends are tracking these. Pick the ones you're doing and set your own goals."
          : "Your own goals. Everyone's are separate — the group only agrees on what's tracked."),

        el("div.starters", rows.map(row)),

        el("p.note-inline",
          "You're measured against your own number, so nobody is competing with anyone else's fitness."),
        // Said before they save, not after. A change that silently did nothing until tomorrow
        // would read as a bug the first time somebody checked, and a change that silently applied
        // to yesterday is the thing this rule exists to stop.
        firstRun ? null : el("p.note-inline",
          "Changes start counting tomorrow. Today is judged on what you'd already set — which is "
          + "also why nobody can rescue a bad week from this screen."),

        error ? el("p.err", error) : null,
        el("button.tap", { onclick: submit, disabled: busy },
          busy ? "Saving…" : firstRun ? "Start tracking" : "Save my goals"),
      ),
    );
  }

  function row(r) {
    const { habit } = r;
    const scale = SCALE[habit.metric];
    const canAuto = deviceSourceFor(habit.metric) !== SOURCE.MANUAL;
    return el("div.starter" + (r.active ? ".on" : ""),
      el("button.starter-head", {
        onclick: () => { r.active = !r.active; paint(); },
        "aria-pressed": r.active ? "true" : "false",
      },
        el("span.card-icon", habit.icon || "\u25c6"),
        el("span.starter-name", habit.name || "Habit"),
        el("span.starter-check", r.active ? "\u2713" : ""),
      ),
      r.active ? el("div.starter-body",
        el("p.starter-blurb",
          (habit.direction === AT_MOST ? "Stay under " : "Reach ") + "this "
            + (CADENCE[habit.period] || "a day") + ".",
        ),
        el("label.inline-field",
          el("input", {
            type: "number", min: "0", inputmode: "decimal",
            step: scale ? scale.step : 1,
            value: r.target,
            oninput: (e) => { r.target = e.target.value; },
          }),
          el("span", unitFor(habit) + " " + (CADENCE[habit.period] || "a day")),
        ),
        // Asked, not assumed. It is the answer that decides whether a quiet day of theirs reads as
        // a broken pipeline or as a miss, and the board is built on the difference — so the person
        // it will be applied to is the one who gets to say it.
        couldBeAutomatic(habit.metric) ? el("div.chips.chips-tight",
          el("button.chip" + (r.tracked ? ".on" : ""), {
            disabled: !canAuto,
            onclick: () => { if (canAuto) { r.tracked = true; paint(); } },
          }, PAUSE_METRICS.has(habit.metric) ? "Goal Buddy counts it" : "My watch"),
          el("button.chip" + (!r.tracked ? ".on" : ""), {
            onclick: () => { r.tracked = false; paint(); },
          }, "I log it"),
        ) : null,
        el("p.starter-blurb", trackingNote(habit, r, canAuto)),
        seenBy(r),
        reminder(r),
      ) : null,
    );
  }

  /**
   * How much of your number the group gets.
   *
   * It used to sit on the new-habit screen, which made it one answer for everybody: the group
   * agreed to track sleep, and whoever created the habit decided on behalf of all three whether a
   * number or a tick was shown. Nobody was asked. Here it is one row per person, next to the
   * target and the source, and it governs YOUR figures only — see visibilityFor for why the
   * setting that applies is the owner's rather than the viewer's.
   *
   * Still shown to you in full on Today either way. Hiding your own numbers from yourself is the
   * one reading of "private" nobody means.
   */
  function seenBy(r) {
    const CHOICES = [
      [VISIBILITY.FULL, "My numbers", "The group sees the figure."],
      [VISIBILITY.PROGRESS, "Progress only", "They see how close you got, not the number."],
      [VISIBILITY.PRIVATE, "Just ✓ / ✗", "They see whether you hit it, and nothing else."],
    ];
    const chosen = CHOICES.find(([v]) => v === r.visibility) || CHOICES[0];
    return el("div.remind",
      el("p.starter-blurb", "What the group sees"),
      el("div.chips.chips-tight", CHOICES.map(([v, label]) =>
        el("button.chip" + (r.visibility === v ? ".on" : ""), {
          onclick: () => { r.visibility = v; paint(); },
        }, label))),
      el("p.starter-blurb", chosen[2] + " Yours alone — it says nothing about anyone else."),
    );
  }

  /**
   * When to be nudged about this one.
   *
   * It used to live on the new-habit screen, beside the metric, the cadence and the category —
   * everything on that screen is the GROUP's answer, agreed once and replayed identically on every
   * phone, and a reminder is the one thing there that never was. Stored on the habit, it meant one
   * alarm clock shared by everybody: set yours for six in the morning and you set Thabo's too.
   *
   * Here it is next to your target and your source, which are the other two things about a habit
   * that are yours alone — and it makes the screen you use to CREATE a habit shorter by a section
   * nobody creating a habit is thinking about yet.
   */
  function reminder(r) {
    // A daily habit does not get an alarm of its own, and that is the rule rather than an
    // omission. Everything daily is asked for at the same moment — eight in the evening, once,
    // "go and update your day" — because six daily habits with six alarms is six notifications a
    // night, and the reliable outcome of that is somebody switching the lot off.
    //
    // Weekly and monthly are the opposite case. "Three workouts a week" and "save this much by
    // month end" happen around a personal schedule nobody else can guess, so those carry their
    // own time and their own days.
    if (r.habit.period === PERIOD.DAY) return dailyNote();

    const on = r.remindAt != null;
    // A month has no day of the week in it. "Save this much by the end of the month" is asked once,
    // at month end — the same thing the cadence line on the editor already promises — so offering
    // weekday chips here would be asking a question whose answer cannot be honoured.
    const monthly = r.habit.period === PERIOD.MONTH;
    return el("div.remind",
      el("div.chips.chips-tight",
        el("button.chip" + (!on ? ".on" : ""), {
          onclick: () => { r.remindAt = null; paint(); },
        }, "No reminder"),
        el("button.chip" + (on ? ".on" : ""), {
          onclick: () => { if (!on) { r.remindAt = 19 * 60; paint(); } },
        }, "Remind me"),
      ),
      on ? el("label.inline-field",
        el("input", {
          type: "time",
          value: toClock(r.remindAt),
          oninput: (e) => {
            const m = fromClock(e.target.value);
            if (m != null) r.remindAt = m;
          },
        }),
        el("span", monthly ? "on the last day of the month"
          : r.remindDays.length === 7 ? "every day" : "on the days below"),
      ) : null,
      on && !monthly ? el("div.chips.chips-days", WEEKDAYS.map(([n, label]) =>
        el("button.chip.chip-day" + (r.remindDays.includes(n) ? ".on" : ""), {
          "aria-label": "Day " + n,
          onclick: () => {
            const next = r.remindDays.includes(n)
              ? r.remindDays.filter((d) => d !== n)
              : [...r.remindDays, n].sort();
            // Never none: a reminder switched on that fires on no day is a setting that lies.
            if (next.length) { r.remindDays = next; paint(); }
          },
        }, label))) : null,
      // "Three workouts a week" is silent about which three on purpose, and the engine keeps it
      // that way. Said here because the line above promises the opposite about scoring, and the
      // two together without a word read as a contradiction rather than a division of labour.
      on
        ? el("p.starter-blurb", monthly
            ? "Asked once, when the month closes. Yours alone — everyone sets their own time."
            : "Nudges only — the total is still the only thing scored, so a missed Wednesday costs "
              + "nothing on its own. Yours alone: everyone sets their own.")
        : null,
    );
  }

  /**
   * What a daily habit gets instead: the one evening prompt, named so it is not a silence.
   *
   * Without this the reminder block simply vanishes on five of the six habits, and the honest
   * reading of a missing control is "this one cannot be reminded" — which is the opposite of true.
   */
  function dailyNote() {
    return el("div.remind",
      el("p.starter-blurb",
        "Nudged at 8pm with everything else daily — one prompt to update the day, not one per "
        + "habit."),
    );
  }

  /** The consequence, in the words of somebody about to live with it. */
  function trackingNote(habit, r, canAuto) {
    if (!couldBeAutomatic(habit.metric)) return "You log this one yourself.";
    if (!canAuto) {
      return PAUSE_METRICS.has(habit.metric)
        ? "Only Goal Buddy on your phone can count this — here, you log it."
        : "This device can't read health data, so you log it here.";
    }
    if (r.tracked) return "Quiet days show as no data rather than a miss.";
    return habit.direction === AT_MOST
      ? "A day you don't log counts as a miss — log a zero for a clean day."
      : "A day you don't log counts as a miss.";
  }

  async function submit() {
    if (busy) return;
    for (const r of rows) {
      if (!r.active) continue;
      const n = Number(r.target);
      if (!Number.isFinite(n) || n <= 0) {
        error = "Give " + (r.habit.name || "each habit") + " a goal greater than zero.";
        return paint();
      }
    }
    busy = true; error = ""; paint();
    try {
      await setGoals(rows.map((r) => {
        const scale = SCALE[r.habit.metric];
        const raw = Number(r.target);
        return {
          habitId: r.habit.habitId,
          active: r.active,
          target: scale ? scale.fromInput(raw) : Math.round(raw),
          // Daily habits are covered by the one 8pm prompt and never carry an alarm of their own,
          // so this writes an explicit null for them rather than leaving whatever the old editor
          // put there — see reminderFor in app.js.
          visibility: r.visibility,
          remindAt: r.habit.period === PERIOD.DAY ? null : r.remindAt,
          // Weekly only. A daily habit is covered by the 8pm prompt and a monthly one is asked at
          // month end, so neither has a weekday list that means anything.
          remindDays: r.habit.period === PERIOD.WEEK && r.remindAt != null ? r.remindDays : [],
        };
      }));
      // Record how each one is fed from THIS device, from what they just said rather than from
      // what could be inferred. Written every time rather than only on the first run, because
      // changing your mind — a new watch, or giving up on one — is the reason to come back here.
      //
      // Reading the habit's own source instead would bind a web joiner to Health Connect and make
      // every one of their silent days read as a broken watch rather than as a miss — and it would
      // do it inconsistently, depending on whether the first pull had landed.
      for (const r of rows) {
        if (!r.active) continue;
        await bindSource(
          r.habit.habitId,
          r.tracked ? deviceSourceFor(r.habit.metric) : SOURCE.MANUAL,
        );
      }
      saved = true;
      sheet.close();
    } catch (err) {
      error = "Couldn't save: " + (err && err.message ? err.message : err);
      busy = false;
      paint();
    }
  }

  paint();
}
