// levelsheet.js — your level, explained; and the moment you reach the next one.
//
// One sheet, two moods. Opened from the header it is a reference: where you stand, what the next
// level asks, the ladder of titles, and the three rules in plain words. Opened by a level-up it is
// a moment: the new number large, the title, what it took — and then the same reference below, so
// the celebration is also the explanation.
//
// A level-up is noticed here rather than pushed from anywhere: the app remembers the last level
// it showed this person, and the first paint that finds a higher one opens the sheet once. Levels
// bank overnight (see levels.js), so this is a morning screen.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { lifetime, titleBand, TITLES, LEVEL_MAX, thresholdFor, gapTo } from "../levels.js";
import { levelMark } from "./levelmark.js";
import { factsAbout } from "../facts.js";
import * as fmt from "./format.js";

const SEEN_KEY = (memberId) => "level-seen:" + memberId;

/** The level last shown to this person on this device, or null the first time. */
export function seenLevel(memberId) {
  try {
    const raw = localStorage.getItem(SEEN_KEY(memberId));
    return raw == null ? null : Number(raw);
  } catch { return null; }
}
export function markSeen(memberId, level) {
  try { localStorage.setItem(SEEN_KEY(memberId), String(level)); } catch { /* unavailable */ }
}

/**
 * Should a paint open the celebration? Once per level, and never on the first sight of a level —
 * somebody installing the update at Level 7 gets Level 7 on the header, not seven fanfares.
 */
export function levelUpDue(memberId, level) {
  const seen = seenLevel(memberId);
  if (seen == null) { markSeen(memberId, level); return false; }
  return level > seen;
}

/**
 * The title band: one pip per level from where this title began to where the next begins, with
 * the level you are ON lit. Answers "is the end of the bar the next title?" — no, and here is
 * where you stand on the way to it.
 */
function bandPips(life) {
  const band = titleBand(life.level);
  if (!band.nextAt) return el("p.lv-band-note", "Legend. The last title there is.");
  const pips = [];
  for (let l = band.from; l <= band.nextAt; l += 1) {
    pips.push(el("i.lv-pip" + (l === life.level ? ".is-lit" : "") + (l === band.nextAt ? ".is-next" : ""),
      { title: "Level " + l + (l === band.nextAt ? " · " + band.nextName : "") }));
  }
  return el("div.lv-band",
    el("div.lv-pips", pips),
    el("p.lv-band-note", band.nextName + " at Level " + band.nextAt + " · "
      + (band.nextAt - life.level) + (band.nextAt - life.level === 1 ? " level" : " levels") + " away"),
  );
}

/** The facts, as rows: an icon, a title, a sentence. */
function factsList(facts) {
  if (!facts.length) return el("p.note-inline", "A few more days and there will be things to say.");
  return el("div.lv-facts", facts.map((f) => el("div.lv-fact",
    el("span.lv-fact-i", f.icon),
    el("div.lv-fact-body",
      el("span.lv-fact-t", f.title),
      el("span.lv-fact-x", f.text),
    ),
  )));
}

export function openLevelSheet(host, { state, me, today, celebrate = false, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });
  const life = lifetime(state, me, today);
  const name = (state.members.get(me) || {}).name || "You";
  markSeen(me, life.level);

  const n = (x) => x.toLocaleString();
  const paceDays = life.days ? life.banked / life.days : 0;
  const eta = life.max || paceDays <= 0 ? null : Math.ceil(life.need / paceDays);

  sheet.paint(
    el("div.form.lv",
      celebrate
        ? el("div.lv-moment",
            levelMark(life, 96),
            el("p.lv-moment-k", "Level up"),
            el("h1.lv-moment-title", life.title),
            el("p.lv-moment-sub", name + " reached Level " + life.level + " · " + n(life.banked) + " " + fmt.XP
              + " over " + life.days + " days"),
          )
        : el("div.sheet-head",
            el("span.sheet-title", name + " · Level " + life.level),
            levelMark(life, 40, { tip: life.span ? (life.today / life.span) * 100 : 0 }),
          ),

      // Where you stand, stated as a sentence and drawn as a bar.
      el("div.lv-standing",
        el("div.lv-row",
          el("span.lv-title", life.title),
          el("span.lv-xp", n(life.banked) + " " + fmt.XP + " lifetime"),
        ),
        // This level, from where it began to where the next starts. Starts again at every level;
        // the lifetime total has its own tile below.
        el("div.lv-bar",
          el("i.lv-bar-fill", { style: "width:" + life.pct + "%" }),
          life.today && life.span
            ? el("i.lv-bar-tip", { style: "left:" + life.pct + "%; width:" + Math.min(100 - life.pct, (life.today / life.span) * 100) + "%" })
            : null,
        ),
        el("div.lv-ends",
          el("span", "Level " + life.level + " · " + n(life.at)),
          life.max ? el("span", "the top") : el("span", "Level " + (life.level + 1) + " · " + n(life.next)),
        ),
        bandPips(life),
        el("p.lv-need", life.max
          ? "The top. There is nothing above Level " + LEVEL_MAX + "."
          : n(life.need) + " " + fmt.XP + " to Level " + (life.level + 1)
            + (eta ? " · about " + eta + (eta === 1 ? " day" : " days") + " at your pace" : "")),
        life.today
          ? el("p.note-inline", "+" + life.today + " " + fmt.XP + " today so far — banks at midnight"
              + (life.levelUpToday ? ", and that is Level " + (life.level + 1) + "." : "."))
          : null,
      ),

      // The total, as the number it is. The bar above starts again at every level, so this is
      // where "how much have I earned, ever" lives — beside the days it took and the rate.
      el("div.lv-stats",
        el("div.lv-stat", el("b", n(life.banked)), el("span", fmt.XP + " lifetime")),
        el("div.lv-stat", el("b", n(life.days)), el("span", life.days === 1 ? "day played" : "days played")),
        el("div.lv-stat", el("b", life.days ? String(Math.round(life.banked / life.days)) : "—"), el("span", fmt.XP + " a day")),
      ),

      el("h2.sec-title", "About you"),
      factsList(factsAbout(state, me, today)),

      el("h2.sec-title", "How it works"),
      el("div.lv-rules",
        el("p", el("b", "Every day you play adds its " + fmt.XP + "."), " The same 0–100 the board scores, plus what beating your goals earned. Nothing extra to chase; nothing to lose."),
        el("p", el("b", "It only goes up."), " A bad week costs nothing you have already earned, and a level once reached is never lost."),
        el("p", el("b", "Days bank when they close."), " Today shows as the faint tip on the bar until midnight, so a level reached at six cannot be un-reached at eleven."),
        el("p", el("b", "Each level asks a little more than the last"), " — " + n(gapTo(2)) + " for Level 2, " + n(gapTo(life.level + 1 <= LEVEL_MAX ? life.level + 1 : LEVEL_MAX)) + " for your next, " + n(gapTo(LEVEL_MAX)) + " for the hundredth."),
        el("p", el("b", "It is yours, not a race."), " Levels rank nobody. The week and the season are the league; this is how far you have come."),
      ),

      el("h2.sec-title", "Titles"),
      el("div.lv-ladder", TITLES.map(([lvl, title]) => el("div.lv-rung"
        + (life.level >= lvl ? ".is-reached" : "") + (title === life.title ? ".is-current" : ""),
        el("span.lv-rung-l", "Lv " + lvl),
        el("span.lv-rung-t", title),
        el("span.lv-rung-xp", n(thresholdFor(lvl)) + " " + fmt.XP),
      ))),

      el("div.sheet-actions",
        el("button.tap.tap-quiet", { onclick: () => sheet.close() }, celebrate ? "Onwards" : "Close"),
      ),
    ),
  );
  return sheet;
}
