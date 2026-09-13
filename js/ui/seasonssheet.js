// seasonssheet.js — every season this group has run, how they run, and the way to change that.
//
// ---- Why the date range is a button ----
//
// The board showed one season: whichever the meta line points at. Everything before it was still in
// the log and completely unreachable — a group on their third season could not see who won either
// of the first two, and the standings they had played for were gone the moment the next one began.
//
// It is also where the only way to START a season had to move. That control was a text link at the
// foot of the All-time view, and it was replaced by a note whenever a season was booked but not yet
// running — so a group with a pending season had no entry point at all, on any screen, and the one
// thing they wanted to do was change their minds about it. Reported exactly that way: "I cannot
// start a new season while it says the current season is completed."
//
// So the strip on the board opens this, from both views, always. A list of seasons is also the
// obvious home for the rule that produces them: seasons now start on their own, on a day of the
// month the group chose, and the card at the top says which day, which season this is, and when
// the next begins. See season.js for why that is derived rather than fired.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { seasonHistory, seasonTally, seasonProgress, seasonSchedule } from "../season.js";
import * as fmt from "./format.js";

export function openSeasonsSheet(host, { state, me, today, onSchedule, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });

  const members = [...state.members.keys()];
  const seasons = seasonHistory(state, today);
  const where = seasonProgress(state, today);
  // The rule that STANDS, not the one today's season came from. On the evening a schedule is set
  // the running season is still the hand-started one, and a card reading "Started by hand" over a
  // sentence about the schedule reads as the schedule not having taken.
  const rule = seasonSchedule(state);
  // Open on the one being played, or the most recent if none is. A group looking at this while a
  // season runs wants that one; a group between seasons wants the table they just finished.
  let openIndex = Math.max(0, seasons.findIndex((s) => s.current));

  /** The final table for one season, derived now rather than from a snapshot taken at the time. */
  function standings(season) {
    const { rows, weeks, days } = seasonTally(state, members, today, { from: season.from, to: season.to });
    if (!days) {
      return el("p.note-inline", season.pending
        ? "Starts " + fmt.dayLabel(season.from) + ". Nothing counted yet."
        : season.superseded
        ? "Replaced before a day of it closed, so there is nothing to tally."
        : "No day has closed inside this season yet, so there is nothing to tally.");
    }
    return el("div.board", rows.map((r) => el(
      "article.row" + (r.memberId === me ? ".is-me" : "") + (r.rank === 1 ? ".is-crown" : ""),
      el("div.row-rank", String(r.rank)),
      el("div.row-main",
        el("div.row-name", r.memberId === me ? "You" : r.name),
        el("div.row-meta",
          // Days first: every season has them, and a six-day run-in has no week to have won.
          r.days + " of " + days + (days === 1 ? " day" : " days") + " played",
          weeks
            ? " · " + (r.crowns
              ? "👑 " + r.crowns + (r.crowns === 1 ? " week won" : " weeks won")
              : "no weeks won") + " of " + weeks
            : "",
          r.bonus ? " · " + r.bonus + " from bonus" : "",
        ),
      ),
      el("div.row-pct", String(r.points), el("span.row-unit", " " + fmt.XP)),
    )));
  }

  /** One row in the list: its dates, its state, and its table when it is the open one. */
  function seasonRow(season, i) {
    const open = i === openIndex;
    // "Replaced" rather than "Finished" for one cut short by the next season starting — finished
    // claims it ran its course, and a season somebody ended after a day did not.
    const label = season.pending ? "Next"
      : season.current ? "Running"
      : season.superseded ? "Replaced"
      : "Finished";
    const length = season.to ? fmt.daysBetweenISO(season.from, season.to) + 1 : null;
    return el("div.season-item" + (open ? ".is-open" : ""),
      el("button.season-item-head", {
        onclick: () => { openIndex = open ? -1 : i; paint(); },
        "aria-expanded": open ? "true" : "false",
      },
        el("span.season-item-n", "#" + season.index),
        el("span.season-item-dates",
          fmt.dayLabel(season.from),
          season.to ? " → " + fmt.dayLabel(season.to) : " → no end",
          // The length, so a short run-in reads as the short one it was meant to be rather than
          // as a month that went wrong.
          length ? el("span.season-item-len", length + (length === 1 ? " day" : " days")) : null,
        ),
        el("span.season-item-tag" + (season.current ? ".is-live" : ""), label),
      ),
      open ? standings(season) : null,
    );
  }

  /**
   * How seasons run, above the list of them. Under a schedule this is the whole answer to "when
   * is the next one" — the question that used to have no answer on any screen.
   */
  function scheduleCard() {
    if (!where || !where.index) return null;
    const live = seasons.find((s) => s.current);
    return el("div.season-rule",
      el("div.season-rule-k", rule
        ? "Every month from the " + fmt.ordinal(rule.every)
        : "Started by hand"),
      live && where.end
        ? el("div.season-rule-now",
            el("b", "Season " + where.index),
            " · " + fmt.dayLabel(where.start) + " → " + fmt.dayLabel(where.end)
            + " · " + fmt.seasonLeft(where))
        : where.ended
        ? el("div.season-rule-now", el("b", "Season " + where.index), " · " + fmt.seasonLeft(where))
        : el("div.season-rule-now", el("b", "Season " + where.index), " · no end"),
      el("div.season-rule-next", fmt.seasonNext(where)
        || (rule ? null : "Nothing follows this one until somebody starts it.")),
    );
  }

  function paint() {
    sheet.paint(
      el("div.form",
        el("div.sheet-head", el("span.sheet-title", "Seasons")),

        scheduleCard(),

        seasons.length
          ? el("div.season-list", seasons.map(seasonRow))
          : el("p.sheet-now",
              "No season has been started yet. Until one is, the board counts everything since the "
              + "group's first habit."),

        // Always here, whatever state the current season is in — that is the whole point of moving
        // it. One button: the schedule sheet also offers starting one by hand.
        onSchedule
          ? el("button.tap", { onclick: () => { sheet.close(); onSchedule(); } },
              rule ? "Change the schedule"
                : seasons.length ? "Put seasons on a schedule" : "Start seasons")
          : null,

        el("p.note-inline",
          "Standings are worked out from the log every time this opens, so a season read back "
          + "months later is scored by the same rules as the one running now."),
      ),
    );
  }

  paint();
}
