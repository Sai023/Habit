// seasonsheet.js — when the new season begins, and how long it runs.
//
// ---- Why this is a form and not a confirmation ----
//
// It began as a yes/no on one fixed answer: next Monday, for ever. Both halves of that were a
// decision made on somebody's behalf. Monday is the right default and a bad only option — a group
// setting this up for the first time wants to watch the machinery work, and waiting five days to
// find out whether a crown lands is a guess with a delay rather than a test. And "for ever" is the
// wrong default for a thing called a season: without an end there is nothing to count down to and
// no such thing as season two.
//
// Starting mid-week is honest rather than merely permitted, because a partial first week is now
// scored only on the days the season was actually running — see weekStandings.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import * as fmt from "./format.js";

/**
 * Lengths worth offering, in whole ISO weeks.
 *
 * A week is the unit the scoreboard is built on, so a season measured in days would end mid-week
 * and finish on a week nobody could win. One week exists for exactly one purpose: trying this out
 * over a weekend rather than over a quarter.
 */
const LENGTHS = [
  { weeks: 1, label: "1 week", note: "A trial run." },
  { weeks: 4, label: "4 weeks", note: "A month." },
  { weeks: 8, label: "8 weeks", note: "Two months." },
  { weeks: 12, label: "12 weeks", note: "A quarter." },
  { weeks: null, label: "No end", note: "Runs until somebody starts the next one." },
];

/**
 * Ask when and how long. Resolves { from, weeks } — or null if they backed out.
 *
 * Dismissing resolves null. Silence is never consent for something that clears a scoreboard.
 */
export function seasonSheet(host, { monday, today, weeks: playedWeeks }) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };

    const sheet = openSheet(host, { onClose: () => finish(null) });

    // Monday and a quarter: the answer a group settling in for the long run wants, so it is the one
    // already selected. The trial run is a deliberate choice rather than the path of least effort.
    const form = { from: monday, weeks: 12 };

    /** The last day, worked out the same way the engine does — see seasonEnd. */
    function endsOn() {
      if (!form.weeks) return null;
      const mondayOfStart = fmt.mondayOf(form.from);
      return fmt.addDaysISO(mondayOfStart, form.weeks * 7 - 1);
    }

    function paint() {
      const end = endsOn();
      sheet.paint(
        el("div.sheet-head", el("span.sheet-title", "Start a new season")),

        el("p.sheet-now",
          playedWeeks > 0
            ? "Crowns, points and weeks won go back to zero for everybody. "
            : "The standings go back to zero for everybody. ",
          // Said plainly, because "reset" is a word people have learned to read as "lose
          // everything", and the whole point of this is that it only clears the scoreboard.
          "Nothing else changes — every habit, target, taper, logged number and streak stays "
          + "exactly as it is.",
        ),

        el("h2.sec-title", "Starts"),
        // One chip when both answers are the same day. On a Monday the next week boundary IS today,
        // and offering "Mon, 7 Sept" beside "Today" is two buttons that do the same thing — which
        // reads as a choice somebody is failing to understand rather than as no choice at all.
        el("div.chips",
          monday === today
            ? el("button.chip.on", { disabled: true }, "Today — " + fmt.dayLabel(today))
            : [
              el("button.chip" + (form.from === monday ? ".on" : ""), {
                onclick: () => { form.from = monday; paint(); },
              }, fmt.dayLabel(monday)),
              el("button.chip" + (form.from === today ? ".on" : ""), {
                onclick: () => { form.from = today; paint(); },
              }, "Today"),
            ],
        ),
        el("p.note-inline", monday === today
          ? "Today is a Monday, so week one starts clean either way."
          : form.from === monday
            ? "Week one starts clean, instead of being half-played under the old standings."
            : "This week counts only from today, so the first crown lands on the coming Monday."),

        el("h2.sec-title", "Runs for"),
        el("div.chips", LENGTHS.map((l) => el("button.chip" + (form.weeks === l.weeks ? ".on" : ""), {
          onclick: () => { form.weeks = l.weeks; paint(); },
        }, l.label))),
        el("p.note-inline", LENGTHS.find((l) => l.weeks === form.weeks).note),

        // The dates, spelled out. A length in weeks is a number somebody has to convert before
        // they know what they are agreeing to; this is that conversion, done for them, before
        // rather than after.
        el("div.season-dates",
          el("span", fmt.dayLabel(form.from)),
          el("span.season-arrow", "→"),
          el("span", end ? fmt.dayLabel(end) : "no end"),
        ),

        el("div.sheet-actions",
          el("button.ghost", { onclick: () => { finish(null); sheet.close(); } }, "Cancel"),
          el("button.tap", {
            onclick: () => { finish({ from: form.from, weeks: form.weeks }); sheet.close(); },
          }, "Start it"),
        ),
      );
    }

    paint();
  });
}
