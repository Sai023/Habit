// editor.js — adding and changing a habit.
//
// The form is ordered by what the answers depend on: what you're tracking decides the units and
// whether a watch can fill it in, the direction decides whether the number is a floor or a
// ceiling, and the cadence decides what a miss even means. Asking for the target first — the
// obvious opening question — would mean asking "how many?" before "how many of what, how often?".

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { saveHabit, deleteHabit, bindSource } from "../store.js";
import { sourceFor } from "../habits.js";
import { uuid } from "../id.js";
import { caps } from "../bridge.js";
import {
  METRIC, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, VISIBILITY, PERIOD, PAUSE_METRICS,
  HEALTH_METRICS, AUTOMATIC_SOURCES, sourceForDevice,
} from "../schema.js";

/**
 * The kinds of thing a habit can measure.
 *
 * A preset rather than a pile of dropdowns, because metric, direction and aggregation are not
 * independent choices — "steps" is a running total you want more of, "puffs" is a count of
 * separate events you want fewer of, and letting someone combine those freely mostly produces
 * habits that silently never work.
 */
const TYPES = [
  {
    key: "steps", label: "Steps", icon: "👟", metric: METRIC.STEPS,
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "steps", step: 500,
    start: 10000, period: PERIOD.DAY,
  },
  {
    key: "sleep", label: "Sleep", icon: "😴", metric: METRIC.SLEEP,
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "hours", step: 0.25,
    start: 420, period: PERIOD.DAY,
    toInput: (v) => Math.round((v / 60) * 100) / 100, fromInput: (v) => Math.round(v * 60),
  },
  {
    key: "calories", label: "Active calories", icon: "🔥", metric: METRIC.ACTIVE_CALORIES,
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "kcal", step: 50,
    start: 400, period: PERIOD.DAY,
  },
  {
    // The number the vape itself keeps, read off and entered once a day. LAST, not SUM: it is a
    // running total like steps are, and adding today's reading to yesterday's would double it.
    key: "puffs", label: "Vape puffs", icon: "💨", metric: METRIC.PUFFS,
    direction: AT_MOST, aggregate: AGGREGATE.LAST, unit: "puffs", step: 10,
    start: 200, period: PERIOD.DAY,
  },
  {
    // The other half, and a genuinely different measurement: not how much you vaped but how often
    // you wanted to and what came of it. Discrete events, so SUM, and the breathing screen is what
    // records them.
    key: "urges", label: "Vape urges", icon: "🧘", metric: METRIC.URGES,
    direction: AT_MOST, aggregate: AGGREGATE.SUM, unit: "given in", step: 1,
    start: 5, period: PERIOD.DAY,
  },
  {
    // Fed by Pause itself. Not a watch metric and not really a manual one either — the phone
    // running the intervention screen is the only thing that can answer it, which is most of the
    // reason the two apps became one.
    key: "screen", label: "Screen time", icon: "📱", metric: METRIC.SCREEN_MINUTES,
    direction: AT_MOST, aggregate: AGGREGATE.LAST, unit: "minutes", step: 15,
    start: 120, period: PERIOD.DAY,
  },
  {
    key: "opens", label: "App opens", icon: "🔓", metric: METRIC.APP_OPENS,
    direction: AT_MOST, aggregate: AGGREGATE.LAST, unit: "times", step: 5,
    start: 40, period: PERIOD.DAY,
  },
  {
    // Weekly, because that is how anybody actually says it. "Exercise three times a week" is not
    // "exercise 0.43 times a day", and a daily version marks every rest day a failure.
    key: "sessions", label: "Workouts", icon: "🏋", metric: METRIC.SESSIONS,
    direction: AT_LEAST, aggregate: AGGREGATE.SUM, unit: "times", step: 1,
    start: 3, period: PERIOD.WEEK,
  },
  {
    // A savings target is one question asked at the end of the month, not a daily interrogation.
    key: "amount", label: "Money saved", icon: "💰", metric: METRIC.AMOUNT,
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "", step: 100,
    start: 1000, period: PERIOD.MONTH,
  },
  {
    key: "custom", label: "Something else", icon: "◆", metric: null,
    direction: AT_LEAST, aggregate: AGGREGATE.SUM, unit: "times", step: 1,
    start: 1, period: PERIOD.DAY,
  },
];

const CADENCES = [
  { period: PERIOD.DAY, label: "Every day", note: "Judged one day at a time." },
  { period: PERIOD.WEEK, label: "Weekly", note: "Which days don't matter — only the total." },
  { period: PERIOD.MONTH, label: "Monthly", note: "One question, asked at the end of the month." },
];

const typeOf = (habit) =>
  TYPES.find((t) => t.metric && t.metric === habit?.metric) || TYPES[TYPES.length - 1];

/** Could anything ever read this metric, on any device? */
const couldBeAutomatic = (metric) => HEALTH_METRICS.has(metric) || PAUSE_METRICS.has(metric);

const toInput = (type, v) => (type.toInput ? type.toInput(v) : v);
const fromInput = (type, v) => (type.fromInput ? type.fromInput(v) : Math.round(v));

export function openEditorSheet(host, { state, habitId, me, onDone }) {
  let saved = false;
  const sheet = openSheet(host, { onClose: () => onDone({ saved }) });

  const existing = habitId ? state.habits.get(habitId) : null;
  const type0 = existing ? typeOf(existing) : TYPES[0];

  const form = {
    habitId: habitId || uuid(),
    isNew: !existing,
    name: existing?.name || "",
    type: type0,
    direction: existing?.direction || type0.direction,
    // The preset's own starting point. Every type used to share one, and it was 1 — so opening
    // the editor and pressing Add gave you a goal of one step a day, and picking "Screen time"
    // gave you a one-minute daily ceiling you would fail every day for the rest of your life.
    target: toInput(type0, existing?.target ?? type0.start),
    period: existing?.period || type0.period,
    weight: existing?.weight ?? 1,
    // Reduce habits opt OUT of the board by default, which is what the schema has always said and
    // what the warning below this checkbox says. The form used to tick it regardless.
    scored: existing?.scored ?? (type0.direction === AT_LEAST),
    // Whether the person has overruled that. Until they do, it follows the direction they pick.
    scoredTouched: existing != null,
    // Whether this habit is fed by a sensor or typed in. A CHOICE, not an inference: it decides
    // how every quiet day this member ever has is judged, and the leaderboard is built on that.
    //
    // Starts from what this device can do, narrowed by what was already recorded for this member.
    // Never true when the device cannot actually deliver it, whatever the group's default says —
    // otherwise a browser would open showing "My watch" selected and greyed out at once.
    tracked: canTrackAutomatically(type0)
      && (existing ? AUTOMATIC_SOURCES.has(sourceFor(state, existing, me)) : true),
    visibility: existing?.visibility || VISIBILITY.FULL,
    taper: !!existing?.taper,
    tz: existing?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    dayStartHour: existing?.dayStartHour ?? 4,
    error: "",
    busy: false,
  };

  /** Where this metric's numbers would actually come from, on the device reading this. */
  function deviceSource(type) {
    const c = caps();
    return sourceForDevice(type.metric, { pause: c.embedded, health: c.healthConnect });
  }

  /** What this device is even capable of, which is not the same as what you have chosen. */
  function canTrackAutomatically(type) {
    return deviceSource(type) !== SOURCE.MANUAL;
  }

  /** What the metric is, before anyone chooses how to feed it. */
  function metricNote(type) {
    if (type.metric === null) return "Anything you want to count. You'll set the units by name.";
    if (PAUSE_METRICS.has(type.metric)) return "Pause counts this on the phone it's installed on.";
    if (HEALTH_METRICS.has(type.metric)) return "A watch or phone can read this through Health Connect.";
    return "No sensor can read this one — it's yours to log.";
  }

  /**
   * The choice, rather than the guess.
   *
   * This used to be inferred from the metric and stated back as a sentence, which read as
   * information and was actually a decision being taken on somebody's behalf. It is the decision
   * that says how every quiet day this person ever has is judged, and the whole board rests on
   * that, so they get to make it.
   *
   * "Automatically" only appears when THIS device can genuinely supply the metric. Offering it in
   * a browser, or on a phone with no Health Connect, would let someone promise a pipeline that
   * does not exist — and every miss they went on to have would be quietly excused as an outage.
   */
  function trackingChoice(type) {
    if (!couldBeAutomatic(type.metric)) {
      return el("div.chips", el("button.chip.on", { disabled: true }, "You log it"));
    }
    const can = canTrackAutomatically(type);
    return el("div.chips",
      el("button.chip" + (form.tracked ? ".on" : ""), {
        disabled: !can,
        onclick: () => { if (can) { form.tracked = true; paint(); } },
      }, PAUSE_METRICS.has(type.metric) ? "Pause counts it" : "My watch"),
      el("button.chip" + (!form.tracked ? ".on" : ""), {
        onclick: () => { form.tracked = false; paint(); },
      }, "I log it myself"),
    );
  }

  /** Why the choice matters, said in terms of the consequence rather than the mechanism. */
  function trackingNote(type) {
    if (couldBeAutomatic(type.metric) && !canTrackAutomatically(type)) {
      return PAUSE_METRICS.has(type.metric)
        ? "Only Pause on your phone can count this, and you're not in it right now — so this one "
          + "is yours to log here."
        : "This device can't read health data, so this one is yours to log here. On a phone with "
          + "Health Connect you can switch it over.";
    }
    if (form.tracked) {
      return "Days it reports nothing count as \"no data\" rather than a miss, so a watch that "
        + "stops doesn't cost you the board.";
    }
    return form.direction === AT_MOST
      ? "A day you don't log counts as a miss \u2014 log a zero for a clean day."
      : "A day you don't log counts as a miss.";
  }

  function paint() {
    const t = form.type;
    const reduce = form.direction === AT_MOST;

    sheet.paint(
      el("div.form",
        el("h1", form.isNew ? "New habit" : "Edit habit"),

        el("label.field",
          el("span.field-label", "Name"),
          el("input", {
            value: form.name, placeholder: t.label,
            oninput: (e) => { form.name = e.target.value; },
          }),
        ),

        el("h2.sec-title", "What are you tracking?"),
        el("div.chips", TYPES.map((x) => el("button.chip" + (x.key === t.key ? ".on" : ""), {
          onclick: () => {
            if (x.key === t.key) return; // re-tapping the current one would wipe what you typed
            // Adopt the preset's shape wholesale. Keeping the old direction against a new metric
            // is how you end up with "at least 20 puffs a day", and keeping a daily cadence
            // against a savings target is how you get asked about it every morning.
            form.type = x;
            form.direction = x.direction;
            form.target = toInput(x, x.start);
            form.period = x.period;
            form.tracked = canTrackAutomatically(x);
            if (!form.scoredTouched) form.scored = x.direction === AT_LEAST;
            paint();
          },
        }, x.icon + " " + x.label))),
        el("p.note-inline", metricNote(t)),

        el("h2.sec-title", "How is it tracked?"),
        trackingChoice(t),
        el("p.note-inline", trackingNote(t)),

        el("h2.sec-title", "Goal"),
        el("div.chips",
          el("button.chip" + (!reduce ? ".on" : ""), {
            onclick: () => {
              form.direction = AT_LEAST;
              if (!form.scoredTouched) form.scored = true;
              paint();
            },
          }, "Build — at least"),
          el("button.chip" + (reduce ? ".on" : ""), {
            onclick: () => {
              form.direction = AT_MOST;
              if (!form.scoredTouched) form.scored = false;
              paint();
            },
          }, "Reduce — at most"),
        ),
        el("label.inline-field",
          el("input", {
            type: "number", step: t.step, min: "0", inputmode: "decimal",
            value: form.target,
            oninput: (e) => { form.target = e.target.value; },
          }),
          el("span", t.unit || "per period"),
        ),
        reduce ? el("label.check",
          el("input", {
            type: "checkbox", checked: form.taper,
            onchange: (e) => { form.taper = e.target.checked; },
          }),
          el("span", "Lower it by one every week, until it reaches zero"),
        ) : null,

        el("h2.sec-title", "How often"),
        el("div.chips", CADENCES.map((c) => el("button.chip" + (c.period === form.period ? ".on" : ""), {
          onclick: () => { form.period = c.period; paint(); },
        }, c.label))),
        el("p.note-inline", CADENCES.find((c) => c.period === form.period).note),

        el("h2.sec-title", "On the board"),
        el("label.check",
          el("input", {
            type: "checkbox", checked: form.scored,
            onchange: (e) => { form.scored = e.target.checked; form.scoredTouched = true; paint(); },
          }),
          el("span", "Count this towards the crown"),
        ),
        reduce && form.scored
          ? el("p.note-inline",
              "⚠ Reduce habits are usually left off. Being bottom of a quitting metric tends to " +
              "produce hidden logs rather than quitting.")
          : null,
        form.scored ? el("label.inline-field",
          el("input", {
            type: "number", step: "0.5", min: "0.5", max: "10", inputmode: "decimal",
            value: form.weight,
            oninput: (e) => { form.weight = e.target.value; },
          }),
          el("span", "× how much it counts, next to your other habits"),
        ) : null,

        el("h2.sec-title", "What the group sees"),
        el("div.chips",
          [[VISIBILITY.FULL, "My numbers"], [VISIBILITY.PROGRESS, "Progress only"], [VISIBILITY.PRIVATE, "Just ✓ / ✗"]]
            .map(([v, label]) => el("button.chip" + (form.visibility === v ? ".on" : ""), {
              onclick: () => { form.visibility = v; paint(); },
            }, label)),
        ),

        form.error ? el("p.err", form.error) : null,
        el("button.tap", { onclick: submit, disabled: form.busy },
          form.busy ? "Saving…" : form.isNew ? "Add habit" : "Save changes"),
        !form.isNew ? el("button.link.danger", { onclick: remove }, "Delete this habit") : null,
      ),
    );
  }

  async function submit() {
    if (form.busy) return;
    const raw = Number(form.target);
    if (!Number.isFinite(raw) || raw <= 0) {
      form.error = "Give it a target greater than zero.";
      return paint();
    }
    form.busy = true; form.error = ""; paint();
    try {
      const t = form.type;
      await saveHabit(form.habitId, {
        name: form.name.trim() || t.label,
        icon: t.icon,
        metric: t.metric,
        aggregate: t.aggregate,
        direction: form.direction,
        target: fromInput(t, raw),
        period: form.period,
        weight: Number(form.weight) > 0 ? Number(form.weight) : 1,
        scored: form.scored,
        visibility: form.visibility,
        taper: form.direction === AT_MOST && form.taper
          ? { amount: 1, everyDays: 7, floor: 0 } : null,
        tz: form.tz,
        dayStartHour: form.dayStartHour,
        // The habit's own default is the BEST source the metric could ever have, because it is
        // the group's answer rather than this device's — somebody joining later on a phone that
        // can read it should not inherit whatever this browser happened to be able to do.
        source: sourceForDevice(t.metric, { pause: true, health: true }),
      });
      // The binding is this member's own answer, and now it is the one they actually gave. It is
      // written on every save rather than only on the first, because changing your mind about how
      // a habit is fed is exactly the kind of thing people do in an edit screen.
      await bindSource(form.habitId, form.tracked ? deviceSource(t) : SOURCE.MANUAL);
      saved = true;
      sheet.close();
    } catch (err) {
      form.error = "Couldn't save: " + (err && err.message ? err.message : err);
      form.busy = false;
      paint();
    }
  }

  async function remove() {
    // Logs are left alone on purpose: a deleted habit stops being tracked, but the history stays
    // in the log, so bringing it back does not start anyone from zero.
    if (!confirm("Delete this habit for the whole group? Past entries are kept.")) return;
    await deleteHabit(form.habitId);
    saved = true;
    sheet.close();
  }

  paint();
}
