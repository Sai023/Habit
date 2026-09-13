// weeksheet.js — one person's week, itemised.
//
// The board row says where somebody stands and, in a line, why. This is the line opened up: the
// seven days as bars, so a bad Tuesday is visible as a Tuesday; then every habit as "6 of 7 days"
// in its own cadence, so "13 of 22 goals met" — which was five habits over several days added
// into one number nobody could reconstruct — becomes five sentences anybody can.
//
// Nothing here is computed twice. The row already carries the days (from scoreOver) and the
// per-habit bookkeeping (from leaderboard); this draws them.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { addDays, isoDayOfWeek } from "../habits.js";
import { PERIOD } from "../schema.js";
import { CATEGORY_ORDER, CATEGORY_SHORT, CATEGORY_ICON } from "../score.js";
import { categoryBreakdown } from "../season.js";
import * as fmt from "./format.js";

const DAY = ["M", "T", "W", "T", "F", "S", "S"];

/** "6 of 7 days", "2 of 3 this week", "met this month" — the count in the habit's own cadence. */
function metLine(h) {
  const unit = h.period === PERIOD.WEEK ? "week" : h.period === PERIOD.MONTH ? "month" : "day";
  if (h.period === PERIOD.DAY) {
    return h.eligible ? h.hits + " of " + h.eligible + (h.eligible === 1 ? " day" : " days") : null;
  }
  // A weekly or monthly habit is one period on a week's board: the one that is still open.
  if (h.eligible) return h.hits ? "met this " + unit : "missed this " + unit;
  return null;
}

export function openWeekSheet(host, { row, ctx, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });
  const me = row.memberId === ctx.me;
  const name = me ? "You" : row.name;
  const monday = addDays(ctx.today, -(isoDayOfWeek(ctx.today) - 1));
  const daysSoFar = isoDayOfWeek(ctx.today);
  const byDay = new Map((row.daily || []).map((d) => [d.day, d]));

  // The seven days. A bar for each that has happened; today lit; a day with no score at all is
  // an empty slot with its letter, which is the honest drawing of "nothing came through".
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(monday, i);
    const d = byDay.get(day);
    const future = day > ctx.today;
    const xp = d && d.scored ? d.pct + d.bonus : null;
    days.push(el("div.wk-day" + (day === ctx.today ? ".is-today" : "") + (future ? ".is-future" : "") + (xp == null && !future ? ".is-quiet" : ""),
      el("div.wk-bar", el("i", { style: "height:" + (xp == null ? 0 : Math.min(100, (xp / 115) * 100)) + "%" })),
      el("span.wk-n", future ? "" : xp == null ? "—" : String(xp)),
      el("span.wk-l", DAY[i]),
    ));
  }

  const parts = categoryBreakdown(ctx.state, row.memberId, monday, ctx.today);

  sheet.paint(
    el("div.form.wk",
      el("div.sheet-head",
        el("span.sheet-title", me ? "Your week" : name + "’s week"),
      ),
      el("p.sheet-now",
        "#" + row.rank + " this week · " + row.points + " " + fmt.XP
        + (row.bonusPoints ? " +" + row.bonusPoints + " bonus" : "")
        + (row.pct != null ? " · " + row.pct + " a day" : ""),
      ),

      el("h2.sec-title", "Day by day"),
      el("div.wk-days", days),
      el("p.note-inline", "Each day is worth 100 " + fmt.XP + ", plus up to 15 for beating your goals. "
        + "A dash is a day nothing was reported: it earned nothing and cost nothing."),

      el("h2.sec-title", "Each habit"),
      el("div.wk-habits", (row.perHabit || []).map((h) => {
        const met = metLine(h);
        const bits = [];
        if (met) bits.push(met);
        if (h.open != null && h.period !== PERIOD.DAY) {
          const unit = h.period === PERIOD.WEEK ? "week" : "month";
          bits.push(h.open >= 1 ? "done this " + unit : Math.round(h.open * 100) + "% of the way this " + unit);
        }
        if (h.quiet) bits.push(el("span.wk-quiet", h.quiet + (h.quiet === 1 ? " day" : " days") + " not reported"));
        if (h.streak >= 2) bits.push("\u{1F525} " + h.streak + " in a row");
        if (h.spent) bits.push("\u{1F6E1} " + h.spent + (h.spent === 1 ? " token" : " tokens") + " used");
        const full = h.period === PERIOD.DAY ? h.eligible && h.hits === h.eligible && !h.quiet : h.hits > 0 || (h.open != null && h.open >= 1);
        const poor = h.period === PERIOD.DAY ? h.eligible && h.hits / h.eligible < 0.5 : false;
        return el("div.wk-habit" + (full ? ".is-full" : "") + (poor ? ".is-low" : ""),
          el("span.wk-habit-i", h.icon || "◆"),
          el("div.wk-habit-body",
            el("span.wk-habit-n", h.name),
            el("span.wk-habit-s", ...bits.flatMap((b, i) => (i ? [" · ", b] : [b]))),
          ),
        );
      })),

      el("h2.sec-title", "By category"),
      el("div.wk-cats", CATEGORY_ORDER.filter((c) => parts.some((p) => p.category === c)).map((c) => {
        const p = parts.find((x) => x.category === c);
        return el("div.wk-cat",
          el("span.wk-cat-n", CATEGORY_ICON[c] + " " + CATEGORY_SHORT[c]),
          el("div.wk-cat-bar", el("i", { style: "width:" + (p.judged ? p.pct : 0) + "%" })),
          el("span.wk-cat-v", p.judged ? p.pct + "%" : "not judged yet"),
        );
      })),
      el("p.note-inline", "How each of the four went, as a percentage of what it could have earned. "
        + "The " + fmt.XP + " above is what they added up to, out of " + (100 * daysSoFar) + " so far this week."),

      me && row.noData
        ? el("p.note-inline", "Days not reported earn nothing. If your watch or phone should have reported, the sync note on Today says what it read.")
        : null,

      el("div.sheet-actions",
        el("button.tap.tap-quiet", { onclick: () => sheet.close() }, "Close"),
      ),
    ),
  );
  return sheet;
}
