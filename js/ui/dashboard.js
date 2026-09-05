// dashboard.js — the whole UI. Rebuilt from derived state whenever anything changes.
//
// Every number on this screen comes from habits.js. Nothing is computed here except presentation,
// which is what keeps one answer to "what is my streak" across the web app, the tests, and the
// Android shell.

import { el, render } from "../dom.js";
import {
  valueOn, valueForPeriod, targetOn, targetFor, isTracking, rawDayStatus, rawPeriodStatus, walk, sourceFor, periodKey, periodEnd, periodStart, addDays, daysBetween, isoDayOfWeek, compareDays, TAPER_MISS_LIMIT, HIT, MISS, NO_DATA, EXEMPT,
} from "../habits.js";
import {
  leaderboard, categoryOver, dayScore, expectedBy, categoryFor as categoryOf,
  CATEGORY, CATEGORY_LABEL, CATEGORY_ICON, CATEGORY_ORDER,
  CATEGORY_WEIGHT, BONUS_CAP, BONUS_CATEGORIES,
} from "../score.js";
import { seasonTally, categoryBreakdown } from "../season.js";
import { onGoalStreak } from "../summary.js";
import {
  AT_MOST, AGGREGATE, T, VISIBILITY, PERIOD, SOURCE, PAUSE_METRICS, AUTOMATIC_SOURCES,
  isInterventionHabit,
} from "../schema.js";

/** "this week" / "this month" — and nothing at all for a daily habit, where it would be noise. */
const CADENCE = { [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };
const STREAK_UNIT = {
  [PERIOD.DAY]: ["day", "days"],
  [PERIOD.WEEK]: ["week", "weeks"],
  [PERIOD.MONTH]: ["month", "months"],
};
import * as fmt from "./format.js";

// Two destinations. Habits used to be a third, showing a list people consult while setting
// something up and then leave alone for weeks — a permanent slot for an occasional errand. It
// opens from the header now, as a sheet.
const TABS = [
  { id: "today", label: "Today", glyph: "◉" },
  { id: "board", label: "Board", glyph: "♛" },
];

export function renderApp(root, ctx) {
  render(root,
    header(ctx),
    el("main.main", ctx.tab === "board" ? boardTab(ctx) : todayTab(ctx)),
    nav(ctx),
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const SYNC_TEXT = {
  SYNCED: ["is-synced", "Synced"],
  SYNCING: ["is-synced", "Syncing"],
  OFFLINE: ["is-offline", "Offline"],
  // Not "retrying": on the free tier this is most often a paused project, and no amount of
  // retrying wakes one. Saying so is what stops a dead sync looking like a slow one.
  DEGRADED: ["is-degraded", "Sync paused"],
  LOCAL_ONLY: ["is-local", "On this device"],
};

function header(ctx) {
  const [cls, text] = SYNC_TEXT[ctx.sync?.state] || SYNC_TEXT.LOCAL_ONLY;
  const queued = ctx.sync?.queued || 0;
  return el("header.hdr",
    el("div",
      el("div.hdr-title", ctx.state.meta?.name || "Goal Buddy"),
      el("div.hdr-sub", fmt.dayLabel(ctx.today), ctx.demo ? " · demo data" : ""),
    ),
    el("div.hdr-actions",
      el("span.pill." + cls, el("i.dot"), queued ? text + " · " + queued : text),
      // One button, not two. There used to be a ☰ for the habit list and a ⚙ for the shell's
      // settings, which asked the reader to know which of two apps a given setting belonged to —
      // a distinction that is an implementation detail here and the whole point of merging them
      // was that it should stop being visible. Everything you might go looking for is behind this.
      el("button.icon-btn", { onclick: () => ctx.onOpenHabits(), "aria-label": "Menu" }, "☰"),
    ),
  );
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function todayTab(ctx) {
  const all = [...ctx.state.habits.values()];
  // Only what this person actually signed up for. A group can track five things without everyone
  // doing all five, and showing someone a card for a habit they opted out of is just clutter.
  const habits = all.filter((h) => isTracking(ctx.state, h, ctx.me));
  if (!all.length) return emptyState(ctx);
  if (!habits.length) {
    return el("div.empty",
      el("h1", "Nothing picked yet"),
      el("p", "The group is tracking " + all.length + " habit" + (all.length === 1 ? "" : "s") + ". Choose the ones you're in for and set your own goals."),
      el("button.tap", { onclick: () => ctx.onEditGoals() }, "Pick my habits"),
    );
  }

  return [
    dayHero(ctx),
    el("section.sec",
      el("div.sec-hd",
        el("h2.sec-title", "Your day"),
        el("span.sec-note", timeLeft(ctx)),
      ),
      el("div.cards", habits.map((h) => habitCard(h, ctx))),
      streakLine(habits, ctx),
    ),
    correlationSection(habits, ctx),
    activitySection(ctx),
  ];
}

// ---------------------------------------------------------------------------
// What the two halves of the app say together
// ---------------------------------------------------------------------------

const COMPARE_WINDOW_DAYS = 30;

/**
 * The one thing neither app could say on its own.
 *
 * Pause always knew how much you were on your phone and the tracker always knew how much you
 * moved; they were two apps, so nobody ever put the two numbers in the same sentence. Now that
 * screen time is a habit in the shared log, this is a pure derivation over events that are
 * already here — no bridge call, no native computation, nothing that could disagree with the
 * board about what a good day was.
 *
 * It appears on its own terms or not at all. `compareDays` returns null unless both sides clear
 * the minimum, so a fortnight in there is simply no card, rather than a confident claim built on
 * three days.
 */
function correlationSection(habits, ctx) {
  const daily = habits.filter((h) => h.period === PERIOD.DAY);
  // The gate is a screen habit, because that is the half of the story the person controls in the
  // moment: "the days I stayed off my phone" is an action, where "the days I walked a lot" is
  // mostly an outcome. Reading it the other way round would be true and useless.
  const gate = daily.find((h) => PAUSE_METRICS.has(h.metric));
  if (!gate) return null;

  const from = addDays(ctx.today, -(COMPARE_WINDOW_DAYS - 1));
  let best = null;
  for (const subject of daily) {
    if (subject.habitId === gate.habitId) continue;
    const r = compareDays(ctx.state, gate.habitId, subject.habitId, ctx.me, from, ctx.today);
    if (!r) continue;
    // Most evidence wins, so the card does not flip between habits every time one day lands.
    const weight = r.met.days + r.missed.days;
    if (!best || weight > best.weight) best = { subject, r, weight };
  }
  if (!best) return null;

  const { subject, r } = best;
  const better = r.delta > 0;
  const gap = fmt.value(subject.metric, Math.abs(r.met.average - r.missed.average));
  const on = fmt.value(subject.metric, r.met.average);

  return el("section.sec",
    el("div.sec-hd",
      el("h2.sec-title", "Worth noticing"),
      el("span.sec-note", "last " + COMPARE_WINDOW_DAYS + " days"),
    ),
    el("div.card.insight",
      el("p.insight-line",
        el("strong", "On the " + r.met.days + " days you kept " + (gate.name || "screen time") + " under, "),
        "you averaged " + on + " " + (subject.name || "").toLowerCase() + ".",
      ),
      // The comparison, stated as a difference rather than a cause. Three friends over a month is
      // not evidence that one thing produced the other, and the sentence should not imply it did.
      el("p.insight-note", better
        ? "That's " + gap + " " + (subject.direction === AT_MOST ? "fewer" : "more")
          + " than the " + r.missed.days + " days you didn't."
        : r.met.average === r.missed.average
          ? "Which is the same as the " + r.missed.days + " days you didn't — no difference either way."
          : "The " + r.missed.days + " days you didn't were actually better, by " + gap + "."),
    ),
  );
}

function timeLeft(ctx) {
  const h = [...ctx.state.habits.values()][0];
  if (!h) return "";
  const now = new Date(ctx.now);
  const hoursGone = ((now.getHours() - h.dayStartHour) + 24) % 24;
  const left = 24 - hoursGone;
  return left <= 0 ? "" : left + "h left today";
}

/**
 * One habit's card for today.
 *
 * Build and reduce habits are drawn differently on purpose. A build habit fills a bar toward a
 * target; a reduce habit drains a budget of dots. A full bar means success in one and failure in
 * the other, so they must not look alike.
 */
function habitCard(habit, ctx) {
  // A weekly habit's card is about the WEEK. Showing today's number for "gym three times a week"
  // would read as though you had failed on every rest day.
  const key = periodKey(ctx.today, habit.period);
  const value = valueForPeriod(ctx.state, habit, ctx.me, key);
  // Tapered to the end of the period, but read against the goal in force at its START — the
  // same pair the engine scores with, so the card can never show a target the verdict disagrees
  // with.
  const target = targetFor(
    ctx.state, habit, ctx.me, periodEnd(key, habit.period), periodStart(key, habit.period),
  );
  const status = rawPeriodStatus(ctx.state, habit, ctx.me, key);
  const cadence = CADENCE[habit.period] || "";
  const source = sourceFor(ctx.state, habit, ctx.me);
  const src = fmt.source(source);
  const reduce = habit.direction === AT_MOST;
  // A ceiling you count yourself — puffs, urges — rather than a running total something reads for
  // you. It no longer changes the card's SIZE, only how the card speaks: what the log button is
  // called, and whether the source badge is allowed to claim the number arrives on its own.
  const intervention = isInterventionHabit(habit);
  // Something fills this in already, so logging is an override rather than the way in. An
  // intervention habit is never "auto" whatever it is bound to: nothing anywhere reads a puff.
  const auto = AUTOMATIC_SOURCES.has(source) && !intervention;

  const classes = ["card"];
  // Every card is the same size now. This one used to span the whole grid to make room for an
  // "I want to vape" button, which left the habit somebody checks most often as a slab twice the
  // size of everything around it — for a button that was never pressed.
  if (status === HIT) classes.push("is-hit");
  if (status === NO_DATA) classes.push("is-nodata");
  if (reduce && value != null && value > target) classes.push("is-over");

  return el("article." + classes.join("."),
    el("div.card-top",
      el("span.card-icon", habit.icon || "◆"),
      el("span.card-name", habit.name || "Habit"),
    ),
    el("div",
      el("div.card-value", reduce
        // Nothing logged against a ceiling means nothing spent — the whole budget is still there.
        // A dash would read as "unknown" when the honest answer is "all of it".
        ? fmt.value(habit.metric, Math.max(0, target - (value || 0)))
        : fmt.value(habit.metric, value)),
      // A paced habit says where the line is TONIGHT, not just where the week ends. "1 of 3" is a
      // number you can answer; "you are 0.43 behind" is not, and a pace nobody can picture is a
      // pace nobody runs.
      habit.period !== PERIOD.DAY && !reduce
        ? el("div.card-of",
            (value || 0) + " of " + fmt.value(habit.metric, target) + " " + cadence
            + " · " + expectedBy(habit, ctx.today) + " by tonight")
        : null,
      // The paced line above already said the target and the cadence, so this one would repeat it.
      habit.period !== PERIOD.DAY && !reduce ? null : el("div.card-of", reduce
        ? "left of " + fmt.value(habit.metric, target) + " " + (cadence || "today")
        : status === NO_DATA ? "waiting for data"
        : fmt.goal(habit, target) + (cadence ? " " + cadence : "")),
    ),
    reduce ? budgetDots(value, target) : progressBar(value, target),
    el("div.card-foot",
      el("span.src", src.icon, " ", src.label),
      status === HIT ? el("span", "✓") : null,
    ),
    // One way in, named for what it actually asks for. A puff count is read off the device and
    // typed, so "Enter today's count" is the instruction; a watch metric is already filled in and
    // only needs an override; everything else is just a log.
    el("button.logbtn", { onclick: () => ctx.onLog(habit) },
      intervention ? "Enter today's count"
        : auto ? "Enter it manually"
        : "＋ Log"),

    // Screen time is measured by the shell, so the shell is where its dials are. They used to be a
    // tab, which put one habit's settings permanently in the navigation of an app that tracks
    // several — so they open from the habit instead, which is what they have always been about.
    PAUSE_METRICS.has(habit.metric) && ctx.focusSettings
      ? el("button.cardlink", { onclick: () => ctx.onOpenFocus() }, "Adjust limits →")
      : null,
  );
}

/**
 * The day in one card: how long the run is, and how today is going.
 *
 * ---- Where this came from ----
 *
 * This was a native card on a Home tab, which was a screen that opened the app by summarising the
 * screen you would see if you pressed the next tab along. It showed the streak, then a digest of
 * the same habits Today lists in full, then a count of slowed apps that the Focus tab already
 * showed. A person's first impression of the app was a table of contents for itself.
 *
 * The streak and the percentage are the two things it had that Today genuinely lacked, so they
 * moved here and the tab went away. Both come off the engine that already computes them for the
 * board and for the shell's notifications — nothing on this screen is worked out twice.
 */
function dayHero(ctx) {
  const streak = onGoalStreak(ctx.state, ctx.me, ctx.today);
  const scored = dayScore(ctx.state, ctx.me, ctx.today, ctx.today);
  const pct = Math.round(scored.pct || 0);
  const bonus = Math.round(scored.bonus || 0);

  return el("section.sec",
    el("div.hero",
      el("div.hero-head",
        el("div.hero-mark" + (streak > 0 ? ".is-lit" : ""), streak > 0 ? "🔥" : "·"),
        el("div.hero-run",
          streak > 0
            ? el("div.hero-streak", el("b", String(streak)), el("span", streak === 1 ? " day" : " days"))
            : el("div.hero-none", "Start your streak"),
          el("div.hero-sub", streak > 0
            ? "every habit, on goal"
            : "meet every goal today to begin"),
        ),
      ),
      el("div.hero-row",
        el("span", "Today, across everything"),
        el("span.hero-pct" + (pct >= 100 ? ".is-hit" : ""),
          pct + "%",
          // Beside the percentage, never inside it. The day is worth exactly a hundred; this is
          // what beating the targets earned on top.
          bonus > 0 ? el("span.row-bonus", " +" + bonus) : null,
        ),
      ),
      el("div.bar", { role: "presentation" }, el("i", { style: "width:" + Math.min(100, pct) + "%" })),

      // The taper penalty, said out loud.
      //
      // Missing three days in a week holds the ceiling where it is AND costs every bonus point
      // that week, across every habit. Nobody would ever deduce that from a smaller number, and it
      // lived in one native card that no longer exists — so it gets a sentence rather than a
      // silence, in the one place the day is being summarised.
      scored.bonusForfeited
        ? el("p.hero-penalty", scored.bonusWithheld > 0
            ? "No bonus this week — you missed three days, so your limit holds and the "
              + Math.round(scored.bonusWithheld) + " points you'd have earned don't count."
            : "No bonus this week — you missed three days, so your limit holds where it is.")
        : null,

      // What carried the day and what sank it. Only the categories actually being asked about
      // today, because a row reading "0 of 0" is not a shortfall, it is a category nobody signed
      // up for.
      categoryLines(scored),
    ),
  );
}

function categoryLines(scored) {
  const live = (scored.categories || []).filter((c) => c.eligible && c.share > 0);
  if (!live.length) return null;

  return el("div.hero-cats", live.map((c) => {
    const reached = Math.min(100, Math.round((c.score || 0) * 100));
    const tone = reached >= 100 ? " is-hit" : reached < 50 ? " is-poor" : "";
    const bonus = Math.round(c.bonus || 0);
    return el("div.hero-cat",
      el("div.hero-cat-top",
        el("span.hero-cat-icon", CATEGORY_ICON[c.category]),
        el("span.hero-cat-name", CATEGORY_LABEL[c.category]),
        el("span.hero-cat-num" + tone,
          Math.round(c.points) + " of " + Math.round(c.share),
          bonus > 0 ? el("span.row-bonus", " +" + bonus) : null,
        ),
      ),
      el("div.bar" + tone, { role: "presentation" }, el("i", { style: "width:" + reached + "%" })),
    );
  }));
}

function progressBar(value, target) {
  const pct = target > 0 ? Math.min(100, Math.round(((value || 0) / target) * 100)) : 0;
  return el("div.bar", { role: "presentation" }, el("i", { style: "width:" + pct + "%" }));
}

/**
 * A reduce habit's budget, draining as it is used. Capped so a very bad day still renders.
 *
 * The dots are a PROPORTION, not a tally. That distinction did not exist while every reduce habit
 * had a target you could count on your fingers — with a target of 8, one dot was one urge. A
 * ninety-minute screen budget broke it: 46 minutes used to subtract 46 from twelve dots and drain
 * every one of them, so the best day of the week rendered identically to the worst.
 */
function budgetDots(value, target) {
  // Ten, not twelve: at 8px plus a 4px gap, twelve will not fit across a half-width card and
  // wraps a single orphan dot onto its own line, which reads as a rendering fault rather than
  // as a budget.
  const shown = Math.max(1, Math.min(target, 10));
  const used = target > 0
    ? Math.min(shown, Math.round(((value || 0) / target) * shown))
    : shown;
  return el("div.dots", Array.from({ length: shown }, (_, i) =>
    el("i" + (i < shown - used ? "" : ".spent"))));
}

function streakLine(habits, ctx) {
  const best = habits
    .map((h) => walk(ctx.state, h.habitId, ctx.me, ctx.today))
    .filter(Boolean)
    .sort((a, b) => b.streak - a.streak)[0];
  if (!best) return null;

  const [one, many] = STREAK_UNIT[best.habit.period] || STREAK_UNIT[PERIOD.DAY];
  return el("div.streakline",
    el("span", "🔥 ", el("b", best.streak), " ", best.streak === 1 ? one : many),
    el("span", "🛡 ", el("b", best.tokens), best.tokens === 1 ? " grace token" : " grace tokens"),
    // Grace is never spent silently: a streak that survived because a token was burned, without
    // saying so, reads as a bug the first time someone notices the maths.
    best.spent.length ? el("span", "· spent " + best.spent.length + " this run") : null,
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function boardTab(ctx) {
  const members = [...ctx.state.members.keys()];
  if (!members.length) return emptyState(ctx);

  const from = addDays(ctx.today, -(isoDayOfWeek(ctx.today) - 1)); // Monday of this week
  const rows = leaderboard(ctx.state, members, from, ctx.today, ctx.today);
  const filter = ctx.boardCategory || null;

  // Only the categories somebody in the group is actually running. A filter for a category nobody
  // tracks is a tab that leads to an empty screen and a question about whether it is broken.
  const live = CATEGORY_ORDER.filter((c) => [...ctx.state.habits.values()].some(
    (h) => h.scored && categoryOf(h) === c,
  ));

  const ranked = filter
    ? rows
        .map((r) => {
          // The days count has to be the CATEGORY's, not the day's. Showing "0/1 days" from the
          // overall board beside a Core Fitness percentage is two different weeks in one sentence,
          // and the reader has no way to know which number belongs to which.
          const only = categoryOver(ctx.state, r.memberId, from, ctx.today, filter, addDays);
          return {
            ...r,
            pct: only.pct,
            eligible: only.days,
            hits: null,
            noData: null,
            spentTokens: 0,
            filtered: true,
          };
        })
        .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
        .map((r, i) => ({ ...r, rank: i + 1, crown: false, clown: false }))
    : rows;

  if (ctx.boardSeason) return seasonSection(ctx, members);

  return el("section.sec",
    el("div.sec-hd",
      el("h2.sec-title", "The board"),
      el("button.link.sec-note", { onclick: () => ctx.onBoardSeason(true) }, "All time →"),
    ),
    live.length > 1 ? el("div.chips.chips-tight",
      el("button.chip" + (!filter ? ".on" : ""), {
        onclick: () => ctx.onBoardCategory(null),
      }, "Overall"),
      live.map((c) => el("button.chip" + (filter === c ? ".on" : ""), {
        onclick: () => ctx.onBoardCategory(c),
      }, CATEGORY_ICON[c] + " " + CATEGORY_LABEL[c])),
    ) : null,
    filter ? el("p.sec-note", { style: "padding:0 2px" },
      CATEGORY_LABEL[filter] + " only — scored on its own terms, not as a share of the day.") : null,
    el("div.board", ranked.map((r) => boardRow(r, ctx))),
    el("p.sec-note", { style: "padding:0 2px" },
      "Rest days and days with no data are left out of the score — you're measured on the days you were actually asked to show up."),
    offBoardNote(ctx),
    pointsExplainer(ctx),
  );
}

/**
 * Which of your habits are not in this, and why.
 *
 * The board scores six things, and anything else somebody tracks is theirs alone. That is a
 * reasonable rule and a terrible surprise: without this line, a habit kept faithfully for a month
 * simply never appears in the standings, and the only available explanation is that the app is
 * broken or the sync is.
 *
 * Only shown to somebody who actually has one, and it names them, because "some habits don't
 * count" sends a person hunting through their own list to work out which.
 */
function offBoardNote(ctx) {
  const mine = [...ctx.state.habits.values()]
    .filter((h) => !h.scored && isTracking(ctx.state, h, ctx.me));
  if (!mine.length) return null;

  return el("p.sec-note", { style: "padding:0 2px" },
    mine.map((h) => h.name).join(", ")
    + (mine.length === 1 ? " isn't" : " aren't")
    + " on the board — the board is the six the group agreed on. "
    + (mine.length === 1 ? "It still counts" : "They still count")
    + " on Today, and the streak is real.");
}

/**
 * How a day becomes points, in the group's own numbers.
 *
 * ---- Why this is not a static block of prose ----
 *
 * Every figure below is read from the engine — the weights out of CATEGORY_WEIGHT, the ceiling out
 * of BONUS_CAP, the miss limit out of TAPER_MISS_LIMIT. Written out by hand it would be correct on
 * the day it shipped and quietly wrong after the next rule change, which is worse than having no
 * explanation at all: a leaderboard nobody understands is merely opaque, one that explains itself
 * incorrectly is untrustworthy.
 *
 * Collapsed by default, and a plain <details> rather than a scripted accordion — it is reference
 * material somebody opens once when they start arguing about the standings.
 */
function pointsExplainer(ctx) {
  const bonusMax = Math.round((BONUS_CAP - 1) * 100);
  const weights = CATEGORY_ORDER.map((c) => ({
    key: c,
    label: CATEGORY_LABEL[c],
    icon: CATEGORY_ICON[c],
    weight: CATEGORY_WEIGHT[c],
    bonus: BONUS_CATEGORIES.has(c),
  }));

  const rule = (title, body) => el("div.rule", el("b", title), " ", body);

  return el("details.explainer",
    el("summary", "How points work"),

    el("p.rule-lede",
      "A DAY is worth exactly 100 — never a habit, never a week. A week is the average of its "
      + "days, and the season is every week added up."),

    el("div.rules",
      rule("The four shares",
        "Each day's 100 is split by what the group agreed. Nobody can change these, because a "
        + "dial on how much your own easiest habit counts is a dial on your own scoreline."),

      el("table.weights",
        weights.map((w) => el("tr",
          el("td", w.icon + " " + w.label),
          el("td.w", String(w.weight)),
          el("td.b", w.bonus ? "bonus" : "no bonus"),
        )),
      ),

      rule("Only what you're actually doing counts",
        "The shares are re-spread over the categories you're being judged on that day, so a day "
        + "is out of 100 whether you run two of them or all four. Resting, or a sensor going "
        + "quiet, removes a category rather than scoring it zero — and never raises your score."),

      rule("Habits inside a category split it equally",
        "Two fitness habits get half of Core fitness each. Tracking more never lowers your "
        + "ceiling; it just divides that category between them."),

      rule("Beating a goal pays a bonus, up to " + bonusMax + " more",
        "Kept separate from the 100 so the percentage keeps meaning what it says. It's shared out "
        + "by weight like everything else, and " + CATEGORY_LABEL[CATEGORY.REST] + " earns none — "
        + "sleeping past your goal isn't an achievement to pay for, and paying for it would make "
        + "a low sleep goal the cheapest way up the board."),

      rule("A ceiling is pass or fail on the day",
        "Under your limit is full marks, and further under earns more of the bonus. One over is "
        + "zero for that habit that day — the limit is the point."),

      rule("Missing " + TAPER_MISS_LIMIT + " days holds your taper, and costs the week's bonus",
        "Your vape ceiling stops coming down that week, on every habit you have. Holding is "
        + "easier than not holding, so it has to cost something — otherwise the strongest play is "
        + "to miss " + TAPER_MISS_LIMIT + " days a week for ever and keep the opening allowance."),

      rule("A silent sensor is not a failure",
        "A watch that reported nothing is a broken pipeline, and it costs nothing. A habit you "
        + "log by hand and didn't log IS a miss — the number existed, and reporting it was the "
        + "task. Workouts are the exception: you can always type those in yourself."),

      rule("Monthly goals are judged when the month ends",
        "A savings goal isn't scored while the month can still be saved, so an early deposit "
        + "never drags your day down. When the month closes it colours all of its days at once. "
        + "Hitting it early is paid on the day."),

      rule("The season is won on points",
        "Crowns only break a tie. Three near-misses used to be worth the same as three terrible "
        + "weeks, which decided the season on a handful of Sundays and left nothing to play for "
        + "once somebody was clear."),
    ),
  );
}

/**
 * The long game: every completed week has a winner, and the crowns stack up.
 *
 * A weekly board resets every Monday, which is fair and forgettable — nothing carries, so a
 * brilliant February is worth exactly as much as last week. Points are the number that makes it a
 * season: they only ever go up, one bad week cannot dent them, and they reward whoever kept
 * showing up over whoever had a single enormous fortnight.
 */
function seasonSection(ctx, members) {
  const { weeks, rows } = seasonTally(ctx.state, members, ctx.today);

  return el("section.sec",
    el("div.sec-hd",
      el("h2.sec-title", "All time"),
      el("button.link.sec-note", { onclick: () => ctx.onBoardSeason(false) }, "← This week"),
    ),
    weeks === 0
      ? el("p.sec-note", { style: "padding:0 2px" },
          "Nothing to tally yet — the first week has to finish. This week's board is still live.")
      // The rank NUMBER, not a crown. The season is ranked on points now, so its leader may
      // have won no weeks at all — and 👑 means "won a week" everywhere else in this app.
      // Putting it on the season leader would be two different claims wearing one symbol.
      : el("div.board", rows.map((r) => el("article.row" + (r.memberId === ctx.me ? ".is-me" : "")
          + (r.rank === 1 ? ".is-crown" : ""),
          el("div.row-rank", String(r.rank)),
          el("div.row-main",
            el("div.row-name", r.memberId === ctx.me ? "You" : r.name),
            el("div.row-meta",
              r.crowns ? "👑 " + r.crowns + (r.crowns === 1 ? " week won" : " weeks won") : "no weeks won",
              r.weeks ? " of " + r.weeks : "",
              r.bestCrownStreak > 1 ? " · best run " + r.bestCrownStreak : "",
              r.crownStreak > 1 ? " · 🔥 " + r.crownStreak + " in a row" : "",
            ),
            el("div.row-meta",
              // "a week" rather than "%": with bonus in it a week can be worth more than a
              // hundred, and a percentage that goes to 115 reads as a bug rather than a reward.
              r.avg === null ? "nothing scored yet" : "averaging " + r.avg + " a week",
              r.best ? " · best " + r.best.pct : "",
              r.bonus ? " · " + r.bonus + " from bonus" : "",
            ),
          ),
          el("div.row-pct", String(r.points)),
        ))),
    weeks > 0 ? el("p.sec-note", { style: "padding:0 2px" },
      "Every week you play adds its score to your total, so the season is won on points rather "
      + "than on a handful of Sundays — and bonus points, which only come from beating a goal "
      + "rather than meeting it, are how somebody behind closes a gap. Crowns break a tie. "
      + weeks + (weeks === 1 ? " week" : " weeks") + " counted so far.") : null,

    // Offered here rather than buried in settings, because this is the screen you are looking at
    // when you decide the standings are not worth keeping.
    ctx.onNewSeason
      ? el("button.link.sec-note", { onclick: () => ctx.onNewSeason() }, "Start a new season →")
      : null,
  );
}

function boardRow(row, ctx) {
  const classes = ["row"];
  if (row.memberId === ctx.me) classes.push("is-me");
  if (row.crown) classes.push("is-crown");

  return el("article." + classes.join("."),
    el("div.row-rank", row.rank),
    el("div.row-main",
      el("div.row-name",
        row.crown ? el("span.tagemoji", { title: "Top of the board" }, "👑") : null,
        row.clown ? el("span.tagemoji", { title: "Bottom of the board" }, "🤡") : null,
        row.memberId === ctx.me ? "You" : row.name,
      ),
      el("div.row-bar", el("i", { style: "width:" + (row.pct == null ? 0 : row.pct) + "%" })),
      el("div.row-meta",
        // Filtered, the only honest count is how many days this category was asked about — hits
        // belong to the whole day and would be answering a question nobody asked here.
        row.filtered
          ? (row.eligible ? row.eligible + (row.eligible === 1 ? " day scored" : " days scored")
            : "nothing scored yet")
          : row.eligible ? row.hits + "/" + row.eligible + " days" : "nothing scored yet",
        row.streak ? " · 🔥 " + row.streak : "",
        row.spentTokens ? " · 🛡 spent " + row.spentTokens : "",
        // Days nothing was reported. They cost nothing on purpose — a watch that stopped is not a
        // failure — but nothing was the same as saying so, which made silence the cheapest way to
        // avoid a bad week. Shown rather than scored: the group can see it, and the number is the
        // person's own to explain.
        row.noData ? el("span.row-quiet", " · " + row.noData + " not reported") : null,
      ),
    ),
    // The percentage, and beside it what beating the targets earned on top. Two numbers rather
    // than one on purpose: a day is worth exactly a hundred, so folding the bonus in would make
    // the figure everybody reads mean something different from the figure everybody agreed to.
    el("div.row-pct",
      row.pct == null ? "—" : row.pct + "%",
      row.bonus ? el("span.row-bonus", " +" + row.bonus) : null,
    ),

    // Which category carried the week and which sank it. The percentage says where somebody came;
    // this says what to do about it on Monday, which is the only part anybody can act on.
    //
    // Not while filtered: the row already IS one category, and repeating it underneath its own
    // percentage says the same thing twice and looks like a second, disagreeing number.
    row.pct != null && !row.filtered ? el("div.row-parts", categoryBreakdown(
      ctx.state, row.memberId, addDays(ctx.today, -(isoDayOfWeek(ctx.today) - 1)), ctx.today,
    ).map((part) => el("span.part" + (part.pct >= 100 ? ".is-full" : part.pct < 50 ? ".is-low" : ""),
      CATEGORY_ICON[part.category] + " " + part.pct + "%"))) : null,
    // The fairness rule, made visible. If the bottom row had a silent pipeline there is no clown
    // at all this week — and the person is told why, and offered the fix, rather than left to
    // wonder why their numbers look bad.
    row.clownSuppressed
      ? el("div.note",
          el("div",
            el("b", row.memberId === ctx.me ? "Nothing came through from your phone"
              : "Nothing came through from " + (row.name || "them")),
            " — nothing to score, so nobody is the clown this week.",
          ),
          el("button", { onclick: () => ctx.onFixSync(row) },
            row.memberId === ctx.me ? "Why? →" : "What they should check →"),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function activitySection(ctx) {
  const items = recentActivity(ctx, 8);
  if (!items.length) return null;
  return el("section.sec",
    el("div.sec-hd", el("h2.sec-title", "Activity")),
    el("div.feed", items),
  );
}

function recentActivity(ctx, limit) {
  const out = [];
  const seen = new Set();
  // Newest first, and only one line per habit-day-person: a running total that ticked three times
  // is one thing that happened, not three.
  for (let i = ctx.events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = ctx.events[i];
    // Goal changes belong in the feed. They are the one thing a person can do that moves their own
    // score without doing anything, and they were completely invisible: the number simply became
    // easier and the board reflected it. They cannot rewrite the past any more, but "quietly" was
    // half of what made it worth doing.
    if (e.type === T.GOAL) {
      const g = e.payload || {};
      const habit = ctx.state.habits.get(g.habitId);
      if (!habit) continue;
      const key = "goal|" + g.habitId + "|" + g.memberId + "|" + e.eventId;
      if (seen.has(key)) continue;
      seen.add(key);
      const who = g.memberId === ctx.me ? "You" : (ctx.state.members.get(g.memberId)?.name || "Someone");
      out.push(el("div.ev",
        el("span", "🎯"),
        el("span.ev-when", fmt.whenLabel(e.ts, ctx.now)),
        el("span.ev-what", el("b", who), " ", goalPhrase(habit, g)),
      ));
      continue;
    }
    if (e.type !== T.LOG) continue;
    const p = e.payload || {};
    const habit = ctx.state.habits.get(p.habitId);
    if (!habit) continue;
    const key = p.habitId + "|" + p.memberId + "|" + p.day;
    if (seen.has(key)) continue;
    seen.add(key);

    const who = p.memberId === ctx.me ? "You" : (ctx.state.members.get(p.memberId)?.name || "Someone");
    const src = fmt.source(p.source);
    const status = rawDayStatus(ctx.state, habit, p.memberId, p.day);
    const shown = publicNumber(habit, p, ctx);

    out.push(el("div.ev",
      el("span", src.icon),
      el("span.ev-when", fmt.whenLabel(e.ts, ctx.now)),
      el("span.ev-what",
        el("b", who), " ", verbFor(habit, shown, p.source),
        status === HIT ? " ✓" : "",
      ),
    ));
  }
  return out;
}

/** Respect the habit's visibility before putting anyone's number in a shared feed. */
function publicNumber(habit, payload, ctx) {
  if (payload.memberId === ctx.me) return payload.value;
  if (habit.visibility === VISIBILITY.FULL) return payload.value;
  return null;
}

/** A goal change, in the fewest words that still say what happened. */
function goalPhrase(habit, payload) {
  const name = (habit.name || "a habit").toLowerCase();
  if (payload.active === false) return "stopped tracking " + name;
  if (payload.target == null) return "changed their " + name + " goal";
  return "set their " + name + " goal to " + fmt.value(habit.metric, Number(payload.target));
}

function verbFor(habit, value, source) {
  if (habit.aggregate === AGGREGATE.SUM) {
    return value === 0 ? "resisted an urge" : "logged " + (habit.name || "a habit").toLowerCase();
  }
  const name = (habit.name || "").toLowerCase();
  if (value == null) return "updated " + (name || "a habit");
  // Nobody logged their screen time; the phone counted it while they were not thinking about it,
  // and saying "logged" credits them with an act of discipline they did not perform.
  const verb = source === SOURCE.PAUSE ? "spent" : "logged";
  return verb + " " + fmt.value(habit.metric, value) + " " + name;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function emptyState(ctx) {
  return el("div.empty",
    el("h1", "No habits yet"),
    el("p", ctx.state.members.size
      ? "Add the first habit and the group can start showing up for it."
      : "Start a group and share the code with your friends, or join one you were sent."),
    el("button.tap", { onclick: ctx.onStart }, "Get started"),
    el("button.ghost", { onclick: () => { location.search = "?demo=1"; } }, "See it with example data"),
  );
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function nav(ctx) {
  // Embedded, Today and Board are native destinations and the shell is already drawing a bar.
  // Drawing a second one under it is the nested-navigation trap this merge exists to remove.
  if (ctx.embedded) return null;
  return el("nav.nav", { "aria-label": "Sections" },
    TABS.map((t) => el("button.nav-btn", {
      "aria-current": ctx.tab === t.id ? "page" : null,
      onclick: () => ctx.onTab(t.id),
    }, el("span.g", t.glyph), t.label)),
  );
}
