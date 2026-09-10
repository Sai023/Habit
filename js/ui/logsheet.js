// logsheet.js — typing a number in.
//
// Half the habits here have no sensor behind them: puffs read off a vape, a workout, a savings
// figure at month end. This is where those get entered, and it is also the manual override for the
// ones a watch normally fills in — the case the very first design review called for, when a phone
// is asleep or a watch has not synced.
//
// The sheet asks a different question depending on how the habit accumulates, because getting that
// backwards silently corrupts the number:
//
//   sum   "how many to ADD" — three workouts logged separately make three, and a sheet that set
//         the total instead would quietly overwrite the first two.
//   last  "what is it NOW" — a savings balance is already a running total, and adding to it every
//         time you check would have you saving four times what you did.
//
// ---- The answer it could not give ----
//
// Zero. "Adding nothing is just cancelling" is right when there is already a number to add to, and
// it was applied to the case where there is not — so a day with no puffs at all could be typed
// into the field and then silently discarded on save.
//
// That is a scoring bug wearing a UI bug's clothes. A manual habit with no entry is a MISS, on
// purpose: the vape keeps the count, so silence is an unreported day rather than an unknowable one.
// Which means the person who actually managed zero got the same verdict as the person who could
// not face admitting to eighty — a broken streak, Discipline down, and no way at all to say what
// had really happened.
//
// So zero is now sayable, and on a ceiling with nothing logged yet it is a button, because it is
// the answer people most want to give and typing it was never going to occur to anybody.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { logValue } from "../store.js";
import { valueForPeriod, targetFor, periodKey, periodEnd } from "../habits.js";
import { AGGREGATE, AT_MOST, METRIC, PERIOD } from "../schema.js";

const CADENCE = { [PERIOD.DAY]: "today", [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };

/** Sleep is stored in minutes; nobody enters sleep in minutes. */
const SCALE = {
  [METRIC.SLEEP]: { to: (v) => Math.round((v / 60) * 100) / 100, from: (v) => Math.round(v * 60), unit: "hours", step: 0.25 },
};
const UNIT = {
  [METRIC.STEPS]: "steps", [METRIC.PUFFS]: "puffs", [METRIC.SESSIONS]: "times",
  [METRIC.ACTIVE_CALORIES]: "kcal", [METRIC.SCREEN_MINUTES]: "minutes", [METRIC.AMOUNT]: "",
  [METRIC.APP_OPENS]: "opens",
};

export function openLogSheet(host, { state, habit, me, today, onSaved }) {
  const isSum = habit.aggregate === AGGREGATE.SUM;
  const scale = SCALE[habit.metric];
  const unit = scale ? scale.unit : (UNIT[habit.metric] || "");
  const key = periodKey(today, habit.period);
  const current = valueForPeriod(state, habit, me, key);
  const target = targetFor(state, habit, me, periodEnd(key, habit.period));

  // Adding starts at one thing; setting starts from where you already are, so a small correction
  // is a small edit rather than a retype.
  let amount = isSum ? 1 : (current == null ? "" : (scale ? scale.to(current) : current));
  let busy = false;
  let error = "";

  // A ceiling with nothing against it yet. "None" is the whole of what most people want to say
  // here, and it is the one thing the sheet used to throw away.
  //
  // Only while nothing is logged: once there is a number, "none" would mean UNDOING it, which is a
  // different action with different consequences and no home in this sheet yet.
  const canDeclareNone = habit.direction === AT_MOST && current == null;

  const sheet = openSheet(host);
  paint();

  function bump(by) {
    const n = Number(amount) || 0;
    const step = scale ? scale.step * by : by;
    amount = Math.max(0, Math.round((n + step) * 100) / 100);
    paint();
  }

  function paint() {
    sheet.paint(
      el("div.sheet-head",
        el("span.card-icon", habit.icon || "◆"),
        el("span.sheet-title", habit.name || "Habit"),
      ),

      el("p.sheet-now",
        current == null
          ? "Nothing logged " + (CADENCE[habit.period] || "today") + " yet."
          : (scale ? scale.to(current) : current) + " " + unit + " "
            + (CADENCE[habit.period] || "today") + " · "
            + (habit.direction === AT_MOST ? "limit " : "goal ")
            + (scale ? scale.to(target) : target),
      ),

      el("label.field",
        el("span.field-label", isSum ? "Add how many?" : "What's the total now?"),
        el("div.stepper",
          el("button.step", { onclick: () => bump(-1), "aria-label": "Less" }, "−"),
          el("input", {
            type: "number", min: "0", inputmode: "decimal",
            step: scale ? scale.step : 1,
            value: amount,
            oninput: (e) => { amount = e.target.value; },
          }),
          el("button.step", { onclick: () => bump(1), "aria-label": "More" }, "+"),
        ),
      ),
      unit ? el("p.note-inline", unit) : null,

      canDeclareNone
        ? el("button.tap.tap-quiet", { onclick: () => save(0), disabled: busy },
            "None " + (CADENCE[habit.period] || "today"))
        : null,

      error ? el("p.err", error) : null,

      el("div.sheet-actions",
        el("button.ghost", { onclick: () => sheet.close() }, "Cancel"),
        el("button.tap", { onclick: () => save(), disabled: busy },
          busy ? "Saving…" : isSum ? "Add it" : "Save"),
      ),
    );
  }

  /**
   * @param exact a value chosen by a button rather than typed, so the field is bypassed entirely.
   *              Passed positionally by "None today"; everything else calls save() with nothing.
   *              The wrapping arrow matters — handing `save` straight to onclick would make the
   *              click event the value.
   */
  async function save(exact) {
    if (busy) return;
    const n = exact != null ? exact : Number(amount);
    if (!Number.isFinite(n) || n < 0) { error = "Give it a number."; return paint(); }
    // Adding nothing to SOMETHING is just cancelling. Adding nothing to nothing is the day's
    // answer, and it has to be written down or the day reads as never reported.
    if (isSum && n === 0 && current != null) { sheet.close(); return; }

    busy = true; error = ""; paint();
    try {
      // Always against TODAY. For a weekly or monthly habit the period is derived from the day, so
      // this lands in the right week or month without the sheet having to know which.
      await logValue(habit.habitId, today, scale ? scale.from(n) : Math.round(n), "manual");
      sheet.close();
      onSaved();
    } catch (err) {
      error = "Couldn't save: " + (err && err.message ? err.message : err);
      busy = false;
      paint();
    }
  }
}
