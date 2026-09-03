// editor.js — adding and changing a habit.
//
// The form is ordered by what the answers depend on: what you're tracking decides the units and
// whether a watch can fill it in, the direction decides whether the number is a floor or a
// ceiling, and the cadence decides what a miss even means. Asking for the target first — the
// obvious opening question — would mean asking "how many?" before "how many of what, how often?".

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { saveHabit, deleteHabit, bindSource } from "../store.js";
import { uuid } from "../id.js";
import {
  METRIC, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, VISIBILITY, PERIOD, AUTOMATIC_SOURCES,
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
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "steps", auto: true, step: 500,
  },
  {
    key: "sleep", label: "Sleep", icon: "😴", metric: METRIC.SLEEP,
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "hours", auto: true, step: 0.25,
    toInput: (v) => Math.round((v / 60) * 100) / 100, fromInput: (v) => Math.round(v * 60),
  },
  {
    key: "calories", label: "Active calories", icon: "🔥", metric: METRIC.ACTIVE_CALORIES,
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "kcal", auto: true, step: 50,
  },
  {
    key: "puffs", label: "Vape puffs", icon: "💨", metric: METRIC.PUFFS,
    direction: AT_MOST, aggregate: AGGREGATE.SUM, unit: "puffs", step: 1,
  },
  {
    key: "screen", label: "Screen time", icon: "📱", metric: METRIC.SCREEN_MINUTES,
    direction: AT_MOST, aggregate: AGGREGATE.LAST, unit: "minutes", step: 15,
  },
  {
    key: "sessions", label: "Workouts", icon: "🏋", metric: METRIC.SESSIONS,
    direction: AT_LEAST, aggregate: AGGREGATE.SUM, unit: "times", step: 1,
  },
  {
    key: "amount", label: "Money saved", icon: "💰", metric: METRIC.AMOUNT,
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "", step: 100,
  },
  {
    key: "custom", label: "Something else", icon: "◆", metric: null,
    direction: AT_LEAST, aggregate: AGGREGATE.SUM, unit: "times", step: 1,
  },
];

const CADENCES = [
  { period: PERIOD.DAY, label: "Every day", note: "Judged one day at a time." },
  { period: PERIOD.WEEK, label: "Weekly", note: "Which days don't matter — only the total." },
  { period: PERIOD.MONTH, label: "Monthly", note: "One question, asked at the end of the month." },
];

const typeOf = (habit) =>
  TYPES.find((t) => t.metric && t.metric === habit?.metric) || TYPES[TYPES.length - 1];

const toInput = (type, v) => (type.toInput ? type.toInput(v) : v);
const fromInput = (type, v) => (type.fromInput ? type.fromInput(v) : Math.round(v));

export function openEditorSheet(host, { state, habitId, onDone }) {
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
    target: toInput(type0, existing?.target ?? 1),
    period: existing?.period || PERIOD.DAY,
    weight: existing?.weight ?? 1,
    scored: existing?.scored ?? true,
    visibility: existing?.visibility || VISIBILITY.FULL,
    taper: !!existing?.taper,
    tz: existing?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    dayStartHour: existing?.dayStartHour ?? 4,
    error: "",
    busy: false,
  };

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
            // Adopt the preset's shape wholesale. Keeping the old direction against a new metric
            // is how you end up with "at least 20 puffs a day".
            form.type = x;
            form.direction = x.direction;
            form.target = toInput(x, x.key === "sleep" ? 420 : x.key === "steps" ? 10000 : 1);
            paint();
          },
        }, x.icon + " " + x.label))),
        t.auto ? el("p.note-inline", "A watch can fill this in on its own.")
          : el("p.note-inline", "You'll log this one yourself."),

        el("h2.sec-title", "Goal"),
        el("div.chips",
          el("button.chip" + (!reduce ? ".on" : ""), {
            onclick: () => { form.direction = AT_LEAST; paint(); },
          }, "Build — at least"),
          el("button.chip" + (reduce ? ".on" : ""), {
            onclick: () => { form.direction = AT_MOST; paint(); },
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
            onchange: (e) => { form.scored = e.target.checked; paint(); },
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
        source: t.auto ? SOURCE.HEALTH_CONNECT : SOURCE.MANUAL,
      });
      // A new habit needs a source declared for ME, or every quiet period falls back to the
      // habit's default rather than to what this device can actually supply.
      if (form.isNew) {
        await bindSource(form.habitId, t.auto ? SOURCE.HEALTH_CONNECT : SOURCE.MANUAL);
      }
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
