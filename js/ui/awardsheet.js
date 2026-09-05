// awardsheet.js — the case. Everything that can be won, and what has been.
//
// ---- Why every badge is drawn, including the ones nobody has ----
//
// A case that shows only what you have earned is a list, and a list of two things does not look
// like an achievement. Showing all twenty-odd with most of them dark does two jobs at once: it
// says what the ceiling is, which is the only way somebody knows a Diamond exists before they are
// anywhere near one, and it makes the earned ones read as taken from a set rather than as
// whatever happened to turn up.
//
// The locked ones keep their number. "60" under a dark disc is a target; a padlock is a shrug.
//
// ---- Why counts and not ticks ----
//
// Streaks break. Reaching twenty days, losing it and getting back to twenty is the hard thing done
// twice, and a tick would quietly say the first one did not happen. See awards.js.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { awards } from "../awards.js";
import { LEVEL_KEY, tierFor, nextTier } from "../milestones.js";

const UNIT = {
  day: ["day", "days"],
  week: ["week", "weeks"],
  month: ["month", "months"],
};
const runLabel = (n, period) => {
  const [one, many] = UNIT[period] || UNIT.day;
  return n + " " + (n === 1 ? one : many);
};

export function openAwardSheet(host, { state, me, today, streak }) {
  const sheet = openSheet(host);
  const { major, habits, earned } = awards(state, me, today);

  const held = tierFor(streak);
  const next = nextTier(streak);

  sheet.paint(
    // The tally lives up here rather than under the headline below it. Down there it read as a
    // contradiction — "No badge yet" directly above "2 badges won" — because the headline is about
    // the major standing and the count is about the whole case.
    el("div.sheet-head",
      el("span.sheet-title", "Achievements"),
      earned ? el("span.case-tally", earned === 1 ? "1 won" : earned + " won") : null,
    ),

    // What is true right now, before the case. Somebody opening this wants the headline first.
    el("div.case-now",
      held
        ? el("span.badge.badge-lg.badge-" + held.key, el("span.badge-n", String(streak)))
        : el("div.hero-mark", "·"),
      el("div.case-now-text",
        el("div.case-held", held ? held.name : "No badge yet"),
        el("div.case-sub",
          held
            ? "Held for " + runLabel(streak, "day")
              + (next ? " · " + next.away + " to " + next.tier.name : "")
            : next ? next.away + " days of every habit on goal to reach " + next.tier.name : "",
        ),
      ),
    ),

    earned === 0
      ? el("p.case-count", "Nothing won yet. Every badge below is still on the table.")
      : null,

    // ---- The four that the group hears about ----
    el("h2.sec-title", "Every habit, on goal"),
    el("div.case-major", major.map((t) => el("div.case-slot" + (t.times ? "" : ".is-locked"),
      el("span.badge.badge-" + t.key, { title: t.name + " — " + t.earned },
        el("span.badge-n", String(t.at))),
      el("span.case-name", t.name),
      // The count only when it is more than one. "x1" on everything turns a case into a receipt.
      t.times > 1 ? el("span.case-times", "×" + t.times) : null,
    ))),
    el("p.note-inline",
      "Won by meeting every category you were asked about, every day. The group is told when you "
      + "reach one."),

    // ---- The ones that are yours ----
    habits.length ? el("h2.sec-title", "One habit at a time") : null,
    habits.map((h) => el("div.case-habit",
      el("div.case-habit-head",
        el("span.case-habit-icon", h.icon),
        el("span.case-habit-name", h.name),
        el("span.case-habit-run", h.streak ? runLabel(h.streak, h.period) : "no run"),
      ),
      el("div.case-pips", h.levels.map((l) => el("div.case-slot" + (l.times ? "" : ".is-locked"),
        el("span.pip.pip-" + LEVEL_KEY[l.level], { title: runLabel(l.at, h.period) },
          String(l.at)),
        el("span.case-name", l.span),
        l.times > 1 ? el("span.case-times", "×" + l.times) : null,
      ))),
    )),
    habits.length
      ? el("p.note-inline", "Yours alone — these are never announced to the group.")
      : null,
  );

  return sheet;
}
