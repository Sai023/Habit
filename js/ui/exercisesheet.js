// exercisesheet.js — one exercise, over months.
//
// The Workouts detail lists every exercise with its last few sessions as chips. That is the right
// amount for a glance and the wrong amount for a question: "am I getting better at push-ups" is
// answered by the shape of thirty sessions, not by the last five as text. So each exercise opens
// to a bar per session — totals, the record lit — and under it the sessions newest first, each
// with its sets, the day, and what the watch said about that exercise that day. Any row opens the
// workout it came from.
//
// ---- Why totals and not best sets ----
//
// The chart draws the session TOTAL. Three sets of eight is a better day than one lucky fifteen
// and two of six, and the best set on its own would say the opposite. The best set still gets its
// line at the top, because it is the number to beat on the next rep.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { exerciseLog } from "../workout.js";
import * as fmt from "./format.js";

/** How many sessions the chart draws. Beyond it the bars are slivers; the list has the rest. */
const CHART_MAX = 24;

function unitSuffix(unit) {
  return unit === "s" ? "s" : unit === "min" ? " min" : unit === "rounds" ? " rounds" : "";
}

export function openExerciseSheet(host, { state, me, today, exerciseId, onOpenWorkout, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });
  const log = exerciseLog(state, me, exerciseId, today);
  const unit = log.unit;

  /** The bars: one per session, oldest left, the record's session lit, scaled to the best total. */
  function chart() {
    const series = log.series.slice(-CHART_MAX);
    if (series.length < 2) return null;
    const top = Math.max(...series.map((s) => s.total), 1);
    const bestDay = log.bestTotal ? log.bestTotal.day : null;
    return el("div.ex-chart",
      el("div.ex-bars", series.map((s) => el("i.ex-bar" + (s.day === bestDay ? ".is-best" : "") + (s.day === today ? ".is-today" : ""), {
        style: "height:" + Math.max(4, Math.round((s.total / top) * 100)) + "%",
        title: fmt.dayLabel(s.day) + " · " + s.total + unitSuffix(unit),
      }))),
      el("div.ex-chart-foot",
        el("span", fmt.dayLabel(series[0].day).split(",")[0] + " " + fmt.dayLabel(series[0].day).split(",").slice(1).join("")),
        el("span", log.series.length > CHART_MAX ? "last " + CHART_MAX + " of " + log.series.length : series.length + " sessions"),
        el("span", fmt.dayLabel(series[series.length - 1].day)),
      ),
    );
  }

  function row(r) {
    const sets = r.sets.map((n, i) => el("span.wl-set" + (r.pb[i] ? ".is-pb" : "") + (n === null ? ".is-skip" : ""),
      n === null ? "–" : String(n)));
    const facts = [
      r.total + unitSuffix(unit) + (unit === "reps" ? " reps" : ""),
      r.minutes ? r.minutes + " min" : null,
      r.kcalPerMin ? r.kcalPerMin.toFixed(1) + " kcal/min" : (r.kcal ? r.kcal + " kcal" : null),
      r.hrAvg ? "♥ " + r.hrAvg : null,
    ].filter(Boolean).join(" · ");
    return el("button.ex-row", { onclick: () => { if (onOpenWorkout) { sheet.close(); onOpenWorkout(r.day, r.sessionId); } } },
      el("span.ex-row-main",
        el("span.ex-row-when", fmt.dayLabel(r.day) + " · " + r.sessionName),
        el("span.wl-sets", sets),
        el("span.ex-row-facts", facts),
      ),
      el("span.wl-row-go", "›"),
    );
  }

  function paint() {
    sheet.paint(
      el("div.form.ex",
        el("div.sheet-head", el("span.sheet-title", log.name + (log.rows.length && log.rows[0].perSide ? " (per side)" : ""))),
        log.rows.length
          ? el("p.sheet-now",
              log.rows.length + (log.rows.length === 1 ? " session" : " sessions")
              + (log.best ? " · best set " + log.best.value + unitSuffix(unit) + " (" + fmt.dayLabel(log.best.day) + ")" : "")
              + (log.bestTotal ? " · best day " + log.bestTotal.value + unitSuffix(unit) + " (" + fmt.dayLabel(log.bestTotal.day) + ")" : ""))
          : el("p.sheet-now", "Not done yet."),
        chart(),
        el("div.ex-list", log.rows.map(row)),
        el("div.sheet-actions", el("button.ghost", { onclick: () => sheet.close() }, "Close")),
      ),
    );
  }

  paint();
}
