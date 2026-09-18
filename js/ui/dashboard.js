// dashboard.js — the whole UI. Rebuilt from derived state whenever anything changes.
//
// Every number on this screen comes from habits.js. Nothing is computed here except presentation,
// which is what keeps one answer to "what is my streak" across the web app, the tests, and the
// Android shell.

import { el, render } from "../dom.js";
import {
  valueOn, valueForPeriod, targetOn, targetFor, isTracking, rawDayStatus, rawPeriodStatus, walk, sourceFor, periodKey, periodEnd, periodStart, addDays, daysBetween, isoDayOfWeek, compareDays, bestDailyInsight, streak as habitStreak, TAPER_MISS_LIMIT, HIT, MISS, NO_DATA, EXEMPT,
  visibilityFor, travelPeriod, groupDayHabit,
} from "../habits.js";
import {
  leaderboard, rankCompare, tieBreak, categoryOver, dayScore, expectedBy, withoutWorstDay, categoryFor as categoryOf,
  priceHabits, CATEGORY, CATEGORY_LABEL, CATEGORY_ICON, CATEGORY_ORDER,
  CATEGORY_WEIGHT, BONUS_CAP, BONUS_CATEGORIES, CATEGORY_SHORT } from "../score.js";
import { seasonTally, categoryBreakdown, seasonProgress } from "../season.js";
import { onGoalStreak } from "../summary.js";
import { tierFor, nextTier, habitLevel, LEVEL_KEY } from "../milestones.js";
import { awards } from "../awards.js";
import { neverMissed } from "../history.js";
import { programFor, planFor } from "../workout.js";
import { pendingGoal } from "../edits.js";
import { lifetime } from "../levels.js";
import { activityItems } from "../activity.js";
import { todayModel } from "../today.js";
import { levelMark } from "./levelmark.js";
import {
  AT_MOST, AGGREGATE, T, VISIBILITY, PERIOD, SOURCE, METRIC, PAUSE_METRICS, AUTOMATIC_SOURCES,
  isInterventionHabit,
} from "../schema.js";

/** "this week" / "this month" — and nothing at all for a daily habit, where it would be noise. */
const CADENCE = { [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };
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
  // A manual sync spends most of its time in the shell — reading the sensor and pushing — before
  // this page's own flush ever starts, so the pill has to say so for that whole stretch. Without
  // it the tap produces nothing visible for several seconds and reads as a dead control.
  const [cls, text] = ctx.syncing
    ? SYNC_TEXT.SYNCING
    : (SYNC_TEXT[ctx.sync?.state] || SYNC_TEXT.LOCAL_ONLY);
  const queued = ctx.sync?.queued || 0;
  // The sync status, as a dot beside the group's name. It was a pill that said "Synced" on the
  // right; the person's level now lives there, and the status keeps its colour, its tap and its
  // words — in the title, and read out — at a size that matches how often it is news.
  //
  // Tapping it forces a sync, where the shell can be asked. This is where somebody already looks
  // when they doubt a number, and making them hunt through a settings sheet for "Sync now" is
  // asking them to already know the app. In a browser there are no sensors to re-read and the
  // dot stays what it always was: a status, not a control.
  const label = queued ? text + " · " + queued + " waiting" : text;
  const syncDot = ctx.manualSync
    ? el("button.sync-dot." + cls, {
        disabled: !!ctx.syncing,
        onclick: () => ctx.onSyncNow(),
        "aria-label": label + " — tap to sync now",
        title: label + " — tap to sync now",
      }, el("i.dot"), queued ? el("span.sync-dot-n", String(queued)) : null)
    : el("span.sync-dot." + cls, { title: label, "aria-label": label },
        el("i.dot"), queued ? el("span.sync-dot-n", String(queued)) : null);

  return el("header.hdr",
    el("div.hdr-who",
      el("div.hdr-title", ctx.state.meta?.name || "Goal Buddy", syncDot),
      el("div.hdr-sub", fmt.dayLabel(ctx.today), ctx.demo ? " · demo data" : ""),
    ),
    el("div.hdr-actions",
      // The person: ring, name, level and title. Tapping it explains. See levels.js for what a
      // level is and is not.
      ctx.onLevel ? levelChip(ctx) : null,
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

  // The day, scored once, and every card priced off it. dayHero used to score it for itself;
  // pricing the cards needs the same result, and scoring the day twice per paint would be paying
  // for the same walk to get the same answer.
  const scored = dayScore(ctx.state, ctx.me, ctx.today, ctx.today);
  const prices = priceHabits(scored);
  // The Today tab, classified as data — see today.js. Phase 1 renders its hero and attribute bars
  // from here; the cards still use the path above until their layouts are rebuilt.
  const model = todayModel(ctx.state, ctx.me, ctx.today, ctx.now);

  return [
    travelBanner(ctx),
    dayHero(ctx, scored, model),
    el("section.sec",
      el("div.sec-hd", el("h2.sec-title", "Your day")),
      // The countdown, lifted out of the heading to sit as a quiet anchor right above the widgets.
      model.hero.hoursLeft ? el("p.day-anchor", model.hero.hoursLeft + "h left today") : null,
      el("div.cards", habits.map((h) => habitCard(h, ctx, prices.get(h.habitId)))),
    ),
    // Worth noticing stays; it is the one thing on this screen that is not on a card. The
    // activity feed moved to the Board: it is about the group, and Today is about you.
    correlationSection(ctx),
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
function correlationSection(ctx) {
  // Which comparison to show is decided in bestDailyInsight (a tested function): the screen-time
  // gate, and the habit with the most evidence against it. Here we only phrase it.
  const from = addDays(ctx.today, -(COMPARE_WINDOW_DAYS - 1));
  const best = bestDailyInsight(ctx.state, ctx.me, from, ctx.today);
  if (!best) return null;

  const { gate, subject, r } = best;
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

/**
 * One habit's card for today.
 *
 * Build and reduce habits are drawn differently on purpose. A build habit fills a bar toward a
 * target; a reduce habit drains a budget of dots. A full bar means success in one and failure in
 * the other, so they must not look alike.
 */
function habitCard(habit, ctx, price) {
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
  // Sleep is measured, never typed — see the note by the log button. Unless somebody has
  // deliberately bound it to themselves in the editor, in which case hiding the button would leave
  // them with a habit they have no way to record.
  const typedByHand = habit.metric !== METRIC.SLEEP || !AUTOMATIC_SOURCES.has(source);
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
    // The card's reading half opens the habit's history; the log button below it stays its own
    // control. A button rather than the whole article, because the article already contains one
    // and nesting them is invalid — and because the half somebody taps to READ should not be the
    // half they tap to WRITE.
    el("button.card-open", {
      onclick: () => ctx.onHabitDetail && ctx.onHabitDetail(habit.habitId),
      "aria-label": (habit.name || "Habit") + " — history",
    },
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
      // Paced, for a habit that can actually be paced. "Three workouts a week, two by tonight" is a
      // sentence somebody can act on this evening.
      habit.period === PERIOD.WEEK && !reduce
        ? el("div.card-of",
            (value || 0) + " of " + fmt.value(habit.metric, target) + " " + cadence
            + " · " + expectedBy(habit, ctx.today) + " by tonight")
        : null,

      // A month is not paced, and saying it is contradicts the engine to the person's face.
      //
      // Money arrives as a payday lump, not a daily drip, so scoring refuses to judge a savings
      // goal at all while the month can still be saved — no penalty, deliberately. The card was
      // saying the opposite: "0 of 15 000 this month · 2000 by tonight", under an empty bar, on the
      // fourth. That is a shortfall the engine does not believe in, reported to somebody who has
      // done nothing wrong, three weeks before they get paid.
      //
      // What is true instead: how much is left, how long there is, and that nothing is being
      // decided yet.
      habit.period === PERIOD.MONTH && !reduce
        ? monthlyLines(habit, value, target, ctx)
        : null,
      // The paced line above already said the target and the cadence, so this one would repeat it.
      habit.period !== PERIOD.DAY && !reduce ? null : el("div.card-of", reduce
        ? "left of " + fmt.value(habit.metric, target) + " " + (cadence || "today")
        : status === NO_DATA ? "waiting for data"
        : fmt.goal(habit, target) + (cadence ? " " + cadence : "")),
      // A new number that is not counting yet, said beside the one that is. See pendingGoal.
      pendingLine(habit, ctx),
    ),
    reduce ? budgetDots(value, target) : progressBar(value, target),
    ),
    // The price. What this habit can put on today, and how much of that it has so far — so the
    // card says what the action is worth before it is taken, and the distance to a perfect day on
    // the hero above is a number the reader can see how to close.
    price
      ? el("div.card-worth" + (price.earned >= price.worth - 0.5 ? ".is-full" : ""),
          Math.round(price.earned) + " of " + Math.round(price.worth) + " " + fmt.XP,
          price.bonus >= 0.5 ? el("span.row-bonus", " +" + Math.round(price.bonus)) : null)
      : null,
    el("div.card-foot",
      // The source badge IS the sync control, on a card something else fills in.
      //
      // There has been a manual sync in this app the whole time: the status pill in the header is
      // a button. Nobody ever found it, and the reason is that it is shaped like a status — a
      // green dot and the word "Synced" is a thing you read, not a thing you press. It arrived as
      // a request for the button that already existed, which is the same report the badges got.
      //
      // Here as well, because this is where the doubt is. Somebody who thinks their steps are
      // wrong is looking at the step count, and the badge under it is already the app's claim that
      // this number arrives on its own — which is exactly the claim they have stopped believing.
      // Making that claim tappable puts the answer where the question is.
      //
      // Only on automatic cards, and only where there is a shell to ask. A "✋ manual" badge has
      // no sensor behind it to re-read, and in a browser there is nobody to ask at all.
      auto && ctx.manualSync
        ? el("button.src.src-btn", {
            disabled: !!ctx.syncing,
            onclick: () => ctx.onSyncNow(),
            "aria-label": "Check " + (habit.name || "this habit") + " again",
            title: "Read the sensor again",
          }, src.icon, " ", src.label, el("span.src-go", "↻"))
        : el("span.src", src.icon, " ", src.label),
      // The verdict, in a word rather than a glyph on its own.
      status === HIT ? el("span.card-met", "\u2713 met") : null,
      // Pushed to the right of the row, so a card with one and a card without still line up.
      // A flame before the number, so "21" in a small hexagon reads as a run and not a rank.
      habitRun(habitStreak(ctx.state, habit.habitId, ctx.me, ctx.today), habit),
    ),
    // One way in, named for what it actually asks for. A puff count is read off the device and
    // typed, so "Enter today's count" is the instruction; a watch metric is already filled in and
    // only needs an override; everything else is just a log.
    //
    // Sleep is the exception, and it has no button at all. Nobody knows how long they slept to the
    // minute — that is the whole reason it is measured rather than asked — so an override here is a
    // guess replacing a measurement, and a worse number wearing the same badge. It comes from the
    // watch, or from how long the phone was left alone, or it says "waiting for data" and waits.
    // On a habit a sensor feeds, the override shows only while the sensor is silent. Somebody
    // with a watch does not need "Enter it manually" under a number the watch just wrote — and
    // asked not to see it; the day it stops writing, the button is back. The habit's own sheet
    // still has the way in for the rarer case of a sensor that reported the wrong number.
    typedByHand && !(auto && status !== NO_DATA)
      ? el("button.logbtn", { onclick: () => ctx.onLog(habit) },
          intervention ? "Enter today's count"
            : auto ? "Enter it manually"
            : "＋ Log")
      : null,

    // Screen time is measured by the shell, so the shell is where its dials are. They used to be a
    // tab, which put one habit's settings permanently in the navigation of an app that tracks
    // several — so they open from the habit instead, which is what they have always been about.
    PAUSE_METRICS.has(habit.metric) && ctx.focusSettings
      ? el("button.cardlink", { onclick: () => ctx.onOpenFocus() }, "Adjust limits →")
      : null,

    // Today's session from a personal program, on the Workouts card, because that is where a
    // workout is. With no program chosen the card offers to choose one; on a rest day it says so
    // and offers nothing, and "Tennis" is a rest day the program names on purpose.
    habit.metric === METRIC.SESSIONS ? workoutEntry(ctx) : null,
  );
}

/**
 * The header's chip: the ring, and beside it the name over "Level 7 · Starter". Tap for the
 * sheet. Two lines, because "Sahil · Lv 7 · Starter" on one line is a sentence and this is a
 * name badge — and because the right side of the header has a menu button to share with.
 */
function levelChip(ctx) {
  const life = lifetime(ctx.state, ctx.me, ctx.today);
  const name = (ctx.state.members.get(ctx.me) || {}).name || "You";
  return el("button.lvl-chip", {
    onclick: () => ctx.onLevel(),
    title: life.banked.toLocaleString() + " " + fmt.XP + " lifetime · " + life.need.toLocaleString() + " to Level " + (life.level + 1),
    "aria-label": name + ", level " + life.level + ", " + life.title,
  },
    levelMark(life, 28, { tip: life.span ? (life.today / life.span) * 100 : 0 }),
    el("span.lvl-chip-txt",
      el("span.lvl-chip-name", name),
      el("span.lvl-chip-t", "Level " + life.level + " · " + life.title),
    ),
  );
}

/** A board row's level: a small ring with the number. */
function rowLevel(ctx, memberId) {
  const life = lifetime(ctx.state, memberId, ctx.today);
  return el("span.lvl-row", { title: "Level " + life.level + " · " + life.title }, levelMark(life, 18));
}

/** "Goal → 3 from Mon, Sep 14", or nothing. */
function pendingLine(habit, ctx) {
  const p = pendingGoal(ctx.state, habit, ctx.me, ctx.today);
  if (!p) return null;
  return el("div.card-of.is-pending",
    "Goal \u2192 " + fmt.value(habit.metric, p.target) + " from " + fmt.dayLabel(p.from));
}

/**
 * The way into today's session, or the reason there is not one.
 *
 * A primary control when there is a session, because it is the thing you came to the card to do;
 * a quiet line when there is not, because "Rest day" is information and not an action. "Choose a
 * program" is the way in the first time, and the only time the card asks anything.
 */
function workoutEntry(ctx) {
  if (!ctx.onWorkout || ctx.demo) return null;
  const program = programFor(ctx.state, ctx.me);
  if (!program) {
    return el("button.cardlink", { onclick: () => ctx.onChooseProgram() }, "Follow a program →");
  }
  const plan = planFor(program, ctx.today);
  // Always into the hub, whatever the day. The schedule suggests; the person picks. On a rest day
  // the button still says so, because a rest day is information and not a locked door.
  return el("button.tap.card-wo", { onclick: () => ctx.onWorkout() },
    plan && plan.session
      ? "Today: " + plan.session.name + " \u2192"
      : (plan ? plan.rest : "Rest") + " today \u00b7 pick a session \u2192");
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
/**
 * You are away, said on the screen you open rather than in a menu.
 *
 * Above the hero on purpose. The hero says a streak and a percentage, and during travel both are
 * frozen — held rather than earned. Without a line above them saying why, a day where nothing was
 * logged and nothing went down reads as the app having quietly stopped working.
 *
 * Also shown BEFORE it starts, because the point of booking ahead is knowing it is booked.
 */
function travelBanner(ctx) {
  const away = travelPeriod(ctx.state, ctx.me, ctx.today);
  if (!away) return null;
  const running = daysBetween(away.from, ctx.today) >= 0;
  const left = daysBetween(ctx.today, away.to) + 1;

  // Which habits the trip actually silences TODAY, asked rather than assumed.
  //
  // "Nothing counts today" is the obvious line and it is often false. A weekly or monthly habit is
  // only exempt when its WHOLE period is away — three workouts a week with one day abroad is still
  // three workouts a week — so a trip that covers a few days pauses the daily habits and leaves
  // the longer ones running. Saying otherwise on the screen somebody opens while away is how a
  // week gets lost to a promise the engine never made.
  const mine = [...ctx.state.habits.values()].filter((h) => isTracking(ctx.state, h, ctx.me));
  const still = mine.filter((h) =>
    rawDayStatus(ctx.state, h, ctx.me, ctx.today, ctx.today) !== EXEMPT);

  const headline = !running ? "Travel booked"
    : still.length === 0 ? "Away — nothing counts today"
    : "Away — " + still.map((h) => (h.name || "one habit").toLowerCase()).join(" and ")
      + (still.length === 1 ? " still counts" : " still count");

  return el("button.travel-strip" + (running ? ".is-on" : ""), {
    onclick: () => ctx.onTravel && ctx.onTravel(),
  },
    el("span.travel-mark", running ? "🌴" : "🗓"),
    el("span.travel-text",
      el("b", headline),
      el("span", running
        ? (left === 1 ? "Back tomorrow. " : left + " days left. ")
          + (still.length
            ? "Judged by the week or the month, so the trip doesn't cover them."
            : "Streaks are held where they are.")
        : fmt.dayLabel(away.from) + " to " + fmt.dayLabel(away.to)),
    ),
    el("span.travel-go", "→"),
  );
}

/**
 * What each habit is worth today, in points, and what it has earned of that so far.
 *
 * ---- Why this is the change that makes it a game ----
 *
 * The engine has always known these numbers and never shown one. A category's share, divided by
 * the habits in it, is exactly what one of those habits can put on the day — 47 for Core fitness
 * over two habits is 23.5 each — and the habit's own score says how much of that it has taken.
 * Without it the loop was "do things, then see a number": the reward was computed afterwards and
 * shown as an aggregate, which teaches nothing about which thing moved it.
 *
 * With it, a card is an offer rather than a status. "Worth 23 today" before you act; "18 of 23"
 * as you go. The contingency is visible, which is the one thing habit formation actually runs on.
 *
 * Earned is capped at the worth, like the category is capped at its share: the bonus is banked
 * beside it, not inside it, so a habit never reads as "26 of 23".
 */
function dayHero(ctx, scored, model) {
  const streak = onGoalStreak(ctx.state, ctx.me, ctx.today);
  const pct = Math.round(scored.pct || 0);
  const bonus = Math.round(scored.bonus || 0);

  return el("section.sec",
    el("div.hero",
      el("div.hero-head",
        // The badge replaces the flame once there is one. A flame beside a Gold badge is two
        // decorations competing to say the same thing, and the badge says it better.
        tierBadge(streak, "lg")
          || el("div.hero-mark" + (streak > 0 ? ".is-lit" : ""), streak > 0 ? "🔥" : "·"),
        el("div.hero-run",
          streak > 0
            ? el("div.hero-streak", el("b", String(streak)), el("span", streak === 1 ? " day" : " days"))
            : el("div.hero-none", "Start your streak"),
          el("div.hero-sub", streak > 0
            ? tierLine(streak)
            : "meet every goal today to begin"),
        ),
      ),
      // The day's total, in the same unit as the three lines that add up to it.
      //
      // It said "66%" directly above "29 of 47", "19 of 35" and "18 of 18" — three numbers that
      // sum to exactly 66, out of three that sum to exactly 100. One screen, one quantity, two
      // units, and the reader left to spot that a percentage and a points total are the same
      // thing here. They are: the day is renormalised to be worth exactly a hundred, so a
      // percentage of it IS its points. Saying so costs one word and closes the arithmetic.
      el("div.hero-row",
        el("span", "Today, across everything"),
        el("span.hero-pct" + (pct >= 100 ? ".is-hit" : ""),
          pct + " of 100",
          el("span.row-unit", " " + fmt.XP),
          // Beside the total, never inside it. The day is worth exactly a hundred; this is what
          // beating the targets earned on top.
          bonus > 0 ? el("span.row-bonus", " +" + bonus) : null,
        ),
      ),
      el("div.bar", { role: "presentation" }, el("i", { style: "width:" + Math.min(100, pct) + "%" })),

      // The distance to a perfect day, said as a number to close rather than a percentage reached.
      //
      // Proximity to a target reliably increases effort, and "66%" hides the distance while
      // "34 to go" names it. The whole point of a day being worth exactly a hundred is that the
      // gap is a number somebody can picture — and the cards below each say what they are worth,
      // so it is also a number they can see how to close.
      // A single, positive micro-copy line: the gap to a perfect day, and nothing about what went
      // wrong. The long "no bonus this week, you missed three days, the N XP don't count" sentence
      // that used to sit here is exactly the demotivating point-recalculation the redesign removes
      // from the hero — the score itself already reflects it.
      scored && scored.scored
        ? el("p.hero-gap" + (pct >= 100 ? ".is-hit" : ""),
            pct >= 100 ? "A perfect day." : model.hero.awayXp + " " + fmt.XP + " away from a perfect day.")
        : null,

      // The category bars, compressed to one row each — see attributeBars. Only the categories that
      // actually count today; an empty one is dropped in the model, not explained away in a sentence.
      attributeBars(model.attributes),
    ),
  );
}

/**
 * The three attribute bars, compressed: icon, name, a thin track and the number inline on one row.
 *
 * Was two stacked rows per category plus a paragraph naming the ones that don't count today. The
 * model hands us only the categories that DO count (an empty one is hidden, not narrated), so this
 * is just the live ones, each on a single line.
 */
function attributeBars(attributes) {
  if (!attributes || !attributes.length) return null;
  return el("div.hero-cats",
    attributes.map((a) => {
      const tone = a.pct >= 100 ? " is-hit" : a.pct < 50 ? " is-poor" : "";
      return el("div.hero-cat",
        el("span.hero-cat-icon", CATEGORY_ICON[a.category]),
        el("span.hero-cat-name", CATEGORY_LABEL[a.category]),
        el("div.bar" + tone, { role: "presentation" }, el("i", { style: "width:" + Math.min(100, a.pct) + "%" })),
        el("span.hero-cat-num" + tone, a.points + " of " + a.offered),
      );
    }),
  );
}

/**
 * What the streak has earned, and what it is walking towards.
 *
 * "18 days" is a fact somebody already knows — they can see the number above it. "Two days to
 * Silver" is the same fact with a reason to log tonight attached, which is the whole of what a
 * milestone is for.
 */
function tierLine(streak) {
  const held = tierFor(streak);
  const next = nextTier(streak);
  if (!next) return held ? held.name + " — every habit, on goal" : "every habit, on goal";
  const away = next.away === 1 ? "1 day" : next.away + " days";
  return (held ? held.name + " · " : "") + away + " to " + next.tier.name;
}


/**
 * What a monthly goal can honestly say mid-month.
 *
 * Two lines and no pace: the shortfall, and the fact that the month is still open. The second one
 * is not reassurance, it is the actual scoring rule — a month still running is not judged, and a
 * month that ends short is judged on every one of its days at once.
 */
function monthlyLines(habit, value, target, ctx) {
  const short = Math.max(0, target - (value || 0));
  const key = periodKey(ctx.today, habit.period);
  const end = periodEnd(key, habit.period);
  const left = Math.max(0, daysBetween(ctx.today, end));

  return [
    el("div.card-of",
      short > 0
        ? fmt.value(habit.metric, short) + " to go this month"
        : "Done — " + fmt.value(habit.metric, value || 0) + " of " + fmt.value(habit.metric, target)),
    el("div.card-foot.card-month",
      left === 0 ? "Last day — counts tonight"
        : short <= 0 ? (left === 1 ? "1 day left" : left + " days left")
        // Said plainly, because an empty bar on the 4th otherwise reads as a fortnight of failure.
        : (left === 1 ? "1 day left" : left + " days left") + " · counts when the month ends"),
  ];
}

/**
 * The badge a streak has earned, or nothing.
 *
 * Drawn rather than emoji, for two reasons. A medal emoji renders as a different object on every
 * phone in the group — which is the one place in this app three people must be looking at the same
 * thing — and it cannot carry the number, so the badge would say "you have one" without saying
 * which. This says both in about sixteen pixels.
 *
 * `size` is a class, not a measurement: the board row and the day hero want the same object at two
 * scales, and passing pixels around is how those two drift apart.
 */
/**
 * One habit's own streak, as a pip on its card.
 *
 * Deliberately the lesser object. It shares the four colours with the major badges so the two read
 * as one system, and differs in every other way: a flat disc rather than struck metal, a ring
 * rather than a gradient, sixteen pixels rather than twenty-two, and no name. Somebody glancing at
 * a board row and a habit card should never have to work out which of the two is the bigger deal.
 *
 * It stays quiet about rank on purpose. The majors are called Bronze through Diamond and get
 * announced by name; a habit pip claiming the same words would mean "Gold" was fifty days of
 * everything in one place and sixty days of steps in another.
 */
function habitPip(run, habit) {
  const level = habitLevel(run, habit.period);
  if (!level) return null;
  return el("span.pip.pip-" + LEVEL_KEY[level], {
    title: run + " in a row — " + (habit.name || "this habit"),
  }, String(run));
}

/** The run, flame and pip together: 🔥 then the tiered number. Nothing until the first tier. */
function habitRun(run, habit) {
  const pip = habitPip(run, habit);
  if (!pip) return null;
  return el("span.card-run", { "aria-label": run + " in a row" }, el("span.card-run-fire", "\u{1F525}"), pip);
}

function tierBadge(streak, size = "") {
  const tier = tierFor(streak);
  if (!tier) return null;
  // Three digits in a 22px hexagon is a smudge. The number keeps its own size rather than the
  // badge growing, because a row of badges that are different widths stops reading as a set.
  const wide = String(streak).length > 2 ? ".badge-wide" : "";
  return el("span.badge.badge-" + tier.key + (size ? ".badge-" + size : "") + wide, {
    title: tier.name + " — " + tier.earned + " with every habit on goal",
  },
    // The face is a second element because a clipped box cannot take a border, and the rim is what
    // separates a struck medal from a coloured shape. See the badge rules in app.css.
    el("span.badge-face", el("span.badge-n", String(streak))),
  );
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

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function boardTab(ctx) {
  const members = [...ctx.state.members.keys()];
  if (!members.length) return emptyState(ctx);

  const from = addDays(ctx.today, -(isoDayOfWeek(ctx.today) - 1)); // Monday of this week
  const rows = leaderboard(ctx.state, members, from, ctx.today, ctx.today);
  const filter = ctx.boardCategory || null;

  // Habits nobody has ever missed, worked out once for the whole board rather than per row.
  //
  // It walks each habit's whole record, so three members is three passes per paint and thirty
  // would be thirty. Measured at six months of three people on six habits: 7ms a member. Fine
  // here, and the reason it is hoisted rather than called inside boardRow.
  const unbroken = new Map(members.map((m) => [m, neverMissed(ctx.state, m, ctx.today)]));

  // Only the categories somebody in the group is actually running. A filter for a category nobody
  // tracks is a tab that leads to an empty screen and a question about whether it is broken.
  const live = CATEGORY_ORDER.filter((c) => [...ctx.state.habits.values()].some(
    (h) => h.scored && categoryOf(h) === c,
  ));

  const ranked = filter
    ? rows
        .map((r) => {
          // Every number on a filtered row has to be the CATEGORY's. It used to swap in the
          // category's rate and leave the week's XP where it was, so "Core fitness" showed the
          // whole week's 581 with "89 a day" under it — two different weeks in one row. Now the
          // XP, the scale, the days and the habits underneath are all this category's, and the
          // rows rank on that XP the way the overall board ranks on its own.
          const only = categoryOver(ctx.state, r.memberId, from, ctx.today, filter, addDays);
          return {
            ...r,
            pct: only.pct,
            points: only.points,
            bonusPoints: only.bonus,
            offered: only.offered,
            scoredDays: only.days,
            eligible: only.days,
            hits: null,
            noData: null,
            spentTokens: 0,
            streak: 0,
            perHabit: (r.perHabit || []).filter((h) => {
              const habit = ctx.state.habits.get(h.habitId);
              return habit && categoryOf(habit) === filter;
            }),
            filtered: true,
          };
        })
        .sort(rankCompare)
        .map((r, i) => ({ ...r, rank: i + 1, crown: false }))
    : rows;

  if (ctx.boardView === "season") return seasonSection(ctx, members);
  if (ctx.boardView === "awards") return awardsSection(ctx);

  return el("section.sec",
    boardTabs(ctx),
    live.length > 1 ? el("div.chips.chips-tight",
      el("button.chip" + (!filter ? ".on" : ""), {
        onclick: () => ctx.onBoardCategory(null),
      }, "Overall"),
      live.map((c) => el("button.chip" + (filter === c ? ".on" : ""), {
        onclick: () => ctx.onBoardCategory(c),
        title: CATEGORY_LABEL[c],
      }, CATEGORY_ICON[c] + " " + CATEGORY_SHORT[c])),
    ) : null,
    filter ? el("p.sec-note", { style: "padding:0 2px" },
      CATEGORY_LABEL[filter] + " only: the " + fmt.XP + " this category earned each day, of the share of the day it was worth.") : null,
    seasonStrip(ctx),
    el("div.board", ranked.map((r) => boardRow(r, ctx, unbroken.get(r.memberId)))),
    seasonBeacon(ctx),
    el("p.sec-note", { style: "padding:0 2px" },
      // Asked directly: why is the week a percentage when a day is points? Because it is an
      // AVERAGE rather than a total, and an average shown as "85 pts" beside a season's "173 pts"
      // would be two different kinds of number wearing one unit. It is the same currency though,
      // and that is the sentence that was missing.
      // Only the week view reaches this line — season and awards return above it — so it is
      // written for the week rather than branching on a view it can never be asked about.
      "Each day is worth 100 " + fmt.XP + " and the week is the total, out of 700. Beating your goals "
      + "earns bonus on top, shown beside it and never inside it. A day you did not play earns "
      + "nothing — a rest day, travel, or a sensor that said nothing all add zero, so showing up "
      + "is worth " + fmt.XP + " on its own."),
    // The way in, directly under the numbers it explains rather than behind the menu. Somebody
    // wondering what "of 47" means is looking at the board when they wonder it.
    ctx.onScoring
      ? el("button.link", { onclick: () => ctx.onScoring() }, "How scoring works →")
      : null,
    whatIfPanel(ranked, ctx),
    offBoardNote(ctx),
    // What the group did lately. It was the foot of Today, where it was the one thing on the
    // screen not about you; here it is under the standings it explains.
    activitySection(ctx),
  );
}

/**
 * Where the season is, on the screen people actually look at.
 *
 * A leaderboard with no dates on it is a leaderboard measuring nothing in particular. The three
 * facts that make it a contest — when it began, when it finishes, how long is left — were derivable
 * and shown nowhere, so "how long have we got" had no answer.
 *
 * The bar moves by DAYS rather than by completed weeks. A bar that only advances on Mondays sits
 * still for six days at a time, which reads as broken rather than as patient.
 *
 * Nothing at all for a season with no end: a countdown to nothing is worse than no countdown, and
 * the dates alone would imply a finish line that does not exist.
 */
function seasonStrip(ctx) {
  const p = seasonProgress(ctx.state, ctx.today);
  if (!p || !p.end) return null;

  // A button, because this is now the way into the season list — and the only reliable way into
  // starting one. The link at the foot of the All-time view vanished whenever a season was booked
  // and not yet running, which left a group with no entry point anywhere.
  const next = fmt.seasonNext(p);
  return el("button.season-strip" + (p.ended ? ".is-over" : ""), {
    onclick: () => ctx.onSeasons && ctx.onSeasons(),
    "aria-label": "Seasons",
  },
    // Named and numbered, because a strip of dates with a bar under it reads as the week — and
    // this one can run from the 20th to the 19th, which no week does.
    el("div.season-strip-top",
      el("span.season-strip-dates",
        el("span.season-strip-k", p.index ? "Season " + p.index : "Season"),
        fmt.dayLabel(p.start), " → ", fmt.dayLabel(p.end)),
      el("span.season-strip-left", fmt.seasonLeft(p), el("span.season-strip-go", " ›")),
    ),
    el("div.bar", { role: "presentation" },
      el("i", { style: "width:" + p.pct + "%" })),
    // What follows. Under a schedule the next season starts by itself, and a season that begins
    // with nobody pressing anything is a season nobody was warned about otherwise. Between
    // hand-started seasons, this is the one place that says nothing is coming.
    el("div.season-strip-next", next || (p.ended ? "Nothing follows until somebody starts the next one." : null)),
  );
}

/**
 * The one thing worth doing before any of this counts, put where it can be seen.
 *
 * It lived two taps deep — Board, then All time, then a quiet link at the bottom — which is a fine
 * place for it once a season is running and a terrible one before the first has ever started. "I
 * don't see it on the leaderboard" is the correct reaction to a control nobody would find.
 *
 * ---- Why it retires itself ----
 *
 * It shows only until a season has been started, and never again. A permanently twinkling button
 * that wipes the standings is an invitation to wipe them, and the sort of thing somebody presses on
 * a Tuesday to see what it does. Once there is a line, the quiet link in the All-time view is the
 * right home for it — the same control, in the place you go when you have decided the standings are
 * not worth keeping.
 *
 * Nothing here is destructive on its own: it opens a sheet that asks when, and dismissing that
 * sheet resolves to no. The animation is drawing an eye to a question, not to a trigger.
 */
function seasonBeacon(ctx) {
  if (!ctx.onSchedule) return null;
  // Started once, gone for good — by schedule or by hand.
  const meta = ctx.state.meta || {};
  if ((meta.seasonRules && meta.seasonRules.length) || meta.seasonFrom || meta.seasonCycle) return null;

  return el("button.beacon", { onclick: () => ctx.onSchedule() },
    el("span.beacon-spark", "✨"),
    el("span.beacon-text",
      el("b", "Start the first season"),
      el("span", "Sets everyone level, and a new one starts every month on its own."),
    ),
    el("span.beacon-go", "→"),
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

// ---- There used to be a second explainer here ----
//
// A collapsed "How points work" block, under the week's standings, beside a link to the scoring
// sheet that explains the same rules. Two explanations of one engine is how one of them ends up
// wrong: this one still said "a week is the average of its days" a commit after the week became
// a total. The scoring sheet is the one place now, and it is the one linked above.

/**
 * The long game: every completed week has a winner, and the crowns stack up.
 *
 * A weekly board resets every Monday, which is fair and forgettable — nothing carries, so a
 * brilliant February is worth exactly as much as last week. Points are the number that makes it a
 * season: they only ever go up, one bad week cannot dent them, and they reward whoever kept
 * showing up over whoever had a single enormous fortnight.
 */
function seasonSection(ctx, members) {
  const where = seasonProgress(ctx.state, ctx.today);
  const { weeks, days, rows } = seasonTally(ctx.state, members, ctx.today);

  return el("section.sec",
    boardTabs(ctx),
    // The same strip, on the view it is actually about. Full width now rather than squeezed beside
    // a heading — the selected tab already says "All time", so the heading was saying it twice.
    seasonStrip(ctx),
    days === 0
      ? el("p.sec-note", { style: "padding:0 2px" },
          "Nothing to tally yet — the first day has to close. This week's board is still live.")
      // The rank NUMBER, not a crown. The season is ranked on points now, so its leader may
      // have won no weeks at all — and 👑 means "won a week" everywhere else in this app.
      // Putting it on the season leader would be two different claims wearing one symbol.
      : el("div.board", rows.map((r) => el("article.row" + (r.memberId === ctx.me ? ".is-me" : "")
          + (r.rank === 1 ? ".is-crown" : ""),
          el("div.row-rank", String(r.rank)),
          el("div.row-main",
            el("div.row-name", r.memberId === ctx.me ? "You" : r.name),
            el("div.row-meta",
              // Days first: every season has them, and a six-day run-in to the 20th has no
              // week in it to have won.
              r.days + " of " + days + (days === 1 ? " day" : " days") + " played",
              weeks
                ? " · " + (r.crowns
                  ? "👑 " + r.crowns + (r.crowns === 1 ? " week won" : " weeks won")
                  : "no weeks won") + " of " + weeks
                : "",
              r.crownStreak > 1 ? " · 🔥 " + r.crownStreak + " in a row" : "",
            ),
            el("div.row-meta",
              // "a day", the way the week's row says it. It was "a week", and a season that runs
              // from the 20th to the 19th has no honest week to average by.
              r.avg === null ? "nothing scored yet" : "averaging " + r.avg + " a day",
              r.best ? " · best week " + r.best.pct : "",
              r.bonus ? " · " + r.bonus + " from bonus" : "",
            ),
          ),
          el("div.row-pct", String(r.points), el("span.row-unit", " " + fmt.XP)),
        ))),
    days > 0 ? el("p.sec-note", { style: "padding:0 2px" },
      "Every day you play adds its score to your total, so the season is won on " + fmt.XP + " rather "
      + "than on a handful of Sundays — and bonus " + fmt.XP + ", which only come from beating a goal "
      + "rather than meeting it, are how somebody behind closes a gap. Whole weeks, Monday to Sunday, "
      + "have a winner; crowns break a tie. "
      + days + (days === 1 ? " day" : " days")
      + (weeks ? " and " + weeks + (weeks === 1 ? " whole week" : " whole weeks") : "")
      + " counted so far.") : null,

    // What comes next, and that it comes by itself.
    //
    // Under a schedule the next season is always booked, and saying so here — under the standings
    // it will reset — is what stops the morning it happens from being a surprise. Booked by hand,
    // it is the answer to "did the button work".
    where && where.next
      ? el("p.sec-note", { style: "padding:0 2px" },
          fmt.seasonNext(where) + " These standings run until then, and reset that morning.")
      : null,
    // Always offered. Somebody who has booked a season is exactly the person most likely to want
    // to change it, and replacing the only control with an explanation left them nowhere to go.
    ctx.onSeasons
      ? el("button.link.sec-note", { onclick: () => ctx.onSeasons() }, "Seasons →")
      : null,
  );
}

/**
 * The board's three destinations, as one control.
 *
 * It used to be a single "All time →" link that turned into "← This week", which works for exactly
 * two views and quietly stops working at three: a link that toggles cannot say where you ARE, only
 * where it will take you. Chips say both.
 *
 * The case sits here rather than in a sheet because it belongs to the same question as the other
 * two — how everybody is doing — and a sheet opened from somewhere else is a different room.
 */
function boardTabs(ctx) {
  const views = [["week", "This week"], ["season", "All time"], ["awards", "Awards"]];
  return el("div.board-tabs",
    views.map(([id, label]) => el("button.chip" + (ctx.boardView === id ? ".on" : ""), {
      onclick: () => ctx.onBoardView(id),
    }, label)),
  );
}

/**
 * Everything that can be won, and how often it has been.
 *
 * Was a sheet. Moved here because it answers a board question and belongs beside the standings it
 * is earned from — see awards.js for why these are counts rather than ticks.
 */
function awardsSection(ctx) {
  const { major, habits, earned } = awards(ctx.state, ctx.me, ctx.today);
  const streak = onGoalStreak(ctx.state, ctx.me, ctx.today);
  const held = tierFor(streak);
  const next = nextTier(streak);
  const unit = { day: "days", week: "weeks", month: "months" };
  const runLabel = (n, period) => {
    const many = unit[period] || unit.day;
    return n + " " + (n === 1 ? many.slice(0, -1) : many);
  };

  return el("section.sec",
    boardTabs(ctx),

    el("div.case-now",
      held
        ? el("span.badge.badge-lg.badge-" + held.key,
            el("span.badge-face", el("span.badge-n", String(streak))))
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
      earned ? el("span.case-tally", earned === 1 ? "1 won" : earned + " won") : null,
    ),

    earned === 0
      ? el("p.case-count", "Nothing won yet. Every badge below is still on the table.")
      : null,

    el("h2.sec-title", "Every habit, on goal"),
    el("div.case-major", major.map((t) => el("div.case-slot" + (t.times ? "" : ".is-locked"),
      el("span.badge.badge-" + t.key, { title: t.name + " — " + t.earned },
        el("span.badge-face", el("span.badge-n", String(t.at)))),
      el("span.case-name", t.name),
      t.times > 1 ? el("span.case-times", "×" + t.times) : null,
    ))),
    el("p.note-inline",
      "Won by meeting every category you were asked about, every day. The group is told when you "
      + "reach one."),

    habits.length ? el("h2.sec-title", "One habit at a time") : null,
    habits.map((h) => el("div.case-habit",
      el("div.case-habit-head",
        el("span.case-habit-icon", h.icon),
        el("span.case-habit-name", h.name),
        el("span.case-habit-run", h.streak ? runLabel(h.streak, h.period) : "no run"),
      ),
      el("div.case-pips", h.levels.map((l) => el("div.case-slot" + (l.times ? "" : ".is-locked"),
        // The same medal the majors are struck from, not a ring with a number in it.
        //
        // These were `.pip`: a small outlined circle. Asked directly — "is the 14 30 60 120 the
        // badge, or just telling me what's needed?" — which is the question failing at its job,
        // because a badge somebody has to ask about is a label. One family now: same hexagon, same
        // metals, same empty socket when it has not been won.
        el("span.badge.badge-md.badge-" + LEVEL_KEY[l.level]
          + (String(l.at).length > 2 ? ".badge-wide" : ""),
          { title: runLabel(l.at, h.period) },
          el("span.badge-face", el("span.badge-n", String(l.at)))),
        el("span.case-name", l.span),
        l.times > 1 ? el("span.case-times", "×" + l.times) : null,
      ))),
    )),
    habits.length
      ? el("p.note-inline", "Yours alone — these are never announced to the group.")
      : null,
  );
}

/**
 * What dropping each person's worst day would do to this week.
 *
 * ---- Why this is a question and not a change ----
 *
 * Asked for: "show me what dropping the worst day does to this week." It cannot be answered in the
 * abstract, and not because the rule is complicated — because the answer depends on the SHAPE of
 * the week, which the week's own percentage hides. 85% is seven days at 85, where dropping the
 * worst does nothing, or six at a hundred and one at zero, where it does everything. The only
 * honest way to show it is against real days.
 *
 * So it is drawn as a comparison, in the quiet colour, under the standings it is not part of. A
 * preview of a rule the group has not adopted, clearly marked as one, and deletable in a single
 * commit if the answer is no.
 *
 * ---- The line that actually decides it ----
 *
 * Whether anybody's position moves. A rule that changes three numbers and no rankings is a rule
 * about how the week FEELS; one that reorders the board is a different proposition, and the
 * difference is the only thing worth reading here.
 */
function whatIfPanel(ranked, ctx) {
  const rows = ranked
    .map((r) => ({ row: r, alt: withoutWorstDay(r.daily) }))
    .filter((x) => x.alt && x.row.pct != null);
  // Below two people, or before anybody has two days that counted, there is nothing to compare.
  if (rows.length < 2) return null;

  // Would the order change? Ranked on the previewed number — the average with the worst day
  // dropped — and a dead heat settled by the board's own tie-break (tieBreak), so a tie does not
  // read as a reshuffle. There is no alternate points to rank on: dropping a day changes the
  // average, which is the whole preview, so the average is the key here.
  const now = rows.map((x) => x.row.memberId);
  const then = rows.slice()
    .sort((a, b) => b.alt.pct - a.alt.pct || tieBreak(a.row, b.row))
    .map((x) => x.row.memberId);
  const moves = now.some((id, i) => id !== then[i]);

  return el("details.whatif",
    el("summary.whatif-head", "What if a week dropped its worst day?"),
    el("div.whatif-body",
      rows.map((x) => el("div.whatif-row",
        el("span.whatif-name", x.row.memberId === ctx.me ? "You" : x.row.name),
        el("span.whatif-move",
          el("s", x.row.pct + "%"), " → ", el("b", x.alt.pct + "%")),
        el("span.whatif-why",
          "without " + fmt.dayLabel(x.alt.dropped.day) + ", " + x.alt.dropped.pct + "%"),
      )),
      el("p.note-inline", moves
        ? "This would reorder the board."
        : "Everybody moves up and nobody changes places — it would make the week kinder, not "
          + "different."),
      el("p.note-inline",
        "Not in force. This is what the rule WOULD do, drawn from the days you have actually "
        + "played this week."),
    ),
  );
}

/**
 * How much of this week's available points a row has taken, 0–100, for the bar.
 *
 * Available = 100 for every day of the week that has begun, whoever you are. Not "days you were
 * judged on": a league puts the same points on offer to everybody, and a day you did not appear
 * for is a day you did not score. That is the rule the total was chosen for, and the bar is where
 * it is visible — a full bar means a hundred on every day so far, not a hundred on the days that
 * happened to count.
 */
function weekShare(row, ctx) {
  if (row.pct == null) return 0;
  const daysSoFar = Math.max(1, isoDayOfWeek(ctx.today));
  return Math.min(100, Math.round((row.points / (100 * daysSoFar)) * 100));
}

/** "119 days", "12 weeks" — the run said in the habit's own unit. */
function unbrokenSpan(entry) {
  const unit = entry.period === PERIOD.WEEK ? "week"
    : entry.period === PERIOD.MONTH ? "month" : "day";
  return entry.periods + " " + unit + (entry.periods === 1 ? "" : "s");
}

function boardRow(row, ctx, unbrokenAll) {
  const classes = ["row"];
  // On a filtered board, only this category's unbroken habits belong under the row.
  const unbroken = row.filtered && ctx.boardCategory
    ? (unbrokenAll || []).filter((u) => categoryOf(u.habit) === ctx.boardCategory)
    : unbrokenAll;
  if (row.memberId === ctx.me) classes.push("is-me");
  if (row.crown) classes.push("is-crown");
  const daysSoFar = Math.max(1, isoDayOfWeek(ctx.today));
  const open = () => ctx.onWeekRow && ctx.onWeekRow(row);

  // ---- The line under the bar ----
  //
  // It said "13 of 22 goals met · 🔥 9 best run · 🛡 spent 1 · 3 not reported", and every item
  // was a number with its unit missing. Twenty-two was five habits over several days and a
  // weekly one, added into a figure nobody could reconstruct; nine was a run of ONE habit, not
  // of days; the token had no name; and the silence had no habit. Each is now a sentence with
  // its unit — and the arithmetic behind the first one is a tap away, itemised (weeksheet.js).
  const facts = [];
  if (row.pct == null) facts.push("nothing scored yet");
  else if (row.filtered) {
    facts.push(el("span", row.scoredDays + " of " + daysSoFar + (daysSoFar === 1 ? " day" : " days") + " judged"));
    // The category's habits, each as a count — the one thing a filtered row can say that the
    // overall row cannot, and the reason to filter.
    for (const h of row.perHabit || []) {
      const met = fmt.habitWeek(h);
      if (met) facts.push(el("span", h.name + " " + met));
    }
  } else {
    facts.push(el("span", row.scoredDays + " of " + daysSoFar + (daysSoFar === 1 ? " day" : " days") + " played"));
  }
  if (row.streak >= 2) {
    facts.push(el("span", "\u{1F525} " + (row.streakHabit ? row.streakHabit + ", " : "") + row.streak + " days"));
  }
  if (row.spentTokens) {
    facts.push(el("span", "\u{1F6E1} " + row.spentTokens + (row.spentTokens === 1 ? " token used" : " tokens used")));
  }
  // Silence, named by habit. "3 not reported" was three habit-days; "Steps silent 3 days" is
  // the fact the person can act on.
  const quiet = (row.perHabit || []).filter((h) => h.quiet);
  for (const h of quiet.slice(0, 2)) {
    facts.push(el("span.row-quiet", h.name + " silent " + h.quiet + (h.quiet === 1 ? " day" : " days")));
  }
  if (quiet.length > 2) facts.push(el("span.row-quiet", "and " + (quiet.length - 2) + " more"));

  return el("article." + classes.join("."), {
    onclick: (e) => { if (e.target.closest("button")) return; open(); },
    role: "button", tabindex: "0",
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
    "aria-label": (row.memberId === ctx.me ? "Your" : row.name + "\u2019s") + " week, in detail",
  },
    el("div.row-rank", row.rank),
    el("div.row-main",
      el("div.row-name",
        row.crown ? el("span.tagemoji", { title: "Top of the board" }, "\u{1F451}") : null,
        row.memberId === ctx.me ? "You" : row.name,
        // Beside the name rather than in the meta line below it. A badge is about the person, and
        // it is the one thing on this row worth seeing before the percentage.
        tierBadge(onGoalStreak(ctx.state, row.memberId, ctx.today)),
        // And the level, as a ring so it cannot be read as a second medal. Flavour, not rank: the
        // row is still ordered on the week's XP, and a later joiner's lower level costs nothing.
        rowLevel(ctx, row.memberId),
      ),
      // The bar is the share of the points available SO FAR this week that this person has taken.
      // A day is worth 100, so by Friday there have been 500 on offer; 425 of them is 85%. The
      // scale is written on it, because a bar with no scale is a shape.
      el("div.row-barline",
        el("div.row-bar", el("i", { style: "width:" + (row.filtered
          ? (row.offered ? Math.min(100, Math.round((row.points / row.offered) * 100)) : 0)
          : weekShare(row, ctx)) + "%" })),
        row.pct == null ? null : el("span.row-scale", row.points + " of " + (row.filtered ? row.offered : 100 * daysSoFar)),
      ),
      el("div.row-meta", ...facts.flatMap((f, i) => (i ? [el("span.row-sep", "\u00b7"), f] : [f]))),
    ),
    // The week's points, out of 700, which is what the row is ranked on — and beside it what
    // beating the targets earned, as its own number, exactly the way the day shows "93 of 100
    // XP +4". The average sits under the total it is the average of.
    el("div.row-pct",
      row.pct == null ? "\u2014" : String(row.points),
      row.pct == null ? null : el("span.row-unit", " " + fmt.XP),
      row.bonusPoints ? el("span.row-bonus", " +" + row.bonusPoints) : null,
      // Under the total: the rate that got you there. Overall that is XP a day; filtered it is
      // how much of what the category could pay it did, which is the number the chips show.
      row.pct == null ? null : el("span.row-avg", row.filtered ? row.pct + "% of possible" : row.pct + " a day"),
    ),

    // Which category carried the week and which sank it, each named — an icon alone asked the
    // reader to remember four pictures. The percentage says where somebody came; this says what
    // to do about it on Monday, which is the only part anybody can act on.
    //
    // Not while filtered: the row already IS one category, and repeating it underneath its own
    // percentage says the same thing twice and looks like a second, disagreeing number.
    row.pct != null && !row.filtered ? el("div.row-parts", categoryBreakdown(
      ctx.state, row.memberId, addDays(ctx.today, -(isoDayOfWeek(ctx.today) - 1)), ctx.today,
    ).map((part) => (part.judged
      ? el("span.part" + (part.pct >= 100 ? ".is-full" : part.pct < 50 ? ".is-low" : ""),
          CATEGORY_ICON[part.category] + " " + CATEGORY_SHORT[part.category] + " " + part.pct + "%")
      // Greyed rather than gone. A row showing three chips where the row above it shows four is a
      // question with no answer on the screen — and the answer is not "no data", it is "not being
      // judged yet", which is a rule working rather than a gap. A dash says waiting; an absence
      // says broken.
      : el("span.part.is-waiting", { title: CATEGORY_LABEL[part.category] + " isn't being judged yet" },
          CATEGORY_ICON[part.category] + " " + CATEGORY_SHORT[part.category] + " \u2014")))) : null,
    // A habit this person has never once missed.
    //
    // Shown, not scored — the same answer this row already gives to a silent sensor, and for the
    // same reason. A category is the mean of its habits, so one nobody can fail lifts the ones they
    // can; measured, two people failing the same real habit equally came out 50% and 57%, the
    // higher belonging to the one for whom the second habit costs nothing. Changing that
    // arithmetic would move everybody's history, so instead the group can see it.
    //
    // Deliberately neutral, and shown for everybody including you. Somebody who actually quit has
    // exactly the record of somebody who never started, and this app is in no position to tell
    // them apart — reading it as a cheat would be the worst thing it could say to the person it
    // helped most. It reports the fact. Anybody who knows the group knows which it is.
    unbroken && unbroken.length
      ? el("div.row-note",
          "Never missed \u2014 " + (unbroken[0].habit.name || "a habit")
          + " " + unbrokenSpan(unbroken[0])
          + (unbroken.length > 1 ? " \u00b7 and " + (unbroken.length - 1) + " more" : ""))
      : null,

    // The way in, said. A row that opens on a tap has to look like it does.
    ctx.onWeekRow && row.pct != null
      ? el("div.row-more", (row.memberId === ctx.me ? "Your week" : "Their week") + " \u203A")
      : null,

    // A silent sensor, said out loud and offered the fix. Only on the reader's own row: on a real
    // group with patchy Health Connect every row has one, and three amber boxes would dominate a
    // board that is supposed to be about the standings. Other rows say it in the line above.
    row.noData > 0 && row.memberId === ctx.me
      ? el("div.note",
          el("div",
            el("b", "Nothing came through from your phone"),
            " on " + row.noData + (row.noData === 1 ? " goal" : " goals")
            + " this week \u2014 those earned nothing.",
          ),
          el("button", { onclick: () => ctx.onFixSync(row) }, "Why? \u2192"),
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
  // What shows and in what order is decided in activity.js — a pure function, so the ordering (which
  // used to inherit IndexedDB's random key order and come out shuffled) is unit-tested. Here we only
  // turn each descriptor into a row.
  const today = ctx.today || (ctx.now ? new Date(ctx.now).toISOString().slice(0, 10) : null);
  return activityItems(ctx, limit).map((it) => {
    const who = it.memberId === ctx.me ? "You" : (ctx.state.members.get(it.memberId)?.name || "Someone");
    const habit = ctx.state.habits.get(it.habitId);
    if (it.kind === "goal") {
      return el("div.ev",
        el("span", "🎯"),
        el("span.ev-when", fmt.feedDayLabel(it.day, today)),
        el("span.ev-what", el("b", who), " ", goalPhrase(habit, it.payload)),
      );
    }
    return el("div.ev",
      el("span", fmt.source(it.source).icon),
      el("span.ev-when", fmt.feedDayLabel(it.day, today)),
      el("span.ev-what", el("b", who), " ", verbFor(habit, it.value, it.source), it.met ? " ✓" : ""),
    );
  });
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
