// editor.js — adding and changing a habit.
//
// The form is ordered by what the answers depend on: what you're tracking decides the units and
// whether a watch can fill it in, the direction decides whether the number is a floor or a
// ceiling, and the cadence decides what a miss even means. Asking for the target first — the
// obvious opening question — would mean asking "how many?" before "how many of what, how often?".

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { confirmSheet } from "./confirmsheet.js";
import { saveHabit, deleteHabit, bindSource } from "../store.js";
import { sourceFor } from "../habits.js";
import { uuid } from "../id.js";
import { caps } from "../bridge.js";
import { categoryFor, CATEGORY_LABEL, CATEGORY_ICON } from "../score.js";
import {
  METRIC, SOURCE, AT_LEAST, AT_MOST, AGGREGATE, VISIBILITY, PERIOD, PAUSE_METRICS,
  HEALTH_METRICS, AUTOMATIC_SOURCES, sourceForDevice, SCORED_METRICS, PHONE_ESTIMATED,
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
    // The number the vape itself keeps, read off and entered once a day. LAST, not SUM: it is a
    // running total like steps are, and adding today's reading to yesterday's would double it.
    // SUM, not LAST, because puffs are counted AS THEY HAPPEN — a tap at a time through the day,
    // which is how the card is actually used. Taking the last reading would keep only the final
    // tap and report a day of eighty as one.
    key: "puffs", label: "Vape puffs", icon: "💨", metric: METRIC.PUFFS,
    direction: AT_MOST, aggregate: AGGREGATE.SUM, unit: "puffs", step: 5,
    start: 80, period: PERIOD.DAY,
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
    // Weekly, because that is how anybody actually says it. "Exercise three times a week" is not
    // "exercise 0.43 times a day", and a daily version marks every rest day a failure.
    key: "sessions", label: "Workouts", icon: "🏋", metric: METRIC.SESSIONS,
    direction: AT_LEAST, aggregate: AGGREGATE.SUM, unit: "times", step: 1,
    start: 3, period: PERIOD.WEEK,
  },
  {
    // A savings target is one question asked at the end of the month, not a daily interrogation.
    key: "amount", label: "Savings", icon: "💰", metric: METRIC.AMOUNT,
    direction: AT_LEAST, aggregate: AGGREGATE.LAST, unit: "", step: 100,
    start: 1000, period: PERIOD.MONTH,
  },
  {
    key: "custom", label: "Something else", icon: "◆", metric: null,
    direction: AT_LEAST, aggregate: AGGREGATE.SUM, unit: "times", step: 1,
    start: 1, period: PERIOD.DAY,
  },
];

/** ISO weekdays, Monday first, which is how a week is spoken here. */
const WEEKDAYS = [
  [1, "M"], [2, "T"], [3, "W"], [4, "T"], [5, "F"], [6, "S"], [7, "S"],
];

/** "07:00" from a minute of the day, and back. */
const toClock = (minute) =>
  String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
const fromClock = (text) => {
  const [h, m] = String(text || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(1439, h * 60 + m));
};

const CADENCES = [
  { period: PERIOD.DAY, label: "Every day", note: "Judged one day at a time." },
  { period: PERIOD.WEEK, label: "Weekly", note: "Which days don't matter — only the total." },
  { period: PERIOD.MONTH, label: "Monthly", note: "One question, asked at the end of the month." },
];

/** What the time field is promising, in the words of whichever cadence this is. */
function remindDayNote(cadence, form) {
  if (cadence.period !== PERIOD.DAY) {
    return form.remindDays.length === 7 ? "every day" : "on the days above";
  }
  return form.days.length < 7 ? "on the days above" : "every day";
}

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
    // No `direction`, `period`, `category` or `scored` on the form any more. All four are facts
    // about the KIND of habit rather than choices: a vape goal is a ceiling, workouts are counted
    // by the week, screen time is Discipline. Asking produced combinations nobody wanted — "at
    // least 20 puffs a day" was two taps away — and made the same habit score differently for two
    // people. They are shown, from the type, and not offered.
    // The preset's own starting point. Every type used to share one, and it was 1 — so opening
    // the editor and pressing Add gave you a goal of one step a day, and picking "Screen time"
    // gave you a one-minute daily ceiling you would fail every day for the rest of your life.
    target: toInput(type0, existing?.target ?? type0.start),
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
    days: Array.isArray(existing?.days) && existing.days.length ? [...existing.days] : [1, 2, 3, 4, 5, 6, 7],
    remindAt: existing?.remindAt ?? null,
    // Which weekdays the reminder fires on, for a habit whose cadence is longer than a day.
    // "Three workouts a week" says nothing about which three, so the engine ignores `days` for it
    // and a reminder had nothing to go on but "every morning" — which is how a nudge becomes noise.
    remindDays: Array.isArray(existing?.remindDays) && existing.remindDays.length
      ? [...existing.remindDays] : [1, 3, 5],
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
    if (PAUSE_METRICS.has(type.metric)) return "Goal Buddy counts this on the phone it's installed on.";
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
      }, PAUSE_METRICS.has(type.metric) ? "Goal Buddy counts it"
        // Named for what would actually answer it on THIS device. Offering "My watch" to somebody
        // with no watch, and then quietly filling it in from the phone, is how a number nobody
        // asked for turns up on the board.
        : deviceSource(type) === SOURCE.PHONE ? "Estimate it for me"
        : "My watch"),
      el("button.chip" + (!form.tracked ? ".on" : ""), {
        onclick: () => { form.tracked = false; paint(); },
      }, "I log it myself"),
    );
  }

  /** Why the choice matters, said in terms of the consequence rather than the mechanism. */
  function trackingNote(type) {
    if (couldBeAutomatic(type.metric) && !canTrackAutomatically(type)) {
      return PAUSE_METRICS.has(type.metric)
        ? "Only Goal Buddy on your phone can count this, and you're not in it right now — so this one "
          + "is yours to log here."
        : "This device can't read health data, so this one is yours to log here. On a phone with "
          + "Health Connect you can switch it over.";
    }
    if (PHONE_ESTIMATED.has(type.metric) && deviceSource(type) === SOURCE.PHONE) {
      return "No watch on this phone — but it can work this one out on its own.";
    }
    if (form.tracked && deviceSource(type) === SOURCE.PHONE) {
      // Said in full, before anybody is scored on it. A guess presented as a measurement is the
      // fastest way to lose somebody's trust in every other number on the screen.
      return "From how long your phone is left alone overnight — the last time you put it down to "
        + "the first time you unlock it. It's an estimate, and it's marked as one everywhere it "
        + "appears. A night it can't read counts as \"no data\", never as a miss.";
    }
    if (form.tracked) {
      return "Days it reports nothing count as \"no data\" rather than a miss, so a watch that "
        + "stops doesn't cost you the board.";
    }
    return form.type.direction === AT_MOST
      ? "A day you don't log counts as a miss \u2014 log a zero for a clean day."
      : "A day you don't log counts as a miss.";
  }

  function paint() {
    // Everything structural is read off the type, every repaint. Nothing below can drift from it,
    // because there is no second copy to drift.
    const t = form.type;
    const reduce = t.direction === AT_MOST;
    const cadence = CADENCES.find((c) => c.period === t.period);
    const category = categoryFor({ metric: t.metric });
    const counts = SCORED_METRICS.has(t.metric);

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
            form.target = toInput(x, x.start);
            form.tracked = canTrackAutomatically(x);
            paint();
          },
        }, x.icon + " " + x.label))),
        el("p.note-inline", metricNote(t)),

        el("h2.sec-title", "How is it tracked?"),
        trackingChoice(t),
        el("p.note-inline", trackingNote(t)),

        el("h2.sec-title", "Goal"),
        el("p.fact", reduce ? "Reduce — at most" : "Build — at least"),
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
        el("p.fact", cadence.label),
        el("p.note-inline", cadence.note),

        // Which days it applies to. Only for a daily habit, because that is the only place the
        // engine reads it: "three times a week" already says nothing about which three, and
        // printing Mon/Wed/Fri beside a weekly total would be a promise nothing keeps.
        cadence.period === PERIOD.DAY ? el("h2.sec-title", "Which days") : null,
        cadence.period === PERIOD.DAY ? el("div.chips.chips-days", WEEKDAYS.map(([n, label]) =>
          el("button.chip.chip-day" + (form.days.includes(n) ? ".on" : ""), {
            "aria-label": "Day " + n,
            onclick: () => {
              // Never allow zero days. A habit active on no days is EXEMPT for ever — it would sit
              // on the list looking tracked and quietly never be asked about again.
              const next = form.days.includes(n)
                ? form.days.filter((d) => d !== n)
                : [...form.days, n].sort();
              if (next.length) { form.days = next; paint(); }
            },
          }, label))) : null,
        cadence.period === PERIOD.DAY && form.days.length < 7
          ? el("p.note-inline", "The other days are rest days — they don't count against you.")
          : null,

        el("h2.sec-title", "Remind me"),
        el("div.chips",
          el("button.chip" + (form.remindAt == null ? ".on" : ""), {
            onclick: () => { form.remindAt = null; paint(); },
          }, "No reminder"),
          el("button.chip" + (form.remindAt != null ? ".on" : ""), {
            onclick: () => { if (form.remindAt == null) { form.remindAt = 19 * 60; paint(); } },
          }, "On the day"),
        ),
        // Which days to be nudged, for a habit judged over something longer than a day.
        //
        // "Three workouts a week" is deliberately silent about which three — that is the whole
        // point of a weekly target, and the engine keeps it that way. But a reminder has to land
        // on SOME day, and "every morning" for a thing you do three times is four wasted
        // notifications a week, which is how somebody learns to swipe them away.
        //
        // So this asks, and it changes nothing but the reminder. Miss a Wednesday and the week is
        // untouched; the total is still the only thing scored.
        form.remindAt != null && cadence.period !== PERIOD.DAY
          ? el("div.chips.chips-days", WEEKDAYS.map(([n, label]) =>
              el("button.chip.chip-day" + (form.remindDays.includes(n) ? ".on" : ""), {
                "aria-label": "Day " + n,
                onclick: () => {
                  const next = form.remindDays.includes(n)
                    ? form.remindDays.filter((d) => d !== n)
                    : [...form.remindDays, n].sort();
                  // Never none: a reminder switched on that fires on no day is a setting that lies.
                  if (next.length) { form.remindDays = next; paint(); }
                },
              }, label)))
          : null,
        // Said because the line above this section says the opposite about scoring, and the two
        // sitting together without a word would read as a contradiction rather than a division of
        // labour.
        form.remindAt != null && cadence.period !== PERIOD.DAY
          ? el("p.note-inline", "Which days to nudge you. The week is still judged on the total — "
              + "a missed Wednesday costs nothing on its own.")
          : null,
        form.remindAt != null ? el("label.inline-field",
          el("input", {
            type: "time",
            value: toClock(form.remindAt),
            oninput: (e) => {
              const m = fromClock(e.target.value);
              if (m != null) form.remindAt = m;
            },
          }),
          el("span", remindDayNote(cadence, form)),
        ) : null,
        el("p.note-inline", form.remindAt == null
          ? "Nothing will nudge you about this one."
          : "Goal Buddy raises this on your phone, so it arrives whether or not the app is open."),

        el("h2.sec-title", "Where it counts"),
        counts
          ? el("p.fact", CATEGORY_ICON[category] + " " + CATEGORY_LABEL[category])
          : el("p.fact.is-off", "Not on the board"),
        el("p.note-inline", counts
          ? "Each day is worth 100, split 40 / 30 / 15 / 15 across the four categories. The split "
            + "is the group's and is the same for everyone."
          // Said here rather than discovered later. Somebody adding a habit of their own is
          // entitled to know before they set a goal against it that it is not part of the contest.
          : "This one is yours alone. It shows on Today and keeps its streak, and it does not "
            + "count towards anyone's score — the board is the six the group agreed on."),


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
      form.error = "Give it a goal greater than zero.";
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
        // Straight off the type. Stored rather than derived on read so that a habit keeps the
        // shape it was created with even if a preset is ever retuned.
        direction: t.direction,
        target: fromInput(t, raw),
        period: t.period,
        category: categoryFor({ metric: t.metric }),
        visibility: form.visibility,
        taper: t.direction === AT_MOST && form.taper
          ? { amount: 1, everyDays: 7, floor: 0 } : null,
        days: t.period === PERIOD.DAY ? form.days : [1, 2, 3, 4, 5, 6, 7],
        remindAt: form.remindAt,
        remindDays: form.remindAt != null && t.period !== PERIOD.DAY ? form.remindDays : null,
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
    const sure = await confirmSheet(document.body, {
      title: "Delete " + (form.name || "this habit") + "?",
      body: "It goes for the whole group. Past entries are kept, so the history still reads "
        + "correctly — it just stops being tracked or scored from here on.",
      confirmLabel: "Delete it",
    });
    if (!sure) return;
    await deleteHabit(form.habitId);
    saved = true;
    sheet.close();
  }

  paint();
}
