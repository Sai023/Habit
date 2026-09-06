// travelsheet.js — booking a stretch of days off, and coming back.
//
// ---- Why this screen exists ----
//
// The engine has understood travel since the four states were written: EXEMPT is documented as
// "a rest day, Travel Mode, or a grace token spent", replay honours it, exempt days are left out
// of scoring and PRESERVE a streak rather than breaking it. All of that was built, tested, and
// reachable by nobody — there was no way in from either the page or the shell, so a holiday broke
// every streak in the group and the only advice available was "don't go".
//
// ---- Why it cannot be backdated ----
//
// An exemption DELETES days rather than adding them, which makes "I was away last week" the
// cleanest cheat the app could offer: any bad run could be excused after the fact by the person
// who had it, and nothing in the log would say so. So the earliest day this offers is today, and
// replay enforces the same rule rather than trusting the form — see the T.EXEMPT case.
//
// Coming home early is the one edit allowed, and it only ever moves the last day earlier.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { confirmSheet } from "./confirmsheet.js";
import { setTravelMode, endTravelMode } from "../store.js";
import { addDays, daysBetween, travelPeriod } from "../habits.js";
import * as fmt from "./format.js";

/** How long a trip usually is, offered so nobody has to count days on a calendar. */
const LENGTHS = [
  { days: 2, label: "A weekend" },
  { days: 7, label: "A week" },
  { days: 14, label: "Two weeks" },
];

export function openTravelSheet(host, { state, me, today, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone({ saved }) });
  let saved = false;
  let busy = false;
  let error = "";

  const booked = travelPeriod(state, me, today);
  const form = { from: today, to: addDays(today, 6) };

  /** Never before today, and never ending before it starts. */
  function fix() {
    if (daysBetween(form.from, today) > 0) form.from = today;
    if (daysBetween(form.from, form.to) < 0) form.to = form.from;
  }

  const nights = () => daysBetween(form.from, form.to) + 1;

  async function start() {
    if (busy) return;
    busy = true; error = ""; paint();
    try {
      await setTravelMode(form.from, form.to);
      saved = true;
      sheet.close();
    } catch (err) {
      error = "Couldn't save: " + (err && err.message ? err.message : err);
      busy = false;
      paint();
    }
  }

  /** Home early, or a trip that is not happening. Both are the same edit. */
  async function end(period) {
    const running = daysBetween(period.from, today) >= 0;
    const ok = await confirmSheet(host, {
      title: running ? "Back early?" : "Cancel this?",
      body: running
        ? "Today counts again from now on. The days you were away stay exempt — they are already "
          + "behind you, and nothing here can reach back and change them."
        : "Nothing was exempt yet, so nothing changes. You can book it again any time.",
      confirmLabel: running ? "I'm back" : "Cancel it",
      cancelLabel: running ? "Still away" : "Keep it",
    });
    if (!ok) return;
    busy = true; paint();
    try {
      // Home today means today is judged again, so the exemption has to end yesterday.
      await endTravelMode(period.exemptId, period.from, running ? addDays(today, -1) : null);
      saved = true;
      sheet.close();
    } catch (err) {
      error = "Couldn't save: " + (err && err.message ? err.message : err);
      busy = false;
      paint();
    }
  }

  function bookedView(period) {
    const running = daysBetween(period.from, today) >= 0;
    const left = daysBetween(today, period.to) + 1;
    return el("div.form",
      el("div.sheet-head", el("span.sheet-title", running ? "You're away" : "Travel booked")),
      el("div.travel-dates",
        el("span", fmt.dayLabel(period.from)),
        el("span.season-arrow", "→"),
        el("span", fmt.dayLabel(period.to)),
      ),
      el("p.sheet-now", running
        ? (left === 1 ? "Back tomorrow." : left + " days left, including today.")
          + " Nothing counts against you and every streak is held where it was."
        : "Starts " + fmt.dayLabel(period.from) + ". Until then everything is scored as usual."),
      el("p.note-inline",
        "Reminders are off for these days and come back on their own the morning after."),
      error ? el("p.err", error) : null,
      el("button.tap", { onclick: () => end(period), disabled: busy },
        running ? "I'm back early" : "Cancel this trip"),
    );
  }

  function form_() {
    fix();
    const n = nights();
    return el("div.form",
      el("div.sheet-head", el("span.sheet-title", "Travel mode")),
      el("p.sheet-now",
        "Days you are away are left out of the score rather than counted against you, and your "
        + "streaks are held where they are — you come back to the run you left with."),

      el("h2.sec-title", "From"),
      el("label.inline-field",
        el("input", {
          type: "date", value: form.from, min: today,
          oninput: (e) => {
            if (!e.target.value) return;
            form.from = e.target.value;
            // Dragging the start past the end takes the end with it, rather than erroring at
            // somebody for a range they are halfway through typing.
            if (daysBetween(form.from, form.to) < 0) form.to = form.from;
            paint();
          },
        }),
        el("span", daysBetween(today, form.from) === 0 ? "today" : fmt.dayLabel(form.from)),
      ),
      // Said once, plainly, rather than left for somebody to discover when the picker refuses.
      el("p.note-inline",
        "Today at the earliest. A day that has already happened cannot be excused — that would "
        + "make travel a way to delete a bad week rather than to take one off."),

      el("h2.sec-title", "Until"),
      el("label.inline-field",
        el("input", {
          type: "date", value: form.to, min: form.from,
          oninput: (e) => {
            if (!e.target.value) return;
            form.to = e.target.value;
            paint();
          },
        }),
        el("span", n === 1 ? "1 day" : n + " days"),
      ),
      el("div.chips.chips-tight", LENGTHS.map((l) => el("button.chip", {
        onclick: () => { form.to = addDays(form.from, l.days - 1); paint(); },
      }, l.label))),

      el("h2.sec-title", "While you're away"),
      el("ul.travel-list",
        el("li", "Daily habits are paused — not counted against you, and not counted for you."),
        // Said here rather than discovered on the board. A trip that covers three days of a week
        // does not excuse the week: "three workouts a week" with one day abroad is still three
        // workouts a week, and the engine is right to keep asking. Promising otherwise would be
        // the more comfortable line and the one that loses somebody a week.
        el("li", "A weekly or monthly goal only pauses if the whole week or month is covered — "
          + "otherwise it is still winnable, so it still counts."),
        el("li", "Every paused streak is held where it is."),
        el("li", "Reminders are off, and come back on the morning after you return."),
      ),

      error ? el("p.err", error) : null,
      el("button.tap", { onclick: start, disabled: busy },
        busy ? "Saving…" : "Book " + (n === 1 ? "1 day" : n + " days") + " off"),
    );
  }

  function paint() {
    sheet.paint(booked ? bookedView(booked) : form_());
  }

  paint();
}
