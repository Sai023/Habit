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
  companionTotal, chartScale, barHeight, targetMoved,
} from "../history.js";
import { HABIT_TIERS, habitLevel, LEVEL_KEY } from "../milestones.js";
import { sourceFor, isTracking, HIT, MISS, NO_DATA, EXEMPT, windowOn } from "../habits.js";
import { programFor, planFor, sessionsOf, workoutLog } from "../workout.js";
import { historyList } from "./workouthistory.js";
import { draftsInProgress } from "./workoutdraft.js";
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

/** "1 week", "3 weeks" — the unit pluralised with the number it belongs to. */
function count(n, unit) {
  return n + " " + unit + (n === 1 ? "" : "s");
}

const TONE = {
  [HIT]: "is-hit",
  [MISS]: "is-miss",
  [NO_DATA]: "is-quiet",
  [EXEMPT]: "is-rest",
};

/**
 * The colour a period's bar and verdict take — under the active-day guard.
 *
 * An OPEN period has not been judged: the day (or week, or month) is still running, so a shortfall
 * is not a miss and must never wear the miss colour. It reads as "in progress" instead — the same
 * rule the Today cards follow, reaching the history chart so a bar at 429 of 6 000 at eleven in the
 * morning is not painted red. A CLOSED period keeps its real verdict.
 */
function barTone(e) {
  // A running period already at its goal still shows met — the guard suppresses the FAILURE of an
  // unfinished day, not the success of one already won.
  if (e.open) return e.status === HIT ? "is-hit" : "is-now";
  return TONE[e.status] || "is-quiet";
}

export function openHabitDetail(host, { state, habit, me, today, onLog, onEdit, onDone, onWorkout, onChooseProgram, onOpenWorkout = null }) {
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
  // Whether the log is dropped down on the Workouts landing. Closed on open: the screen is the
  // habit first, and the list is one tap away.
  let showHistory = false;
  // The list itself, kept across repaints while it is open, so a tap on a week bar above does
  // not reset the chip it was narrowed to. Dropped when it is folded away.
  let histList = null;

  const unit = (v) => (v == null ? "—" : fmt.value(habit.metric, v));
  // What one period is called, in the sentences below. Derived from the habit and constant for the
  // life of the sheet, so it lives out here rather than inside paint where only paint could see it.
  const label = habit.period === PERIOD.DAY ? "day"
    : habit.period === PERIOD.WEEK ? "week" : "month";

  function chart() {
    const scale = chartScale(entries);
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
          + "." + barTone(e)
          + (i === picked ? ".is-picked" : ""), {
          onclick: () => { picked = i; paint(); },
          "aria-label": periodLabel(e),
        },
          el("i.hd-bar-fill." + barTone(e),
            { style: "height:" + barHeight(e, scale) + "%" }),
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
        + (targetMoved(entries) ? " — coming down" : "")),
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
        el("span.hd-detail-verdict." + barTone(e), verdict),
      ),
      el("div.hd-detail-num",
        el("b", unit(e.value)),
        e.target ? el("span", (reduce ? " of " : " of ") + unit(e.target)) : null,
      ),
      // When the night ran, where whoever reported it said. Under the number rather than beside
      // it: the minutes are the verdict, the clock is the story.
      nightLine(e),
      companionLine(e),
    );
  }

  function nightLine(e) {
    if (habit.metric !== METRIC.SLEEP || e.period !== PERIOD.DAY) return null;
    const w = windowOn(state, habit, me, e.from);
    if (!w) return null;
    return el("p.hd-extra", el("span.hd-extra-icon", "\uD83C\uDF19"), fmt.windowLabel(w));
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
    // A session swiped away half-done is still here, and this is where somebody looks for it.
    const open = draftsInProgress(program, sessionsOf(program).map((x) => x.session), today);
    const log = workoutLog(state, me, today);
    const first = log.length ? log[log.length - 1].day : null;

    return el("div.hd-program",
      el("h2.sec-title", program.name),
      open.length
        ? el("div.hd-program-open", open.map(({ session, at }) => el("button.tap.tap-quiet",
            { onclick: () => { sheet.close(); onWorkout && onWorkout(); } },
            "Continue " + session.name + " \u00b7 " + (at.of ? at.done + " of " + at.of + " sets" : at.done + " rounds") + " \u2192")))
        : null,
      el("div.hd-program-today",
        el("span", plan && plan.session ? "Today: " + plan.session.name : "Today: " + ((plan && plan.rest) || "rest")),
        // Always a way in. The schedule is a suggestion, and a rest day is the day this link
        // used to vanish, leaving the Workouts card's small button as the only door, on the one
        // screen that is ABOUT the program.
        onWorkout
          ? el("button.link", { onclick: () => { sheet.close(); onWorkout(); } },
              plan && plan.session ? "Open \u2192" : "Pick a session \u2192")
          : null,
      ),

      // ---- The walk: the log, dropped down here; a workout; an exercise ----
      //
      // This is the landing. The log lives under one button rather than on the screen, so the
      // screen stays what it was (the habit, the week, the program) and grows a list only when
      // asked. A row opens the workout as its own sheet; back returns here with the list still
      // open. An exercise inside it opens its breakdown over months. Three steps, each deeper.
      log.length
        ? el("div.hd-histwrap",
            el("button.hd-histbtn" + (showHistory ? ".is-open" : ""), {
              onclick: () => { showHistory = !showHistory; if (!showHistory) histList = null; paint(); },
              "aria-expanded": showHistory ? "true" : "false",
            },
              el("span.hd-histbtn-main",
                el("span.hd-histbtn-k", "Historic workouts"),
                el("span.hd-histbtn-n", log.length + (log.length === 1 ? " workout" : " workouts")
                  + (first ? " since " + fmt.dayLabel(first).split(",").slice(1).join("").trim() : "")),
              ),
              el("span.hd-histbtn-go", "\u203A"),
            ),
            showHistory && onOpenWorkout
              ? (histList || (histList = historyList({ log, today, onOpen: (day, sessionId) => onOpenWorkout(day, sessionId) })))
              : null,
          )
        : el("p.note-inline", "No workouts yet. The first one you finish lands here."),
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
    const nextIdx = next ? tiers.indexOf(next) : -1;

    return el("div.hd-ladder",
      el("h2.sec-title", "Badges for this habit"),
      // Every rung is drawn: won (struck), the one coming up (lit), the rest locked (dimmed) — so
      // the ladder shows both how far you have come and what is next.
      el("div.hd-rungs", tiers.map((t, i) => el(
        "div.hd-rung" + (i < level ? ".is-won" : i === nextIdx ? ".is-next" : ".is-locked"),
        el("span.badge.badge-md.badge-" + LEVEL_KEY[i + 1]
          + (String(t.at).length > 2 ? ".badge-wide" : ""),
          el("span.badge-face", el("span.badge-n", String(t.at)))),
        el("span.hd-rung-span", t.span),
      ))),
      // Instead of a countdown sentence, a progress bar under the next badge with the value on it —
      // so how close the unlock is can be read, not counted.
      next
        ? el("div.hd-next",
            el("div.hd-next-bar", { role: "presentation" },
              el("i", { style: "width:" + Math.min(100, Math.round((run.current / next.at) * 100)) + "%" })),
            el("div.hd-next-label",
              el("b", run.current + " / " + next.at + " " + label + (next.at === 1 ? "" : "s")),
              el("span", "to " + next.span)),
          )
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

    // Sorted by who is furthest along their own goal, so the board reads top-down like a board.
    // Ties settle by days met, then name, so it is the same order on every phone.
    const ranked = [...others].sort((a, b) =>
      (b.rate - a.rate) || (b.hits - a.hits) || String(a.name || "").localeCompare(String(b.name || "")));
    const leader = ranked.find((r) => r.judged > 0) || null;
    const someTicksOnly = others.some((r) => !r.shown);

    return el("div.hd-group",
      // The long paragraph of counting rules moves behind an (i) — there when wanted, out of the
      // way when not, so the rows themselves are what the eye lands on.
      el("div.hd-group-head",
        el("h2.sec-title", "Everyone on this"),
        el("details.hd-info",
          el("summary", { "aria-label": "How this is counted" }, "ⓘ"),
          el("p",
            "The " + span + " each person met their own goal, out of the " + span + " that counted — "
            + "rest " + span + " and ones with nothing from a sensor are left out."
            + (someTicksOnly ? " Some show ticks only — everyone picks what the group sees of their numbers." : "")),
        )),
      el("div.hd-people", ranked.map((r) => el(
        "div.hd-person" + (r.isMe ? ".is-me" : "") + (leader && r === leader ? ".is-leader" : ""),
        el("span.hd-person-name",
          leader && r === leader ? el("span.hd-crown", { title: "Leading" }, "👑") : null,
          r.isMe ? "You" : r.name),
        el("span.hd-person-bar",
          el("i", { style: "width:" + Math.round(r.rate * 100) + "%" })),
        el("span.hd-person-num",
          r.hits + "/" + r.judged,
          // Always labelled an average — it is the mean across the periods that counted, and
          // without the word it reads as today's figure.
          r.shown && "value" in r.shown
            ? el("span.hd-person-sub", "avg " + unit(Math.round(r.shown.value)))
            : r.shown && "pct" in r.shown
              ? el("span.hd-person-sub", "avg " + r.shown.pct + "% of goal")
              : null,
        ),
      ))),
    );
  }

  /**
   * The exception rules this window applied, as pills rather than a sentence: the sensor gaps or
   * unlogged periods, and the booked rest — each one set aside, never counted against you (the
   * reassurance the old paragraph spelled out now lives in the pill's tooltip).
   */
  function contextPills() {
    const pills = [];
    if (sum.quiet) {
      pills.push(el("span.hd-pill", { title: "Set aside — didn't count against you." },
        "🔌 " + sum.quiet + " "
        + (automatic ? (sum.quiet === 1 ? "sensor gap" : "sensor gaps") : (sum.quiet === 1 ? "unlogged " + label : "unlogged " + label + "s"))
        + " excluded"));
    }
    if (sum.resting) {
      pills.push(el("span.hd-pill", { title: "Booked rest — didn't count against you." },
        "🌙 " + sum.resting + " rest " + label + (sum.resting === 1 ? "" : "s")));
    }
    return pills.length ? el("div.hd-pills", pills) : null;
  }

  /**
   * The trend against the window before, framed as coaching in a speech bubble — dynamic advice,
   * kept visually distinct from the static platform rules above. The habit knows which way is good,
   * so the bubble says "better"/"worse", never an arrow the reader has to translate.
   */
  function coachBubble() {
    if (!move) return null;
    const text = move.flat
      ? "About the same as the " + count(move.periods, label) + " before."
      : (move.better ? "Better" : "Worse") + " than the " + count(move.periods, label) + " before — "
        + unit(Math.round(move.before)) + " then, " + unit(Math.round(move.now)) + " now.";
    return el("div.hd-coach" + (move.flat ? "" : move.better ? ".is-better" : ".is-worse"),
      el("span.hd-coach-icon", "💬"), el("span", text));
  }

  /**
   * The window average and the since-launch record, as stat callouts side by side — two figures to
   * glance at rather than two sentences to read. Exact dates ride in the tooltips.
   */
  function statCallouts() {
    const tiles = [];
    if (sum.average != null) {
      tiles.push(el("div.hd-stat",
        el("b", unit(Math.round(sum.average))),
        el("span", count(sum.judged, label) + " avg")));
    }
    if (life && life.judged > sum.judged) {
      tiles.push(el("div.hd-stat", { title: life.since ? "Since " + fmt.dayLabel(life.since) : "" },
        el("b", life.hits + "/" + life.judged),
        el("span", "met since launch")));
      if (life.best) {
        tiles.push(el("div.hd-stat", { title: "on " + fmt.dayLabel(life.best.from) },
          el("b", unit(life.best.value)),
          el("span", "best " + label)));
      }
    }
    return tiles.length ? el("div.hd-stats", tiles) : null;
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

        // What was set aside and why, as tags rather than a sentence — the exception rules the
        // engine applied, abstracted into pills a glance can take in. See contextPills.
        contextPills(),

        // The dynamic comparison, in its own voice: coaching, not a platform rule, so it gets a
        // frame of its own to say so. The habit knows which direction is good.
        coachBubble(),

        // The numbers as stat callouts, side by side: the window's average, and the record since
        // launch. Was two sentences to read; now two figures to glance.
        statCallouts(),

        // The one weekday pattern, when it is real — kept as a flagged line, because it is a claim
        // about behaviour, not a stat.
        worst
          ? el("p.hd-flag",
              el("span.hd-flag-k", WEEKDAY_FULL[worst.index] + "s are hardest"),
              el("span", "met " + Math.round(worst.rate * 100) + "%, against "
                + Math.round(worst.restRate * 100) + "% on the rest"))
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
