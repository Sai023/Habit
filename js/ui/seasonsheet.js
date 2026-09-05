// seasonsheet.js — when the new season should begin.
//
// ---- Why this is a choice and not a confirmation ----
//
// It used to be a yes/no on one fixed answer: next Monday. That is the right default and a bad only
// option. Monday exists so that week one is not half-played under the old rules — but somebody
// setting a season up for the first time wants to watch the machinery work, and waiting five days
// to find out whether a crown lands is not a test, it is a guess with a delay.
//
// Starting today is honest now rather than merely permitted: a season that begins mid-week is
// scored only on the days it was actually running, so week one no longer reaches back to the Monday
// and counts days from before the line. See weekStandings.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import * as fmt from "./format.js";

/**
 * Ask when, and resolve with the day to start from — or null if they backed out.
 *
 * Dismissing resolves null. Silence is never consent for something that clears a scoreboard.
 */
export function seasonSheet(host, { monday, today, weeks }) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };

    const sheet = openSheet(host, { onClose: () => finish(null) });

    const pick = (day) => { finish(day); sheet.close(); };

    sheet.paint(
      el("div.sheet-head", el("span.sheet-title", "Start a new season")),

      el("p.sheet-now",
        weeks > 0
          ? "Crowns, points and weeks won go back to zero for everybody. "
          : "The standings go back to zero for everybody. ",
        // Said plainly, because "reset" is a word people have learned to read as "lose everything",
        // and the whole point of this is that it only clears the scoreboard.
        "Nothing else changes — every habit, target, taper, logged number and streak stays exactly "
        + "as it is.",
      ),

      el("div.season-choice",
        // The app's own date wording. An ISO string here would be the only raw date on any
        // screen, on the one button that clears a scoreboard.
        el("button.tap", { onclick: () => pick(monday) }, "From " + fmt.dayLabel(monday)),
        el("p.note-inline",
          "The usual one. Week one starts clean, instead of being half-played under the old "
          + "standings."),
      ),

      el("div.season-choice",
        el("button.ghost", { onclick: () => pick(today) }, "Start today"),
        el("p.note-inline",
          "For trying it out. This week counts only from today, so the first crown lands on "
          + "Monday rather than a week on Monday."),
      ),

      el("div.sheet-actions",
        el("button.ghost", { onclick: () => { finish(null); sheet.close(); } }, "Keep the season"),
      ),
    );
  });
}
