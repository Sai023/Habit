// habitdetail.js — one habit, a layer deeper.
//
// ---- Phase 1 ----
//
// The card on Today answers "where am I now". Everything behind it — whether this is a good week,
// whether the run is real, what the number usually looks like — lived only in the log. This is the
// first layer of that, and it is deliberately the layer every habit shares: the run, the window,
// and what happened in each period of it.
//
// Later phases go per-metric, because that is where the differences actually are: sleep wants the
// hours you went to bed, a taper wants its ceiling drawn coming down, savings wants one number a
// month against a target that only closes at month end. None of that belongs in a first pass, and
// all of it reads better once the shared frame exists to hang it on.
//
// ---- Why the states are drawn rather than counted ----
//
// A fortnight of bars is a shape somebody takes in at a glance, and a shape is the only honest way
// to show four states at once. "9 of 14" collapses HIT, MISS, NO_DATA and EXEMPT into two, and the
// difference between "you missed four days" and "your watch said nothing on four days" is the
// difference between a screen that is fair and one that is not.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import {
  habitHistory, historySummary, runs, trend, lifetime, byWeekday, worstWeekday, groupHistory,
  companionTotal,
} from "../history.js";
import { HABIT_TIERS, habitLevel, LEVEL_KEY } from "../milestones.js";
import { sourceFor, isTracking, HIT, MISS, NO_DATA, EXEMPT } from "../habits.js";
import { programFor, planFor, exerciseHistory } from "../workout.js";
import { AT_MOST, METRIC, PERIOD, AUTOMATIC_SOURCES } from "../schema.js";
import * as fmt from "./format.js";

/** What one period is called, in the fewest characters that stay unambiguous. */
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
  "Saturday", "Sunday"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function tick(entry) {
  const d = new Date(entry.from + "T12:00:00Z");
  if (entry.period === PERIOD.DAY) return WEEKDAY[(d.getUTCDay() + 6) % 7][0];
  if (entry.period === PERIOD.WEEK) return String(d.getUTCDate());
  return MONTH[d.getUTCMonth()][0];
}

/** The full label, for the row under the chart. */
function periodLabel(entry) {
  const d = new Date(entry.from + "T12:00:00Z");
  if (entry.period === PERIOD.DAY) {
    return WEEKDAY[(d.getUTCDay() + 6) % 7] + " " + d.getUTCDate() + " " + MONTH[d.getUTCMonth()];
  }
  if (entry.period === PERIOD.WEEK) {
    const to = new Date(entry.to + "T12:00:00Z");
    return d.getUTCDate() + " " + MONTH[d.getUTCMonth()]
      + " – " + to.getUTCDate() + " " + MONTH[to.getUTCMonth()];
  }
  return MONTH[d.getUTCMonth()] + " " + d.getUTCFullYear();
}

/**
 * The number every bar is drawn against.
 *
 * The window's biggest value, or the target if nothing reached it — so the target line always has
 * somewhere to sit and a fortnight of near-misses does not draw as a flat wall of nothing.
 */
function scaleOf(entries) {
  const top = entries.reduce((m, e) => {
    const v = Number.isFinite(e.value) ? e.value : 0;
    // The TARGET counts towards the scale too, and per period rather than once — otherwise a
    // fortnight spent well under a ceiling draws with the ceiling off the top of the chart.
    return Math.max(m, v, e.target || 0);
  }, 0);
  return top || 1;
}

/**
 * How tall a bar is: the value itself, against the window's scale.
 *
 * NOT the fraction of the target, which was the first version and read as a wall: every met day
 * pegged at 100% and identical, so a fortnight of 10 300 steps looked exactly like a fortnight of
 * 30 000. The verdict is already carried by colour; the height is free to carry the number, which
 * is the only thing on this screen that shows a good week from a scraped-through one.
 */
function height(entry, scale) {
  if (!Number.isFinite(entry.value)) return 0;
  return Math.max(3, Math.min(100, Math.round((entry.value / scale) * 100)));
}

/** "1 week", "3 weeks" — the unit pluralised with the number it belongs to. */
function count(n, unit) {
  return n + " " + unit + (n === 1 ? "" : "s");
}

/** Has the target moved across this window? Only a taper does that, and it is worth saying. */
function taperMoving(entries) {
  const targets = entries.map((e) => e.target).filter(Number.isFinite);
  return targets.length > 1 && targets[0] !== targets[targets.length - 1];
}

const TONE = {
  [HIT]: "is-hit",
  [MISS]: "is-miss",
  [NO_DATA]: "is-quiet",
  [EXEMPT]: "is-rest",
};

export function openHabitDetail(host, { state, habit, me, today, onLog, onEdit, onDone, onWorkout, onChooseProgram }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });

  const reduce = habit.direction === AT_MOST;
  const entries = habitHistory(state, habit, me, today);
  const sum = historySummary(entries);
  const run = runs(state, habit, me, today);
  const move = trend(state, habit, me, today);
  const life = lifetime(state, habit, me, today);
  const worst = worstWeekday(byWeekday(state, habit, me, today));
  const others = groupHistory(state, habit, me, today);
  // Calories, shown under Workouts when somebody is tracking them.
  //
  // The two answer the same question from opposite ends — how often you trained, and how hard —
  // and a week of workouts is a much better number with the effort inside it. Nothing is read that
  // is not already in the log: no calories habit means no line, which is exactly the "if that data
  // exists" the request asked for.
  //
  // One direction only. Workouts borrow calories; calories do not borrow workouts, because "3
  // workouts" under a daily calorie figure is a week's number under a day's and says nothing.
  const companion = habit.metric === METRIC.SESSIONS
    ? [...state.habits.values()].find(
        (h) => h.metric === METRIC.ACTIVE_CALORIES && isTracking(state, h, me),
      )
    : null;

  const src = sourceFor(state, habit, me);
  const srcLabel = fmt.source(src);
  const automatic = AUTOMATIC_SOURCES.has(src);

  // Which period the reader is looking at. The open one to begin with, because that is the one
  // they just tapped a card about.
  let picked = entries.length - 1;

  const unit = (v) => (v == null ? "—" : fmt.value(habit.metric, v));
  // What one period is called, in the sentences below. Derived from the habit and constant for the
  // life of the sheet, so it lives out here rather than inside paint where only paint could see it.
  const label = habit.period === PERIOD.DAY ? "day"
    : habit.period === PERIOD.WEEK ? "week" : "month";

  function chart() {
    const scale = scaleOf(entries);
    const now = entries[entries.length - 1];

    // The goal is drawn PER BAR, at that period's own target.
    //
    // Phase one drew one line across the chart at habit.target, which is wrong twice over. That
    // field is the group's SEED — the number a new joiner inherits — so anybody who had set a goal
    // of their own saw a line at somebody else's number, and every bar was judged against it by
    // eye while the colours were judged against the real one. And a tapering ceiling MOVES: one
    // flat line cannot show a ceiling coming down, which is the entire point of a taper.
    return el("div.hd-chart-wrap",
      el("div.hd-chart",
        // The verdict goes on the COLUMN as well as on the fill. A day with nothing recorded has
        // no height to carry it — the whole track is hatched instead, which says absent rather
        // than "very nearly zero", and those are not the same day.
        entries.map((e, i) => el("button.hd-bar"
          + (TONE[e.status] ? "." + TONE[e.status] : "")
          + (i === picked ? ".is-picked" : ""), {
          onclick: () => { picked = i; paint(); },
          "aria-label": periodLabel(e),
        },
          el("i.hd-bar-fill." + (TONE[e.status] || "is-quiet"),
            { style: "height:" + height(e, scale) + "%" }),
          e.target
            ? el("i.hd-bar-goal" + (reduce ? ".is-ceiling" : ""), {
                // Capped just below the top rather than at it. The bar clips its overflow so the
                // fill keeps its rounded corners, and a marker sitting exactly ON the edge is
                // clipped with it — which hid the ceiling on every period that set the scale.
                style: "bottom:" + Math.min(98, Math.round((e.target / scale) * 100)) + "%",
              })
            : null,
        )),
      ),
      el("div.hd-ticks", entries.map((e) =>
        el("span.hd-tick" + (e.open ? ".is-now" : ""), tick(e)))),
      el("p.hd-scale" + (reduce ? ".is-ceiling" : ""),
        (reduce ? "Ceiling " : "Goal ") + unit(now ? now.target : habit.target)
        + (taperMoving(entries) ? " — coming down" : "")),
    );
  }

  /** The period the reader has picked, said in full. */
  function detail() {
    const e = entries[picked];
    if (!e) return null;
    const verdict = e.open ? "still running"
      : e.status === HIT ? (reduce ? "under" : "met")
      : e.status === MISS ? (reduce ? "over" : "short")
      : e.status === EXEMPT ? "rest day"
      : automatic ? "nothing came through" : "not logged";

    return el("div.hd-detail",
      el("div.hd-detail-top",
        el("span.hd-detail-when", periodLabel(e)),
        el("span.hd-detail-verdict." + (TONE[e.status] || "is-quiet"), verdict),
      ),
      el("div.hd-detail-num",
        el("b", unit(e.value)),
        e.target ? el("span", (reduce ? " of " : " of ") + unit(e.target)) : null,
      ),
      companionLine(e),
    );
  }

  /**
   * The other habit's number for the same stretch of days.
   *
   * Under the verdict rather than beside it, and in the quiet style, because it is context and not
   * a target — nobody passes or fails this line. Silent when the sensor was silent: a week with no
   * calories reported is not a week of burning none, and drawing a zero there would be inventing
   * a number rather than reporting one.
   */
  function companionLine(e) {
    if (!companion) return null;
    const burned = companionTotal(state, companion, me, e.from, e.to);
    if (burned == null) return null;
    return el("p.hd-extra",
      el("span.hd-extra-icon", companion.icon || "🔥"),
      fmt.value(METRIC.ACTIVE_CALORIES, Math.round(burned)) + " burned over "
        + (e.period === PERIOD.DAY ? "the day" : "these " + (daysIn(e) + " days")),
    );
  }

  /** How many days the picked period covers, so the line can say what it is totalling. */
  function daysIn(e) {
    const [y1, m1, d1] = e.from.split("-").map(Number);
    const [y2, m2, d2] = e.to.split("-").map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
  }

  /**
   * Your program, exercise by exercise, on the Workouts habit only.
   *
   * Every exercise the program defines, in program order, with its last few sessions as
   * "10 · 10 · 9" chips — the sets as they were done, so the progression the program is asking
   * for is visible as a row rather than inferred from a number. The most recent session's total
   * is compared with the one before it, and said in a word.
   *
   * Exercises not yet done are listed too, quietly. A history that only shows what has happened
   * cannot show what is still to come, and "not yet" beside a name is the honest state.
   */
  function programSection() {
    if (habit.metric !== METRIC.SESSIONS) return null;
    const program = programFor(state, habit && me ? me : null);
    if (!program) {
      return onChooseProgram
        ? el("div.hd-program",
            el("h2.sec-title", "Your program"),
            el("p.note-inline", "Follow a program and today's session shows on the Workouts card, "
              + "with every set you bank kept here."),
            el("button.tap.tap-quiet", { onclick: () => { sheet.close(); onChooseProgram(); } },
              "Follow a program"),
          )
        : null;
    }
    const plan = planFor(program, today);
    const rows = exerciseHistory(state, me, program);
    const SHOW = 5;

    return el("div.hd-program",
      el("h2.sec-title", program.name),
      el("div.hd-program-today",
        el("span", plan && plan.session ? "Today: " + plan.session.name : "Today: " + ((plan && plan.rest) || "rest")),
        plan && plan.session && onWorkout
          ? el("button.link", { onclick: () => { sheet.close(); onWorkout(); } }, "Open →")
          : null,
      ),
      el("div.hd-exlist", rows.map((r) => {
        const recent = r.sessions.slice(-SHOW);
        const last = r.sessions[r.sessions.length - 1];
        return el("div.hd-exrow",
          el("div.hd-exrow-head",
            el("span.hd-exrow-name", r.name),
            r.trend
              ? el("span.hd-exrow-trend." + r.trend,
                  r.trend === "up" ? "↑ up" : r.trend === "down" ? "↓ down" : "= same")
              : null,
          ),
          recent.length
            ? el("div.hd-exrow-sets", recent.map((ses) => el("span.hd-exchip" + (ses === last ? ".is-last" : ""),
                { title: fmt.dayLabel(ses.day) },
                r.unit === "rounds"
                  ? ses.sets[0] + " × " + ses.work + "s"
                  : ses.sets.join(" · "))))
            : el("span.hd-exrow-none", "not yet"),
          last
            ? el("span.hd-exrow-total",
                r.unit === "rounds" ? last.total + " rounds"
                  : last.total + (r.unit === "s" ? "s" : " " + r.unit) + " last time")
            : null,
        );
      })),
      onChooseProgram
        ? el("button.link", { onclick: () => { sheet.close(); onChooseProgram(); } }, "Change program")
        : null,
    );
  }

  /**
   * The four badges this habit can win, and how far the run has got.
   *
   * The same ladder the awards case draws, on the screen where the number it is counting actually
   * lives — a streak of six means nothing until you can see that fourteen is the first rung.
   */
  function ladder() {
    const tiers = HABIT_TIERS[habit.period] || HABIT_TIERS.day;
    const level = habitLevel(run.best, habit.period);
    const next = tiers.find((t) => run.current < t.at);

    return el("div.hd-ladder",
      el("h2.sec-title", "Badges for this habit"),
      // Every rung is drawn, won or not — the same rule the Awards tab follows. A ladder you
      // cannot see the top of is not a ladder, and a badge nobody knows exists is not a target.

      el("div.hd-rungs", tiers.map((t, i) => el(
        "div.hd-rung" + (i < level ? ".is-won" : ""),
        el("span.badge.badge-md.badge-" + LEVEL_KEY[i + 1]
          + (String(t.at).length > 2 ? ".badge-wide" : ""),
          el("span.badge-face", el("span.badge-n", String(t.at)))),
        el("span.hd-rung-span", t.span),
      ))),
      next
        ? el("p.note-inline",
            // "8 more days", not "8 days more" — count() puts the unit next to its number, which
            // is right everywhere else on this screen and wrong in front of "more".
            (next.at - run.current) + " more " + label
            + (next.at - run.current === 1 ? "" : "s")
            + " without a miss for " + next.span + ".")
        : el("p.note-inline", "Every badge for this habit is won."),
    );
  }

  /**
   * Everybody doing this habit, over the same window.
   *
   * What each row may say is each person's own choice — see groupHistory, which puts every value
   * through the same publicValue the activity feed uses. The COUNT of days met is shown for
   * everybody, because that is exactly what "Just ✓ / ✗" permits and it is the whole point of a
   * shared board; only the figure is gated.
   *
   * Not drawn for one person. A comparison of you against nobody is a heading and a row.
   */
  function group() {
    if (others.length < 2) return null;

    // What the two numbers on each row ARE.
    //
    // "1/6" over "5 825" was two unlabelled figures stacked on each other, and both were being
    // read as something they are not. The fraction's denominator is the periods that COUNTED,
    // which is why it does not match the fourteen bars above it — rest days and days a sensor
    // said nothing are not in it. And the figure underneath is an AVERAGE across those periods,
    // which everybody reads as today's number.
    const span = habit.period === PERIOD.DAY ? "days"
      : habit.period === PERIOD.WEEK ? "weeks" : "months";

    return el("div.hd-group",
      el("h2.sec-title", "Everyone on this"),
      el("p.note-inline",
        "The " + span + " each person met their own goal, out of the " + span + " that counted — "
        + "rest " + span + " and ones with nothing from a sensor are left out."),
      el("div.hd-people", others.map((r) => el("div.hd-person" + (r.isMe ? ".is-me" : ""),
        el("span.hd-person-name", r.isMe ? "You" : r.name),
        el("span.hd-person-bar",
          el("i", { style: "width:" + Math.round(r.rate * 100) + "%" })),
        el("span.hd-person-num",
          r.hits + "/" + r.judged,
          // Their number, their percentage, or nothing — whichever they chose to share.
          //
          // Said to be an average, every time it is shown. It is the mean across the periods that
          // counted, and without the word it reads as today's figure, or their latest, or their
          // best — three different numbers, none of them this one.
          r.shown && "value" in r.shown
            ? el("span.hd-person-sub", "avg " + unit(Math.round(r.shown.value)))
            : r.shown && "pct" in r.shown
              ? el("span.hd-person-sub", "avg " + r.shown.pct + "% of goal")
              : null,
        ),
      ))),
      // Said once, so a row with no number reads as a choice rather than as missing data.
      others.some((r) => !r.shown)
        ? el("p.note-inline",
            "Some of these show ticks only — everyone picks what the group sees of their numbers.")
        : null,
    );
  }

  function paint() {
    // The target in force right now, which is what a header should quote.
    const latest = entries[entries.length - 1];
    const mine = latest && Number.isFinite(latest.target) ? latest.target : habit.target;

    sheet.paint(
      // .hd carries this screen's panel colour. Every tile inside used to be painted --surface,
      // which is the sheet's OWN background, so none of them were visible at all.
      el("div.form.hd",
        el("div.hd-head",
          el("span.hd-icon", habit.icon || "◆"),
          el("div.hd-title",
            el("h1", habit.name || "Habit"),
            el("span.hd-sub",
              // MY target, from the newest entry, rather than habit.target — that field is the
              // group's seed, and a header quoting it tells somebody with a goal of their own that
              // their goal is a number they never chose.
              (reduce ? "Stay under " : "Reach ") + unit(mine)
              // fmt.source returns { icon, label } — it is drawn as two pieces everywhere else,
              // and interpolating it into a string gets you [object Object].
              + " a " + label + " · " + srcLabel.icon + " " + srcLabel.label),
          ),
        ),

        // Named, because the screen has two halves and only one of them is about you.
        //
        // Everything from here to "Everyone on this" is this member's own record — the chart, the
        // runs, the trend, the lifetime line, the weekday pattern, the badges. It was all already
        // personal and none of it said so, which is a question somebody should not have to ask.
        el("h2.sec-title.hd-mine", "Your history"),

        // The two numbers a person actually wants from a history screen, before any chart.
        el("div.hd-runs",
          el("div.hd-run",
            el("b", String(run.current)),
            el("span", run.current === 1 ? label + " running" : label + "s running")),
          el("div.hd-run",
            el("b", String(run.best)),
            el("span", "best ever")),
          el("div.hd-run",
            el("b", sum.judged ? sum.hits + "/" + sum.judged : "—"),
            el("span", reduce ? "under" : "met")),
        ),

        chart(),
        detail(),

        // Said only when there is something to say. A window with no silence and no rest days does
        // not need a paragraph explaining that it has neither.
        sum.quiet || sum.resting
          ? el("p.note-inline",
              [
                sum.quiet
                  ? count(sum.quiet, label)
                    + (automatic ? " with nothing from the sensor" : " not logged")
                  : null,
                sum.resting ? count(sum.resting, label) + " resting" : null,
              ].filter(Boolean).join(", ")
              + ". " + (sum.quiet && sum.resting ? "Neither counts" : "That does not count")
              + " against you.")
          : null,

        // How this window compares with the one before it, in words rather than an arrow.
        //
        // "Up 22%" means opposite things for steps and for puffs, and an arrow makes the reader do
        // that translation every time. The habit knows which direction is good; saying so is the
        // whole value of the line.
        move && !move.flat
          ? el("p.hd-trend" + (move.better ? ".is-better" : ".is-worse"),
              (move.better ? "Better" : "Worse") + " than the "
              + count(move.periods, label) + " before — "
              + unit(Math.round(move.before)) + " then, " + unit(Math.round(move.now)) + " now.")
          : move
            ? el("p.hd-trend", "About the same as the " + count(move.periods, label) + " before.")
            : null,

        sum.average != null
          ? el("p.note-inline",
              "Averaging " + unit(Math.round(sum.average)) + " a " + label
              + ", over the " + count(sum.judged, label)
              + (sum.judged === 1 ? " that was judged." : " that were judged."))
          : null,

        // ---- The longer view ----
        //
        // Everything above is a fortnight, which is readable and a bad answer to "is this working".
        life && life.judged > sum.judged
          ? el("div.hd-long",
              el("h2.sec-title", "Since you started"),
              el("p.hd-long-line",
                life.hits + " of " + count(life.judged, label) + " met"
                + (life.since ? ", since " + fmt.dayLabel(life.since) : "") + "."
                + (life.best
                  ? " Best " + label + ": " + unit(life.best.value)
                    + " on " + fmt.dayLabel(life.best.from) + "."
                  : "")),
            )
          : null,

        // The one pattern worth naming, and only when it is real. Every day being roughly equal is
        // the normal case and deserves silence rather than a sentence about whichever was lowest.
        worst
          ? el("p.hd-long-line.is-flagged",
              WEEKDAY_FULL[worst.index] + " is the hard one — met "
              + Math.round(worst.rate * 100) + "% of them, against "
              + Math.round(worst.restRate * 100) + "% on the rest.")
          : null,

        programSection(),
        ladder(),
        group(),

        el("div.hd-actions",
          onLog ? el("button.tap", { onclick: () => { sheet.close(); onLog(habit.habitId); } },
            automatic ? "Enter it manually" : "Log " + (habit.name || "it").toLowerCase()) : null,
          onEdit ? el("button.ghost", { onclick: () => { sheet.close(); onEdit(habit.habitId); } },
            "Edit this habit") : null,
        ),
      ),
    );
  }

  paint();
}
