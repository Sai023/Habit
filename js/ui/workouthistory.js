// workouthistory.js — every workout, one by one.
//
// The training block on the hub says what the log adds up to: sessions, sets, the favourite, the
// most improved. It cannot say what happened on Tuesday. That is the question this answers — the
// list of workouts newest first, and any one of them opened to its sets, beside last time's, with
// the record marked where it was beaten and the clock beside it where a clock was kept.
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

function unitSuffix(unit) {
  return unit === "s" ? "s" : unit === "min" ? " min" : unit === "rounds" ? " rounds" : "";
}

/** "10 · 8 · 7", the record marked, a skipped set shown as a dash. */
function setsLine(e) {
  return el("span.wl-sets", e.sets.map((n, i) => el("span.wl-set" + (e.pb[i] ? ".is-pb" : "") + (n === null ? ".is-skip" : ""),
    n === null ? "–" : String(n) + (i === e.sets.length - 1 ? unitSuffix(e.unit) : ""))));
}

export function openWorkoutHistory(host, { state, me, today, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });
  const log = workoutLog(state, me, today);
  const burn = vitalsInsights(log);
  let open = null; // index into log

  /** One workout, closed: what, when, how much, and what the watch said. */
  function row(w, i) {
    const when = w.timed ? clockOf(w.startedAt) + " · " + w.minutes + " min" : (w.classMinutes ? w.classMinutes + " min" : null);
    const what = w.kind === "intervals"
      ? (w.rounds ?? 0) + " rounds" + (w.sets ? " + " + w.sets + " sets" : "")
      : w.kind === "video"
        ? (w.effort ? EFFORT[w.effort] : "done")
        : w.sets + " sets";
    return el("button.wl-row", { onclick: () => { open = i; paint(); } },
      el("span.wl-row-main",
        el("span.wl-row-name", w.sessionName),
        el("span.wl-row-sub",
          [fmt.dayLabel(w.day), when, what].filter(Boolean).join(" · "),
        ),
        w.pbs.length ? el("span.wl-row-pb", "\u{1F3C6} " + w.pbs.join(", ")) : null,
        w.vitals && (w.vitals.kcal || w.vitals.hrAvg)
          ? el("span.wl-row-vitals",
              [w.vitals.kcal ? Math.round(w.vitals.kcal) + " kcal" : null,
                w.vitals.hrAvg ? "♥ " + Math.round(w.vitals.hrAvg) + " avg" : null,
                w.vitals.hrMax ? Math.round(w.vitals.hrMax) + " max" : null].filter(Boolean).join(" · "))
          : null,
      ),
      el("span.wl-row-go", "›"),
    );
  }

  /** The vitals the phone laid over this workout, if a watch was worn. */
  function vitalsBlock(w) {
    const v = w.vitals;
    if (!v || (!v.kcal && !v.hrAvg)) return null;
    const tiles = [];
    if (v.kcal) tiles.push([Math.round(v.kcal), "kcal"]);
    if (v.hrAvg) tiles.push([Math.round(v.hrAvg), "avg bpm"]);
    if (v.hrMax) tiles.push([Math.round(v.hrMax), "max bpm"]);
    if (v.hrRest) tiles.push([Math.round(v.hrRest), "rest bpm"]);
    if (Number.isFinite(v.recovery)) tiles.push(["\u2212" + Math.round(v.recovery), "in a minute"]);
    if (v.kcal && w.minutes) tiles.push([(v.kcal / w.minutes).toFixed(1), "kcal / min"]);
    return el("div.wl-vitals",
      el("div.wl-tiles", tiles.map(([n, k]) => el("div.wl-tile", el("b", String(n)), el("span", k)))),
      el("p.note-inline", "From your watch, through Health Connect, laid over the minutes this workout ran."
        + (v.samples ? " " + v.samples + " heart-rate readings." : "")
        + (Number.isFinite(v.recovery) ? " \u201CIn a minute\u201D is how far your heart fell in the minute after a set." : "")),
    );
  }

  /** One exercise inside an open workout: the sets, last time, the record, its cost. */
  function exerciseRow(e, w) {
    const prev = e.previous && e.previous.some(Number.isFinite)
      ? "last time " + e.previous.map((n) => (n === null ? "–" : n)).join(" · ")
      : "first time";
    const span = (w.spans || []).find((s) => s.id === e.id);
    const ev = w.vitals && w.vitals.exercises ? w.vitals.exercises.find((x) => x.id === e.id) : null;
    const cost = ev && ev.kcal && span
      ? Math.round(ev.kcal) + " kcal" + (span.ms >= 60_000 ? " · " + (ev.kcal / (span.ms / 60_000)).toFixed(1) + "/min" : "")
        + (ev.hrAvg ? " · ♥ " + Math.round(ev.hrAvg) : "")
      : span && span.ms >= 30_000 ? Math.round(span.ms / 60_000) + " min" : null;
    return el("div.wl-ex",
      el("div.wl-ex-head",
        el("span.wl-ex-name", e.name + (e.perSide ? " (per side)" : "")),
        cost ? el("span.wl-ex-cost", cost) : null,
      ),
      setsLine(e),
      el("span.wl-ex-prev", prev),
    );
  }

  /** The workout, open. */
  function detail(w) {
    const when = w.timed
      ? clockOf(w.startedAt) + " → " + clockOf(w.endedAt) + " · " + w.minutes + " min"
      : w.classMinutes ? w.classMinutes + " min" : "no clock kept";
    return el("div.wl-detail",
      el("button.link.wl-back", { onclick: () => { open = null; paint(); } }, "← All workouts"),
      el("div.sheet-head", el("span.sheet-title", w.sessionName)),
      el("p.sheet-now", fmt.dayLabel(w.day) + " · " + w.programName + " · " + when
        + (w.effort ? " · " + EFFORT[w.effort] : "")),
      w.kind === "intervals"
        ? el("p.wl-rounds", (w.rounds ?? 0) + " rounds"
            + (w.work ? " · " + w.work + "s on / " + w.rest + "s off" : ""))
        : null,
      vitalsBlock(w),
      w.exercises.length ? el("div.wl-exs", w.exercises.map((e) => exerciseRow(e, w))) : null,
      w.pbs.length
        ? el("p.wl-pbline", "\u{1F3C6} Personal best on " + w.pbs.join(", ") + ".")
        : null,
      !w.timed
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
    sheet.paint(
      el("div.form.wl",
        el("div.sheet-head", el("span.sheet-title", "Workouts")),
        log.length
          ? el("p.sheet-now", log.length + (log.length === 1 ? " workout" : " workouts")
              + " since " + fmt.dayLabel(log[log.length - 1].day)
              + (log.filter((w) => w.timed).length ? " · " + log.filter((w) => w.timed).reduce((n, w) => n + (w.minutes || 0), 0) + " min on the clock" : "")
              + ".")
          : el("p.sheet-now", "No workouts logged yet. Finish one from the hub and it lands here."),
        burnBlock(),
        el("div.wl-list", log.map(row)),
        log.length && log.length < MIN_INSIGHT_SESSIONS
          ? el("p.note-inline", "Trends and records need a few more sessions to say anything worth saying.")
          : null,
        el("div.sheet-actions", el("button.ghost", { onclick: () => sheet.close() }, "Close")),
      ),
    );
  }

  paint();
}
