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
import { targetFor, isTracking, sourceFor } from "../habits.js";
import { METRIC, AT_MOST, PERIOD, AUTOMATIC_SOURCES, SOURCE } from "../schema.js";

const CADENCE = { [PERIOD.DAY]: "a day", [PERIOD.WEEK]: "a week", [PERIOD.MONTH]: "a month" };

/** Sleep is stored in minutes but nobody sets a goal in minutes. */
const SCALE = {
  [METRIC.SLEEP]: { toInput: (v) => Math.round((v / 60) * 100) / 100, fromInput: (v) => Math.round(v * 60), unit: "hours", step: 0.25 },
};
const unitFor = (habit) => SCALE[habit.metric]?.unit
  || ({ [METRIC.STEPS]: "steps", [METRIC.PUFFS]: "puffs", [METRIC.SESSIONS]: "times",
        [METRIC.ACTIVE_CALORIES]: "kcal", [METRIC.SCREEN_MINUTES]: "minutes" }[habit.metric] || "");

export function openGoalsSheet(host, { state, me, firstRun = false, onDone }) {
  let saved = false;
  // onDone fires once however this went away — saved or dismissed — so the caller can refresh on
  // the way out without having to work out which happened.
  const sheet = openSheet(host, { onClose: () => onDone({ saved }) });

  const habits = [...state.habits.values()];

  const rows = habits.map((habit) => {
    const scale = SCALE[habit.metric];
    const current = targetFor(state, habit, me, habit.createdDay);
    return {
      habit,
      active: isTracking(state, habit, me),
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

        error ? el("p.err", error) : null,
        el("button.tap", { onclick: submit, disabled: busy },
          busy ? "Saving…" : firstRun ? "Start tracking" : "Save my goals"),
      ),
    );
  }

  function row(r) {
    const { habit } = r;
    const scale = SCALE[habit.metric];
    const auto = AUTOMATIC_SOURCES.has(sourceFor(state, habit, me));
    return el("div.starter" + (r.active ? ".on" : ""),
      el("button.starter-head", {
        onclick: () => { r.active = !r.active; paint(); },
        "aria-pressed": r.active ? "true" : "false",
      },
        el("span.card-icon", habit.icon || "◆"),
        el("span.starter-name", habit.name || "Habit"),
        el("span.starter-check", r.active ? "✓" : ""),
      ),
      r.active ? el("div.starter-body",
        el("p.starter-blurb",
          (habit.direction === AT_MOST ? "Stay under " : "Reach ") + "this "
            + (CADENCE[habit.period] || "a day") + ". "
            + (auto ? "Your watch fills this one in." : "You log this one yourself."),
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
      ) : null,
    );
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
      // Declare how each one is fed from THIS device: a browser, which cannot read health data
      // whatever the habit's default says. Pause re-declares it when it joins on a phone with
      // permission granted.
      //
      // Reading the habit's own source here instead would bind a web joiner to Health Connect and
      // make every one of their silent days read as a broken watch rather than as a miss — and it
      // would do it inconsistently, depending on whether the first pull happened to have landed.
      if (firstRun) {
        for (const r of rows) {
          if (r.active) await bindSource(r.habit.habitId, SOURCE.MANUAL);
        }
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
