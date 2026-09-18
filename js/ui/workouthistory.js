// workouthistory.js — every workout, one by one.
//
// The training block on the hub says what the log adds up to: sessions, sets, the favourite, the
// most improved. It cannot say what happened on Tuesday. That is the question this answers — the
// list of workouts newest first, and any one of them opened to its sets, beside last time's, with
// the record marked where it was beaten and the clock beside it where a clock was kept.
//
// ---- The shape of it ----
//
// A calendar's spine: every row starts with the date as a small stacked badge — day over month —
// so a scroll through a year reads as a calendar and not as a list of similar sentences. Month
// eyebrows break the run; chips narrow it to one session. A row is a name, one line of facts in
// the same order every time (when · how long · how much), the record if one fell, and what the
// watch said in the ring colour. Nothing is ever removed: a finish that banked nothing is kept
// and shown for what it was, quietly.
//
// ---- What the watch adds ----
//
// A workout that ran while a watch was worn carries vitals: what the heart did, what it cost,
// per exercise where the sets were stamped. Laid over the sets rather than shown apart, because
// "burpees, 9 kcal a minute" is the sentence a person can act on and "210 kcal" is a number.
// Absent, the sheet says nothing about it — a blank row for a watch nobody wears is a nag.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { workoutLog, MIN_INSIGHT_SESSIONS } from "../workout.js";
import { vitalsInsights } from "../vitals.js";
import * as fmt from "./format.js";
import { EFFORT } from "./workoutsheet.js";

/** "18:32" — a clock time in the reader's own zone, since the workout was theirs. */
function clockOf(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "September 2026" — the month a day falls in, for the eyebrows. */
function monthLabel(day) {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The date as a stacked badge: "16" over "SEP". The spine of every list here. */
export function dateBadge(day, today = null) {
  const [y, m, d] = day.split("-").map(Number);
  const mon = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
  return el("span.dbadge" + (day === today ? ".is-today" : ""),
    el("b", String(d)),
    el("span", mon.toUpperCase()),
  );
}

function unitSuffix(unit) {
  return unit === "s" ? "s" : unit === "min" ? " min" : unit === "rounds" ? " rounds" : "";
}

/** "10 · 8 · 7", the record marked, a skipped set shown as a dash. */
export function setsLine(sets, pb, unit) {
  return el("span.wl-sets", sets.map((n, i) => el("span.wl-set" + (pb && pb[i] ? ".is-pb" : "") + (n === null ? ".is-skip" : ""),
    n === null ? "–" : String(n) + (i === sets.length - 1 ? unitSuffix(unit) : ""))));
}

/** "+3" in the ring colour, "−2" in the warning colour, nothing for the same or a first time. */
function delta(now, before, unit) {
  if (before === null || before === undefined || now === before) return null;
  const d = now - before;
  return el("span.wl-delta" + (d > 0 ? ".is-up" : ".is-down"), (d > 0 ? "+" : "−") + Math.abs(d) + unitSuffix(unit));
}

/**
 * The log as a list: chips to narrow it, month eyebrows, one row per workout. A component that
 * repaints itself, so the Workouts screen can drop it in under a button and the sheet can show
 * it whole, and neither has a second copy of what a row is. `onOpen(day, sessionId)` is the tap.
 */
export function historyList({ log, today, onOpen }) {
  const root = el("div.wl-hist");
  // Which session the list is narrowed to, or null for all. Over months the list is long, and
  // "every Push + Core" is the question a person scrolling it is usually asking.
  let only = null;

  // What a chip counts by. A structured session repeats under one template id, so "Push + Core"
  // rightly tallies every time it was done. A watch-detected workout carries its OWN id per
  // session, so tallying by that made eight tennis matches eight chips reading "Workout 1". Group
  // those by name instead: eight unnamed ones become one "Workout 8", "Tennis" its own "Tennis 3".
  const chipKey = (w) => (w.external ? "ext:" + w.sessionName : w.sessionId);

  /** The sessions in the log, each once, most done first — the chips that narrow the list. */
  function sessionChips() {
    const counts = new Map();
    for (const w of log) {
      const k = chipKey(w);
      counts.set(k, { name: w.sessionName, n: (counts.get(k) || { n: 0 }).n + 1 });
    }
    if (counts.size < 2) return null;
    const chips = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);
    return el("div.chips.wl-filter",
      el("button.chip" + (only === null ? ".on" : ""), { onclick: () => { only = null; paint(); } }, "All " + log.length),
      chips.map(([id, c]) => el("button.chip" + (only === id ? ".on" : ""), { onclick: () => { only = id; paint(); } },
        c.name + " " + c.n)),
    );
  }

  /** One workout, closed: the date, the name, one line of facts, the record, the watch. */
  function row(w) {
    const when = w.timed ? clockOf(w.startedAt) : null;
    const long = w.timed ? w.minutes + " min" : (w.classMinutes ? w.classMinutes + " min" : null);
    const much = w.empty ? null
      : w.external ? (w.source === "health_connect" ? "from your watch" : "counted, no session")
      : w.kind === "intervals" ? (w.rounds ?? 0) + " rounds" + (w.sets ? " + " + w.sets + " sets" : "")
      : w.kind === "video" ? (w.effort ? EFFORT[w.effort] : "done")
      : w.short ? w.sets + " of " + w.setsOf + " sets"
      : w.sets + (w.sets === 1 ? " set" : " sets");
    return el("button.wl-row" + (w.empty ? ".is-empty" : ""), { onclick: () => onOpen(w.day, w.sessionId) },
      dateBadge(w.day, today),
      el("span.wl-row-main",
        el("span.wl-row-name", w.sessionName),
        el("span.wl-row-sub", w.empty
          ? "nothing banked"
          : [when, long, much].filter(Boolean).join(" · ")),
        w.pbs.length ? el("span.wl-row-pb", "\u{1F3C6} " + w.pbs.join(", ")) : null,
        w.vitals && (w.vitals.kcal || w.vitals.hrAvg)
          ? el("span.wl-row-vitals",
              [w.vitals.kcal ? Math.round(w.vitals.kcal) + " kcal" : null,
                w.vitals.hrAvg ? "♥ " + Math.round(w.vitals.hrAvg) : null,
                w.vitals.hrMax ? Math.round(w.vitals.hrMax) + " peak" : null].filter(Boolean).join(" · "))
          : null,
      ),
      el("span.wl-row-go", "›"),
    );
  }

  /**
   * A day's worth of the same un-named, un-clocked watch workouts, on one line.
   *
   * With no name to tell them apart and no clock to order them by, eight identical rows are eight
   * screenfuls of nothing. They are already in the count on the card; here they are one honest line
   * — "3 workouts · from your watch" — that says as much as eight rows did and asks for no scroll.
   * There is nothing to open, so it is not a button. The moment one carries a name or a clock it is
   * its own thing again and never lands here.
   */
  function foldedRow(items) {
    const w = items[0];
    const what = w.source === "health_connect" ? "from your watch" : "counted, no session";
    return el("div.wl-row.is-folded",
      dateBadge(w.day, today),
      el("span.wl-row-main",
        el("span.wl-row-name", w.sessionName),
        el("span.wl-row-sub", items.length + " workouts · " + what),
      ),
      el("span.wl-row-count", "×" + items.length),
    );
  }

  /** True for a workout with nothing to set it apart from the next — a candidate to fold. */
  const foldable = (w) => w.external && !w.timed && !w.empty;

  /** The rows, under month eyebrows, so a year of workouts still has landmarks in it. */
  function rows() {
    const shown = log.filter((w) => only === null || chipKey(w) === only);
    // Fold a run of same-day, same-name, featureless watch workouts into one line. They sort
    // together (day then time), so a plain adjacent-run fold catches them without reordering the
    // list; a structured session between two of them simply starts a new run, which is correct.
    const groups = [];
    for (const w of shown) {
      const last = groups[groups.length - 1];
      if (foldable(w) && last && last.fold && last.day === w.day && last.name === w.sessionName) {
        last.items.push(w);
      } else {
        groups.push({ day: w.day, name: w.sessionName, fold: foldable(w), items: [w] });
      }
    }
    const out = [];
    let month = null;
    for (const g of groups) {
      const m = g.day.slice(0, 7);
      if (m !== month) {
        month = m;
        const inMonth = shown.filter((x) => x.day.slice(0, 7) === m);
        const minutes = inMonth.reduce((n, x) => n + (x.minutes || 0), 0);
        out.push(el("div.wl-month",
          el("span", monthLabel(g.day)),
          el("span.wl-month-n", inMonth.length + (inMonth.length === 1 ? " workout" : " workouts") + (minutes ? " · " + minutes + " min" : "")),
        ));
      }
      out.push(g.items.length > 1 ? foldedRow(g.items) : row(g.items[0]));
    }
    return el("div.wl-list", out);
  }

  function paint() {
    root.replaceChildren();
    const chips = sessionChips();
    if (chips) root.append(chips);
    root.append(rows());
  }
  paint();
  return root;
}

/**
 * The sheet: the whole log, or one workout of it.
 *
 * Opened at a workout with `standalone`, it is that workout's own sheet: back closes it, so the
 * screen underneath (the Workouts landing with its list dropped down, or an exercise's sheet) is
 * where the person lands. Each exercise in the open workout opens its breakdown via `onExercise`.
 */
export function openWorkoutHistory(host, { state, me, today, openAt = null, standalone = false, onExercise = null, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });
  const log = workoutLog(state, me, today);
  const burn = vitalsInsights(log);
  let open = openAt ? log.findIndex((w) => w.day === openAt.day && w.sessionId === openAt.sessionId) : -1;
  if (open < 0) open = null;
  // The list, made once: back from a workout lands on it narrowed as it was left.
  let list = null;


  /** The vitals the phone laid over this workout, if a watch was worn. */
  function vitalsBlock(w) {
    const v = w.vitals;
    if (!v || (!v.kcal && !v.hrAvg)) return null;
    const tiles = [];
    if (v.kcal) tiles.push([Math.round(v.kcal), "kcal"]);
    if (v.hrAvg) tiles.push([Math.round(v.hrAvg), "avg bpm"]);
    if (v.hrMax) tiles.push([Math.round(v.hrMax), "peak bpm"]);
    if (v.hrRest) tiles.push([Math.round(v.hrRest), "rest bpm"]);
    if (Number.isFinite(v.recovery)) tiles.push(["−" + Math.round(v.recovery), "in a minute"]);
    if (v.kcal && w.minutes) tiles.push([(v.kcal / w.minutes).toFixed(1), "kcal / min"]);
    return el("div.wl-vitals",
      el("div.wl-tiles", tiles.map(([n, k]) => el("div.wl-tile", el("b", String(n)), el("span", k)))),
      el("p.note-inline", "From your watch, laid over the minutes this workout ran."
        + (v.samples ? " " + v.samples + " heart-rate readings." : "")
        + (Number.isFinite(v.recovery) ? " “In a minute” is how far your heart fell in the minute after a set." : "")),
    );
  }

  /** One exercise inside an open workout: the sets, the change on last time, its cost. */
  function exerciseRow(e, w) {
    const prevTotal = e.previous && e.previous.some(Number.isFinite)
      ? e.previous.filter(Number.isFinite).reduce((a, b) => a + b, 0)
      : null;
    const span = (w.spans || []).find((s) => s.id === e.id);
    const ev = w.vitals && w.vitals.exercises ? w.vitals.exercises.find((x) => x.id === e.id) : null;
    // What the watch said about this exercise, whichever halves it has: calories and the rate
    // where there were calories, the heart where there were beats, the minutes always.
    const cost = [
      ev && ev.kcal ? Math.round(ev.kcal) + " kcal" : null,
      ev && ev.kcal && span && span.ms >= 60_000 ? (ev.kcal / (span.ms / 60_000)).toFixed(1) + "/min" : null,
      ev && ev.hrAvg ? "♥ " + Math.round(ev.hrAvg) : null,
      span && span.ms >= 30_000 ? Math.round(span.ms / 60_000) + " min" : null,
    ].filter(Boolean).join(" · ") || null;
    const done = e.sets.some(Number.isFinite);
    // Fewer sets than there were to do: the day was cut short here, and a minus against last
    // time would be reading a stopped session as a weaker one.
    const short = done && e.sets.some((n) => n === null);
    // The card opens the exercise's own breakdown: every time it was done, the record, the
    // watch. The third step of the walk: the day, then the workout, then the exercise.
    const opens = !!onExercise && done;
    return el((opens ? "button" : "div") + ".wl-ex" + (done ? "" : ".is-skipped") + (opens ? ".opens" : ""),
      // Stacked over this sheet, not swapped for it: closing the exercise lands back on the
      // workout it came from, and back from the workout lands on the screen that opened it.
      opens ? { onclick: () => onExercise(e.id) } : {},
      el("div.wl-ex-head",
        el("span.wl-ex-name", e.name + (e.perSide ? " · per side" : "")),
        done
          ? el("span.wl-ex-total", e.total + (e.unit === "reps" ? " reps" : unitSuffix(e.unit)),
              short ? el("span.wl-delta.is-short", "cut short") : delta(e.total, prevTotal, e.unit))
          : el("span.wl-ex-total.is-dim", "skipped"),
        opens ? el("span.wl-ex-go", "›") : null,
      ),
      setsLine(e.sets, e.pb, e.unit),
      el("div.wl-ex-foot",
        el("span", prevTotal !== null
          ? "last time " + e.previous.map((n) => (n === null ? "–" : n)).join(" · ")
          : "first time"),
        // Nothing the watch said about an exercise that was skipped: the minute it "took" was
        // three taps of Done on an empty stepper.
        done && cost ? el("span.wl-ex-cost", cost) : null,
      ),
    );
  }

  /** The workout, open. */
  function detail(w) {
    const when = w.timed
      ? clockOf(w.startedAt) + " → " + clockOf(w.endedAt) + " · " + w.minutes + " min"
      : w.classMinutes ? w.classMinutes + " min" : "no clock kept";
    const sub = w.external
      ? [w.source === "health_connect" ? "From your watch" : "Logged", w.timed ? w.minutes + " min" : null].filter(Boolean).join(" · ")
      : [w.programName, when, w.effort ? EFFORT[w.effort] : null, w.short ? "cut short" : null].filter(Boolean).join(" · ");
    return el("div.wl-detail",
      standalone
        ? el("button.link.wl-back", { onclick: () => sheet.close() }, "\u2190 Back")
        : el("button.link.wl-back", { onclick: () => { open = null; paint(); } }, "← All workouts"),
      el("div.wl-detail-head",
        dateBadge(w.day, today),
        el("div.wl-detail-title",
          el("span.sheet-title", w.sessionName),
          el("span.wl-detail-sub", sub),
        ),
      ),
      w.kind === "intervals"
        ? el("p.wl-rounds", (w.rounds ?? 0) + " rounds"
            + (w.work ? " · " + w.work + "s on / " + w.rest + "s off" : ""))
        : null,
      w.empty
        ? el("p.note-inline", "Nothing was banked in this one — Finish was pressed on empty sets. It is kept, because it happened; it sets no record and moves no trend.")
        : null,
      w.external
        ? el("p.note-inline", w.source === "health_connect"
            ? "Counted from your watch. It adds to your weekly total, but it was not a session run in the app, so there is nothing to break down set by set."
            : "A workout you counted without running a session in the app — so it is on the tally, but there is nothing to break down here.")
        : null,
      vitalsBlock(w),
      w.exercises.length ? el("div.wl-exs", w.exercises.map((e) => exerciseRow(e, w))) : null,
      w.pbs.length
        ? el("p.wl-pbline", "\u{1F3C6} Personal best on " + w.pbs.join(", ") + ".")
        : null,
      !w.timed && !w.empty && !w.external
        ? el("p.note-inline", "Logged before the app kept a clock, so there are no minutes and nothing for a watch to line up with.")
        : null,
    );
  }

  /** What the vitals say across workouts, once there are enough of them. */
  function burnBlock() {
    if (!burn) return null;
    return el("div.wl-burn",
      el("h2.sec-title", "What costs the most"),
      el("div.wl-burn-list", burn.exercises.slice(0, 5).map((x, i) => el("div.wl-burn-row",
        el("span.wl-burn-n", String(i + 1)),
        el("span.wl-burn-name", x.name),
        el("span.wl-burn-rate", x.kcalPerMin.toFixed(1) + " kcal/min"
          + (x.hrAvg ? " · ♥ " + Math.round(x.hrAvg) : "")),
      ))),
      el("p.note-inline", burn.line),
    );
  }

  function paint() {
    if (open !== null && log[open]) { sheet.paint(el("div.form.wl", detail(log[open]))); return; }
    const timed = log.filter((w) => w.timed);
    sheet.paint(
      el("div.form.wl",
        el("div.sheet-head", el("span.sheet-title", "Workouts")),
        log.length
          ? el("p.sheet-now", log.length + (log.length === 1 ? " workout" : " workouts")
              + " since " + fmt.dayLabel(log[log.length - 1].day)
              + (timed.length ? " · " + timed.reduce((n, w) => n + (w.minutes || 0), 0) + " min on the clock" : "")
              + ".")
          : el("p.sheet-now", "No workouts logged yet. Finish one from the hub and it lands here."),
        burnBlock(),
        (list || (list = historyList({ log, today, onOpen: (day, sessionId) => {
          open = log.findIndex((w) => w.day === day && w.sessionId === sessionId);
          if (open < 0) open = null;
          paint();
        } }))),
        log.length && log.length < MIN_INSIGHT_SESSIONS
          ? el("p.note-inline", "Trends and records need a few more sessions to say anything worth saying.")
          : null,
        el("div.sheet-actions", el("button.ghost", { onclick: () => sheet.close() }, "Close")),
      ),
    );
  }

  paint();
}
