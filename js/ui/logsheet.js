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
import { logValue, clearManual } from "../store.js";
import {
  valueForPeriod, targetFor, periodKey, periodEnd, manualOn, sourceFor, keptByHandAllWeek,
  addDays, isoDayOfWeek,
} from "../habits.js";
import * as fmt from "./format.js";
import { AGGREGATE, AT_MOST, AUTOMATIC_SOURCES, METRIC, PERIOD, SOURCE } from "../schema.js";

const CADENCE = { [PERIOD.DAY]: "today", [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };

/**
 * What is underneath a number you typed, named for a sentence rather than for a badge.
 *
 * fmt.source labels these "auto", "on this phone", "estimated" — right on a card where the icon
 * carries the meaning, and unreadable inside "the day goes back to whatever auto reported".
 */
const UNDERNEATH = {
  [SOURCE.HEALTH_CONNECT]: "your watch",
  [SOURCE.PAUSE]: "this phone",
  [SOURCE.PHONE]: "the phone's estimate",
  [SOURCE.STRAVA]: "Strava",
};

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
  const src = sourceFor(state, habit, me);
  const automatic = AUTOMATIC_SOURCES.has(src);
  const underneath = UNDERNEATH[src] || "the sensor";

  // ---- The day this sheet writes to ----
  //
  // Today, always — with one quiet exception. A steps habit kept by hand (no watch) can be
  // entered for an earlier day of the same week, because a person without a sensor has only the
  // evening they remember, and a missed evening was a missed day for good. The engine allows
  // exactly that and nothing wider (see withinBackfill in habits.js); this sheet offers it only
  // where it applies, and only to somebody who holds the habit's name for a moment. It is not
  // advertised: the door exists for the person it was cut for, and a control that said "earlier
  // days" would be read as an invitation by everybody else.
  const allWeek = keptByHandAllWeek(state, habit, me);
  let day = today;
  let pickingDay = false;

  let amount;
  let busy = false;
  let error = "";
  let current, target, typed, canDeclareNone;

  /** Everything the sheet says depends on which day it is about. */
  function aim(d) {
    day = d;
    const key = periodKey(day, habit.period);
    current = valueForPeriod(state, habit, me, key);
    target = targetFor(state, habit, me, periodEnd(key, habit.period));
    // Adding starts at one thing; setting starts from where you already are, so a small
    // correction is a small edit rather than a retype.
    amount = isSum ? 1 : (current == null ? "" : (scale ? scale.to(current) : current));
    // A ceiling with nothing against it yet. "None" is the whole of what most people want to say
    // here, and it is the one thing the sheet used to throw away. Only while nothing is logged:
    // once there is a number, "none" would mean undoing it, which is the separate action below.
    canDeclareNone = habit.direction === AT_MOST && current == null;
    // What you typed for THIS day, if anything, and what the day would say without it.
    typed = manualOn(state, habit, me, day);
  }
  aim(today);

  /** "today", or the day's own name once it is not today. */
  const when = () => (day === today ? (CADENCE[habit.period] || "today") : "on " + fmt.dayLabel(day).split(",")[0]);

  // The days of this week up to today, for the picker.
  const weekDays = [];
  if (allWeek) {
    for (let d = addDays(today, -(isoDayOfWeek(today) - 1)); d <= today; d = addDays(d, 1)) weekDays.push(d);
  }
  let holdTimer = null;
  const holdStart = () => {
    if (!allWeek || weekDays.length < 2) return;
    holdTimer = setTimeout(() => { pickingDay = true; paint(); }, 600);
  };
  const holdEnd = () => { clearTimeout(holdTimer); holdTimer = null; };

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
        el("span.sheet-title", {
          // Held, not tapped. See the note by `allWeek`.
          onpointerdown: holdStart, onpointerup: holdEnd, onpointerleave: holdEnd, onpointercancel: holdEnd,
          oncontextmenu: (e) => { if (allWeek) e.preventDefault(); },
        }, habit.name || "Habit"),
      ),

      // The days of the week, once asked for. Today is last and lit; earlier days are the ones
      // this exists for. Choosing one re-aims the whole sheet at it.
      pickingDay
        ? el("div.log-days", weekDays.map((d) => el("button.log-day" + (d === day ? ".is-on" : ""), {
            onclick: () => { aim(d); paint(); },
            "aria-pressed": d === day ? "true" : "false",
          }, d === today ? "Today" : fmt.dayLabel(d).split(",")[0])))
        : null,

      el("p.sheet-now",
        current == null
          ? "Nothing logged " + when() + " yet."
          : (scale ? scale.to(current) : current) + " " + unit + " "
            + when() + " · "
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
            "None " + when())
        : null,

      // Take back what you typed.
      //
      // Two things made this necessary and neither is obvious from inside the sheet. A number you
      // type overrules every sensor for its day, permanently — which is right when a watch has
      // over-counted and wrong ten minutes later when the watch has caught up and is correct. And
      // on a habit that ADDS, nothing you type can ever bring a total down, so a mistyped 30 was
      // there for good.
      //
      // Named with the number, because "Remove entry" does not tell you what you are about to
      // lose, and this is the one control here that destroys something.
      typed != null
        ? el("button.link.danger",
            { onclick: () => undo(), disabled: busy },
            "Remove the " + (scale ? scale.to(typed) : typed) + " you entered " + when())
        : null,
      // What the day will say afterwards, before it says it.
      //
      // The two outcomes are nothing alike and only one of them is what anybody pictures. On an
      // automatic habit the watch's own reading is underneath and takes back over. On one you keep
      // by hand there is nothing underneath, and a day with no entry is a MISS — which is a rule
      // this app applies on purpose and a surprise to meet by accident, through a button you
      // pressed to fix something.
      typed != null
        ? el("p.note-inline", automatic
            ? "The day goes back to whatever " + underneath + " reported."
            : "That leaves nothing logged " + when() + ", which counts as a miss until you enter "
              + "something.")
        : null,

      error ? el("p.err", error) : null,

      el("div.sheet-actions",
        el("button.ghost", { onclick: () => sheet.close() }, "Cancel"),
        el("button.tap", { onclick: () => save(), disabled: busy },
          busy ? "Saving…" : isSum ? "Add it" : day === today ? "Save" : "Save for " + fmt.dayLabel(day).split(",")[0]),
      ),
    );
  }

  /**
   * @param exact a value chosen by a button rather than typed, so the field is bypassed entirely.
   *              Passed positionally by "None today"; everything else calls save() with nothing.
   *              The wrapping arrow matters — handing `save` straight to onclick would make the
   *              click event the value.
   */
  /**
   * Withdraw today's typed number and close.
   *
   * Appends a withdrawal rather than deleting — the log only appends, on three phones and a
   * server. What the day says afterwards is whatever is underneath: the sensor's own reading on an
   * automatic habit, or nothing at all on one you keep by hand, which is an unreported day and is
   * scored as one. The note beside the button says which of those it will be, because they are
   * nothing alike and only one of them is what anybody pictures.
   */
  async function undo() {
    if (busy) return;
    busy = true; error = ""; paint();
    try {
      await clearManual(habit.habitId, day);
      sheet.close();
      onSaved();
    } catch (err) {
      error = "Couldn't remove it: " + (err && err.message ? err.message : err);
      busy = false;
      paint();
    }
  }

  async function save(exact) {
    if (busy) return;
    const n = exact != null ? exact : Number(amount);
    if (!Number.isFinite(n) || n < 0) { error = "Give it a number."; return paint(); }
    // Adding nothing to SOMETHING is just cancelling. Adding nothing to nothing is the day's
    // answer, and it has to be written down or the day reads as never reported.
    if (isSum && n === 0 && current != null) { sheet.close(); return; }

    busy = true; error = ""; paint();
    try {
      // Against the day the sheet is aimed at — today, unless the week picker above was used. For
      // a weekly or monthly habit the period is derived from the day, so this lands in the right
      // week or month without the sheet having to know which.
      await logValue(habit.habitId, day, scale ? scale.from(n) : Math.round(n), "manual");
      sheet.close();
      onSaved();
    } catch (err) {
      error = "Couldn't save: " + (err && err.message ? err.message : err);
      busy = false;
      paint();
    }
  }
}
