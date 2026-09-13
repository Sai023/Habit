// schedulesheet.js — how seasons run from now on.
//
// ---- Why a schedule and not a button ----
//
// Every season used to be started by hand. That is one tap, and it is one tap that has to happen
// on the right morning by somebody who remembers — and the first time nobody did, the board sat on
// "Season over" for as long as it took someone to notice. A contest that only continues when its
// keenest member intervenes is a contest with a single point of failure, and it is always the same
// person.
//
// So this asks for a rule rather than a date: a new season on the same day every month, on its own.
// The engine derives every season from that one line (see season.js), which is why nothing here
// has to be remembered, scheduled or synced at midnight. Starting one by hand is still possible —
// it is the last link on this sheet — and doing so ends the schedule, which the sheet says.
//
// ---- The run-in ----
//
// A schedule that begins between cycle days produces one short season first, to reach the next
// cycle day. That is a feature rather than an awkwardness — it is how a group whose season ends on
// a Sunday gets to "every 20th" without a week of nothing — but it is also exactly the kind of
// thing that looks like a bug on a board. So the sheet spells it out, with dates, before the button.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { nextCycleDay, CYCLE_DAY_MIN, CYCLE_DAY_MAX } from "../season.js";
import * as fmt from "./format.js";

/**
 * Ask which day of the month, and when to begin. Resolves { from, day } — or { byHand: true } to
 * fall through to the old form — or null if they backed out.
 *
 * `after` is the day after the running season ends, when it has an end that is today or later:
 * the natural first day of the schedule for a group that wants to finish what it is playing.
 * `every` is the schedule already in force, if any, so changing it starts from its own day.
 */
export function scheduleSheet(host, { today, after, every, running }) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };

    const sheet = openSheet(host, { onClose: () => finish(null) });

    // The 20th is what the first group asked for and a reasonable middle of the month; an existing
    // schedule's own day when there is one, because "change the schedule" mostly means "move the
    // start", not "start over".
    const form = {
      day: every || 20,
      // After the season being played, when it has an end; otherwise today. Tomorrow's season is
      // easier to explain than a season that began this morning under different rules.
      from: after || today,
    };

    /** The first two seasons the rule would produce, dated, so nobody has to do the arithmetic. */
    function preview() {
      const first = nextCycleDay(form.from, form.day);
      const out = [{ from: form.from, to: fmt.addDaysISO(first, -1) }];
      const second = nextCycleDay(first, form.day);
      out.push({ from: first, to: fmt.addDaysISO(second, -1) });
      return out;
    }

    function paint() {
      const [runIn, month] = preview();
      const short = runIn.from.slice(8) !== String(form.day).padStart(2, "0");
      const starts = [];
      if (after && after !== today) {
        starts.push([after, running ? "When this season ends" : "After this one"]);
      }
      starts.push([today, "Today"]);
      // The next cycle day itself, for a group that would rather wait than play a short one.
      const onDay = nextCycleDay(fmt.addDaysISO(today, -1), form.day);
      if (!starts.some(([d]) => d === onDay)) starts.push([onDay, "On the " + fmt.ordinal(form.day)]);

      sheet.paint(
        el("div.sheet-head", el("span.sheet-title", every ? "Change the schedule" : "Seasons on a schedule")),

        el("p.sheet-now",
          "A new season starts on the same day every month, on its own — nobody has to press "
          + "anything. Standings reset that morning. Nothing else changes: every habit, target, "
          + "taper, logged number and streak stays exactly as it is."),

        el("h2.sec-title", "Every month, from the"),
        el("div.chips.chips-days.chips-cal",
          Array.from({ length: CYCLE_DAY_MAX - CYCLE_DAY_MIN + 1 }, (_, i) => CYCLE_DAY_MIN + i)
            .map((d) => el("button.chip.chip-day" + (form.day === d ? ".on" : ""), {
              onclick: () => { form.day = d; if (!starts.some(([x]) => x === form.from)) form.from = today; paint(); },
              "aria-label": fmt.ordinal(d) + " of the month",
            }, String(d)))),
        el("p.note-inline",
          "The 29th, 30th and 31st are left out: not every month has them."),

        el("h2.sec-title", "Starting"),
        el("div.chips", starts.map(([d, label]) => el("button.chip" + (form.from === d ? ".on" : ""), {
          onclick: () => { form.from = d; paint(); },
        }, label + " — " + fmt.dayLabel(d)))),

        // The dates, spelled out. A rule is a thing somebody has to run in their head before they
        // know what they are agreeing to; this is that run, done for them, before rather than after.
        el("div.season-plan",
          el("div.season-dates",
            el("span.season-plan-k", short ? "First, a short one" : "First"),
            el("span", fmt.dayLabel(runIn.from)),
            el("span.season-arrow", "→"),
            el("span", fmt.dayLabel(runIn.to)),
            el("span.season-plan-n", (fmt.daysBetweenISO(runIn.from, runIn.to) + 1) + " days"),
          ),
          el("div.season-dates",
            el("span.season-plan-k", "Then every month"),
            el("span", fmt.dayLabel(month.from)),
            el("span.season-arrow", "→"),
            el("span", fmt.dayLabel(month.to)),
            el("span.season-plan-n", (fmt.daysBetweenISO(month.from, month.to) + 1) + " days"),
          ),
        ),
        short
          ? el("p.note-inline",
              "The first season is short, to reach the " + fmt.ordinal(form.day) + ". Every day of "
              + "it counts for " + fmt.XP + "; only whole weeks, Monday to Sunday, can be won.")
          : el("p.note-inline",
              "Every day counts for " + fmt.XP + ". Only whole weeks, Monday to Sunday, can be won."),

        el("div.sheet-actions",
          el("button.ghost", { onclick: () => { finish(null); sheet.close(); } }, "Cancel"),
          el("button.tap", {
            onclick: () => { finish({ from: form.from, day: form.day }); sheet.close(); },
          }, every ? "Change it" : "Set the schedule"),
        ),

        // The escape hatch, and what it costs. Not a chip beside the schedule: it is the thing
        // this sheet exists to replace, and it should read as the exception it is.
        el("button.link.sec-note", {
          onclick: () => { finish({ byHand: true }); sheet.close(); },
        }, every
          ? "Start one by hand instead — which ends the schedule →"
          : "Start one by hand instead →"),
      );
    }

    paint();
  });
}
