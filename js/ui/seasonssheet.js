// seasonssheet.js — every season this group has run, and the way to start the next one.
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
// obvious home for "start another one", which is the thing you want the moment you have read the
// last one's final table.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { seasonHistory, seasonTally } from "../season.js";
import * as fmt from "./format.js";

export function openSeasonsSheet(host, { state, me, today, onNewSeason, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });

  const members = [...state.members.keys()];
  const seasons = seasonHistory(state, today);
  // Open on the one being played, or the most recent if none is. A group looking at this while a
  // season runs wants that one; a group between seasons wants the table they just finished.
  let openIndex = Math.max(0, seasons.findIndex((s) => s.current));

  /** The final table for one season, derived now rather than from a snapshot taken at the time. */
  function standings(season) {
    const { rows, weeks } = seasonTally(state, members, today, { from: season.from, to: season.to });
    if (!weeks) {
      return el("p.note-inline", season.pending
        ? "Starts " + fmt.dayLabel(season.from) + ". Nothing counted yet."
        : season.superseded
        ? "Replaced before a week of it finished, so there is nothing to tally."
        : "No week finished inside this season, so there is nothing to tally.");
    }
    return el("div.board", rows.map((r) => el(
      "article.row" + (r.memberId === me ? ".is-me" : "") + (r.rank === 1 ? ".is-crown" : ""),
      el("div.row-rank", String(r.rank)),
      el("div.row-main",
        el("div.row-name", r.memberId === me ? "You" : r.name),
        el("div.row-meta",
          r.crowns
            ? "👑 " + r.crowns + (r.crowns === 1 ? " week won" : " weeks won")
            : "no weeks won",
          " of " + weeks,
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
    const label = season.pending ? "Booked"
      : season.current ? "Running"
      : season.superseded ? "Replaced"
      : "Finished";
    return el("div.season-item" + (open ? ".is-open" : ""),
      el("button.season-item-head", {
        onclick: () => { openIndex = open ? -1 : i; paint(); },
        "aria-expanded": open ? "true" : "false",
      },
        el("span.season-item-n", "#" + season.index),
        el("span.season-item-dates",
          fmt.dayLabel(season.from),
          season.to ? " → " + fmt.dayLabel(season.to) : " → no end",
        ),
        el("span.season-item-tag" + (season.current ? ".is-live" : ""), label),
      ),
      open ? standings(season) : null,
    );
  }

  function paint() {
    sheet.paint(
      el("div.form",
        el("div.sheet-head", el("span.sheet-title", "Seasons")),

        seasons.length
          ? el("div.season-list", seasons.map(seasonRow))
          : el("p.sheet-now",
              "No season has been started yet. Until one is, the board counts everything since the "
              + "group's first habit."),

        // Always here, whatever state the current season is in — that is the whole point of moving
        // it. A booked season is replaced by starting another; there is nothing to cancel first.
        onNewSeason
          ? el("button.tap", { onclick: () => { sheet.close(); onNewSeason(); } },
              seasons.some((s) => s.current) ? "Start a new season" : "Start a season")
          : null,
        seasons.some((s) => s.pending)
          ? el("p.note-inline",
              "One is already booked. Starting another replaces it — nothing to cancel first.")
          : null,

        el("p.note-inline",
          "Standings are worked out from the log every time this opens, so a season read back "
          + "months later is scored by the same rules as the one running now."),
      ),
    );
  }

  paint();
}
