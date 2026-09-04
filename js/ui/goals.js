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
import { caps } from "../bridge.js";
import {
  METRIC, AT_MOST, PERIOD, AUTOMATIC_SOURCES, SOURCE, HEALTH_METRICS, PAUSE_METRICS,
  sourceForDevice,
} from "../schema.js";

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
    // What they last SET, not what is currently in force — a change made yesterday is already
    // theirs even though it starts counting today, and showing the old number would invite them
    // to "fix" it a second time.
    const set = latestGoal(state, habit.habitId, me);
    const current = set && Number.isFinite(set.target) && set.target > 0
      ? set.target
      : targetFor(state, habit, me, habit.createdDay);
    const canAuto = deviceSourceFor(habit.metric) !== SOURCE.MANUAL;
    return {
      habit,
      active: isTracking(state, habit, me),
      // The group agreed WHAT is tracked; how it reaches the log is each person's own answer, and
      // on a phone with a watch it is a different answer from the same person's browser.
      tracked: canAuto && (firstRun || AUTOMATIC_SOURCES.has(sourceFor(state, habit, me))),
      target: scale ? scale.toInput(current) : current,
    };
  });

  let busy = false;
  let error = "";

  function paint() {
    sheet.paint(
      el("div.form",
        el("h1", firstRun ? "What are you in for?" : "Your goals"),
        el("p.lede", firstRun
          ? "Your friends are tracking these. Pick the ones you're doing and set your own targets."
          : "Your own targets. Everyone's are separate — the group only agrees on what's tracked."),

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
          }, PAUSE_METRICS.has(habit.metric) ? "Pause counts it" : "My watch"),
          el("button.chip" + (!r.tracked ? ".on" : ""), {
            onclick: () => { r.tracked = false; paint(); },
          }, "I log it"),
        ) : null,
        el("p.starter-blurb", trackingNote(habit, r, canAuto)),
      ) : null,
    );
  }

  /** The consequence, in the words of somebody about to live with it. */
  function trackingNote(habit, r, canAuto) {
    if (!couldBeAutomatic(habit.metric)) return "You log this one yourself.";
    if (!canAuto) {
      return PAUSE_METRICS.has(habit.metric)
        ? "Only Pause on your phone can count this \u2014 here, you log it."
        : "This device can't read health data, so you log it here.";
    }
    if (r.tracked) return "Quiet days show as no data rather than a miss.";
    return habit.direction === AT_MOST
      ? "A day you don't log counts as a miss \u2014 log a zero for a clean day."
      : "A day you don't log counts as a miss.";
  }

  async function submit() {
    if (busy) return;
    for (const r of rows) {
      if (!r.active) continue;
      const n = Number(r.target);
      if (!Number.isFinite(n) || n <= 0) {
        error = "Give " + (r.habit.name || "each habit") + " a target greater than zero.";
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
