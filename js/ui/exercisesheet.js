// exercisesheet.js — one exercise, over months.
//
// The Workouts detail shows every exercise as the shape of its last dozen sessions. That is the
// right amount for a glance and the wrong amount for a question: "am I getting better at
// push-ups" is answered by thirty sessions, not twelve bars. So each exercise opens to this: the
// three numbers that matter as tiles, a bar per session with the record lit, and under it every
// session newest first — the date as a badge, the sets, the total and the change on the time
// before, and what the watch said about this exercise that day. Any row opens the workout it came
// from.
//
// ---- Why totals and not best sets ----
//
// The chart draws the session TOTAL. Three sets of eight is a better day than one lucky fifteen
// and two of six, and the best set on its own would say the opposite. The best set still gets a
// tile, because it is the number to beat on the next rep.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { exerciseLog } from "../workout.js";
import * as fmt from "./format.js";
import { dateBadge, setsLine } from "./workouthistory.js";

/** How many sessions the chart draws. Beyond it the bars are slivers; the list has the rest. */
const CHART_MAX = 24;

function unitSuffix(unit) {
  return unit === "s" ? "s" : unit === "min" ? " min" : unit === "rounds" ? " rounds" : "";
}

export function openExerciseSheet(host, { state, me, today, exerciseId, onOpenWorkout, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });
  const log = exerciseLog(state, me, exerciseId, today);
  const unit = log.unit;
  const total = (n) => n + (unit === "reps" ? " reps" : unitSuffix(unit));

  /** The three numbers: how often, the best set, the best day — each with its date underneath. */
  function tiles() {
    if (!log.rows.length) return null;
    return el("div.wl-tiles",
      el("div.wl-tile", el("b", String(log.rows.length)), el("span", log.rows.length === 1 ? "session" : "sessions")),
      log.best ? el("div.wl-tile", el("b", log.best.value + unitSuffix(unit)), el("span", "best set"), el("small", fmt.dayLabel(log.best.day).split(",").slice(1).join("").trim())) : null,
      log.bestTotal ? el("div.wl-tile", el("b", String(log.bestTotal.value)), el("span", "best day"), el("small", fmt.dayLabel(log.bestTotal.day).split(",").slice(1).join("").trim())) : null,
    );
  }

  /** The bars: one per session, oldest left, the record's session lit, scaled to the best total. */
  function chart() {
    const series = log.series.slice(-CHART_MAX);
    if (series.length < 2) return null;
    const top = Math.max(...series.map((s) => s.total), 1);
    const bestDay = log.bestTotal ? log.bestTotal.day : null;
    return el("div.ex-chart",
      el("div.ex-bars", series.map((s) => el("i.ex-bar" + (s.day === bestDay ? ".is-best" : "") + (s.day === today ? ".is-today" : ""), {
        style: "height:" + Math.max(4, Math.round((s.total / top) * 100)) + "%",
        title: fmt.dayLabel(s.day) + " · " + total(s.total),
      }))),
      el("div.ex-chart-foot",
        el("span", fmt.dayLabel(series[0].day).split(",").slice(1).join("").trim()),
        el("span", log.series.length > CHART_MAX ? "last " + CHART_MAX + " of " + log.series.length : "session totals"),
        el("span", fmt.dayLabel(series[series.length - 1].day).split(",").slice(1).join("").trim()),
      ),
    );
  }

  /** One session of it: the date, the session it was in, the sets, the total and its change. */
  function row(r, i) {
    const before = log.rows[i + 1] ? log.rows[i + 1].total : null;
    const d = before === null ? null : r.total - before;
    const facts = [
      r.minutes ? r.minutes + " min" : null,
      r.kcalPerMin ? r.kcalPerMin.toFixed(1) + " kcal/min" : (r.kcal ? r.kcal + " kcal" : null),
      r.hrAvg ? "♥ " + r.hrAvg : null,
    ].filter(Boolean).join(" · ");
    return el("button.ex-row", { onclick: () => { if (onOpenWorkout) { sheet.close(); onOpenWorkout(r.day, r.sessionId); } } },
      dateBadge(r.day, today),
      el("span.ex-row-main",
        el("span.ex-row-head",
          el("span.ex-row-when", r.sessionName),
          el("span.ex-row-total", total(r.total),
            d ? el("span.wl-delta" + (d > 0 ? ".is-up" : ".is-down"), (d > 0 ? "+" : "−") + Math.abs(d)) : null),
        ),
        setsLine(r.sets, r.pb, unit),
        facts ? el("span.ex-row-facts", facts) : null,
      ),
      el("span.wl-row-go", "›"),
    );
  }

  function paint() {
    sheet.paint(
      el("div.form.ex",
        el("div.sheet-head", el("span.sheet-title", log.name + (log.rows.length && log.rows[0].perSide ? " · per side" : ""))),
        log.rows.length
          ? el("p.sheet-now", "Since " + fmt.dayLabel(log.rows[log.rows.length - 1].day) + " \u00b7 bars are session totals \u00b7 gold marks the record.")
          : el("p.sheet-now", "Not done yet."),
        tiles(),
        chart(),
        el("div.ex-list", log.rows.map(row)),
        el("div.sheet-actions", el("button.ghost", { onclick: () => sheet.close() }, "Close")),
      ),
    );
  }

  paint();
}
