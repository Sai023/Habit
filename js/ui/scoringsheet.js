// scoringsheet.js — how the game works, on one screen.
//
// ---- Why this exists ----
//
// Reported as: "there are lots of numbers, 29 of 47 is not easily understandable, it comes across
// convoluted." Every one of those numbers is correct and most of them are explained somewhere —
// in a note under the thing, in a comment in the source, in a sentence that appears only when a
// particular condition is met. What was missing is the one place that says the whole rule once,
// so the numbers stop being separate puzzles.
//
// ---- The thing that actually confuses people ----
//
// 47. Core fitness is worth 40, and the screen says "of 47", and nothing on it is wrong. A
// category with nothing to judge hands its points to the others, so on a day when Savings has not
// closed, the remaining three share its 15. That rule is good — it is what stops somebody running
// two categories being scored out of 55 — and it is invisible, because all anybody sees is a
// weight that moved.
//
// So this screen explains the rule AND shows what it did to the reader's own day, with their real
// numbers. An abstract rule plus today's actual arithmetic is the difference between reading an
// explanation and recognising one.
//
// ---- Why it is short ----
//
// Because the complaint was that there is too much to take in. Six answers, in the order somebody
// actually asks them, and nothing about grace tokens or taper — those have their own screens and
// putting them here would recreate the problem in a new place.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import {
  dayScore, CATEGORY_WEIGHT, CATEGORY_LABEL, CATEGORY_ICON, CATEGORY_ORDER, BONUS_CAP,
} from "../score.js";
import { TAPER_MISS_LIMIT } from "../habits.js";

/** Joins names the way a person would say them. */
function nameList(names) {
  if (names.length <= 1) return names[0] || "";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

export function openScoringSheet(host, { state, me, today, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });

  // Their own day, so the example is theirs. Falls back to the plain rule if there is nothing to
  // score yet — a worked example with no numbers in it is worse than no worked example.
  const scored = (() => {
    try { return dayScore(state, me, today); } catch { return null; }
  })();
  const cats = (scored && scored.categories) || [];
  const quiet = cats.filter((c) => !c.eligible || c.share <= 0);
  const live = cats.filter((c) => c.eligible && c.share > 0);
  // The one that visibly grew, which is the number that prompted all this.
  const grown = live.find((c) => Math.round(c.share) > CATEGORY_WEIGHT[c.category]);

  const total = CATEGORY_ORDER.reduce((sum, c) => sum + CATEGORY_WEIGHT[c], 0);

  sheet.paint(
    el("div.form.scoring",
      el("div.sheet-head", el("span.sheet-title", "How scoring works")),

      // ---- 1. the anchor -------------------------------------------------
      el("h2.sec-title", "A day is worth 100"),
      el("p.scoring-line",
        "Every day, for everybody. What changes is how those hundred are split."),

      el("div.scoring-split", CATEGORY_ORDER.map((c) => el("i.scoring-seg.seg-" + c, {
        style: "flex:" + CATEGORY_WEIGHT[c],
        title: CATEGORY_LABEL[c] + " " + CATEGORY_WEIGHT[c],
      }))),
      el("div.scoring-keys", CATEGORY_ORDER.map((c) => el("span.scoring-key",
        el("i.scoring-dot.seg-" + c),
        CATEGORY_ICON[c] + " " + CATEGORY_LABEL[c],
        el("b", " " + CATEGORY_WEIGHT[c]),
      ))),

      // ---- 2. inside a category ------------------------------------------
      el("h2.sec-title", "Habits share their category"),
      el("p.scoring-line",
        "Two habits in Discipline means each is worth half of "
        + CATEGORY_WEIGHT.discipline + ". Three means a third each. "
        + "Adding a habit does not add points \\u2014 it splits the ones already there."),

      // ---- 3. the 47 -----------------------------------------------------
      el("h2.sec-title", "A category with nothing to judge hands its points over"),
      el("p.scoring-line",
        "Savings is monthly, so on most days there is nothing to say about it. Rather than scoring "
        + "you out of " + (total - CATEGORY_WEIGHT.money) + ", its "
        + CATEGORY_WEIGHT.money + " is shared among the rest \\u2014 so the day is still worth exactly "
        + "a hundred. That is why a category can be worth more than its usual number."),

      // Their own day, which is the whole point of doing this here rather than in a help article.
      quiet.length && quiet.length < cats.length
        ? el("p.scoring-now",
            el("b", "Today: "),
            nameList(quiet.map((c) => CATEGORY_LABEL[c.category]))
            + (quiet.length === 1 ? " is not being judged" : " are not being judged")
            + (grown
              ? ", so " + CATEGORY_LABEL[grown.category] + " is worth "
                + Math.round(grown.share) + " instead of " + CATEGORY_WEIGHT[grown.category] + "."
              : ", so the rest carry the hundred between them."))
        : null,

      // ---- 4. the two numbers on the board -------------------------------
      el("h2.sec-title", "Points and percentages are the same thing"),
      el("p.scoring-line",
        "A day is worth exactly a hundred, so a share of it and a count of it are the same number. "
        + "66 out of 100 is 66% and 66 points. There is only one currency here; the screens just "
        + "show it in whichever form answers the question they are asking."),
      el("dl.scoring-defs",
        el("dt", "of 100"),
        el("dd", "Today. What the day has earned so far, out of the hundred it is worth."),
        el("dt", "%"),
        el("dd", "A week — the average of its days. It is a percentage rather than a total because "
          + "it is an average: 85% is 85 points a day, not 85 points for the week."),
        el("dt", "pts"),
        el("dd", "The season, and this one really is a total. Every week you play adds its score "
          + "to it, so a season is won on steady weeks rather than one good Sunday."),
      ),

      // ---- 5. bonus -------------------------------------------------------
      el("h2.sec-title", "Beating a goal earns a bonus"),
      el("p.scoring-line",
        "Up to " + Math.round((BONUS_CAP - 1) * 100) + " on top of the hundred, and it is shown "
        + "separately \\u2014 the day is worth exactly a hundred, so folding the bonus in would make the "
        + "number everybody reads mean something different from the number everybody agreed to. "
        // Only with a taper switched on. Writing the rules document caught this line claiming
        // that any three misses forfeit the bonus; bonusForfeited is gated on a taper being HELD,
        // so without one, missed days cost those days and nothing more.
        + "If you have a taper on and miss " + TAPER_MISS_LIMIT + " days of a week, it holds "
        + "for a week and no bonus is earned on anything while it does."),

      // ---- 6. what is left out --------------------------------------------
      el("h2.sec-title", "Days nobody asked you about do not count"),
      el("p.scoring-line",
        "Rest days, travel, and days a sensor reported nothing are left out of the score entirely "
        + "\\u2014 not marked as failures. You are measured on the days you were actually asked to show "
        + "up, which is why two people can have different numbers of days scored in the same week."),

      el("button.tap", { onclick: () => sheet.close() }, "Got it"),
    ),
  );
}
