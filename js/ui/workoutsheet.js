// workoutsheet.js — today's session, one set at a time.
//
// ---- What it is for ----
//
// Two people have personal programs written as documents. This puts today's session from that
// document on screen and takes the reps against it as they go, so the document stops being a
// thing to remember and the history stops being a thing to reconstruct.
//
// ---- The one design rule ----
//
// A set costs one tap. Everything here follows from that. The number a set opens on is what you
// did last time (or the program's floor), so "Done" is the whole interaction when nothing changed;
// "+" then "Done" when you beat it. One set is active at a time, big enough to hit with a wet thumb,
// and banking it moves you on and starts the rest clock without being asked. Tapping any other
// set makes it the active one, so nothing is trapped behind an order.
//
// ---- What survives closing the app ----
//
// Everything banked, until Finish. The draft lives in localStorage keyed on the day and the
// session, so a phone that locks mid-workout — which is every phone, mid-workout — reopens on the
// same set. Finish writes the log and clears the draft; Cancel keeps it, because a set you did is
// a set you did whether or not you finished the session.
//
// ---- Rope days ----
//
// Ivan's rope sessions are intervals, not sets: a length of work, a length of rest, a number of
// rounds, all stepping up by which week of the program he is in. That is a timer, not a stepper,
// and it gets its own screen below. The core finisher that follows it is an ordinary sets session
// and reuses the ordinary screen.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { confirmSheet } from "./confirmsheet.js";
import { finishWorkout } from "../store.js";
import {
  planFor, intervalsFor, lastSession, prefill, prescription, unitOf, isComplete, progress,
} from "../workout.js";
import * as fmt from "./format.js";

/** One draft per session, so a rope day and the finisher that follows it do not share a slot. */
const draftKey = (sessionId) => "workout-draft:" + sessionId;

/** "0:47" */
function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/** A short buzz where the phone allows one. Silent failure everywhere else. */
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not a phone */ }
}

function loadDraft(programId, sessionId, day) {
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d.programId === programId && d.sessionId === sessionId && d.day === day) return d;
  } catch { /* corrupt or unavailable */ }
  return null;
}
function saveDraft(d) {
  try { localStorage.setItem(draftKey(d.sessionId), JSON.stringify(d)); } catch { /* full or unavailable */ }
}
function clearDraft(sessionId) {
  try { localStorage.removeItem(draftKey(sessionId)); } catch { /* ignore */ }
}

/**
 * Open today's session for a program. Says so and offers nothing on a rest day.
 */
export function openWorkoutSheet(host, { state, program, me, today, onDone }) {
  const plan = planFor(program, today);
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });

  if (!plan || plan.rest) {
    sheet.paint(
      el("div.form",
        el("div.sheet-head", el("span.sheet-title", program.name)),
        el("p.wo-rest-title", plan ? plan.rest : "Nothing today"),
        el("p.sheet-now", plan && plan.note ? plan.note : "Nothing to log today. See you tomorrow."),
        el("button.tap", { onclick: () => sheet.close() }, "OK"),
      ),
    );
    return;
  }

  const session = plan.session;
  if (session.kind === "intervals") return ropeSession(sheet, { state, program, session, me, today });
  return setsSession(sheet, { state, program, session, me, today });
}

// ---------------------------------------------------------------------------
// Sets and circuits
// ---------------------------------------------------------------------------

function setsSession(sheet, { state, program, session, me, today, finisherOf = null, onFinished = null, historyId = null }) {
  // A finisher's sets are stored inside the rope day's event, so last time is looked up under the
  // rope's id rather than the finisher's own.
  const previous = lastSession(state, me, historyId || session.id, today);
  const exercises = session.exercises;
  const isCircuit = session.kind === "circuit";

  // draft[exerciseId] = [n, n, ...]  — banked sets. undefined slots are not yet done.
  const saved = loadDraft(program.id, session.id, today);
  const draft = (saved && saved.draft) || {};
  // Which set is active: the first unbanked one, in order.
  let active = firstOpen();
  // The number in the active set's stepper. Starts on the prefill.
  let value = active ? prefill(exercises[active.ex], previous, active.set) : 0;
  let rest = null;       // { until: ms, total: s } while the rest clock runs
  let restTimer = null;
  let busy = false;

  function firstOpen() {
    for (let i = 0; i < exercises.length; i += 1) {
      const banked = draft[exercises[i].id] || [];
      for (let s = 0; s < exercises[i].sets; s += 1) {
        if (!Number.isFinite(banked[s])) return { ex: i, set: s };
      }
    }
    return null;
  }

  function persist() {
    saveDraft({ programId: program.id, sessionId: session.id, day: today, draft });
  }

  function focus(ex, set) {
    active = { ex, set };
    const banked = draft[exercises[ex].id] || [];
    value = Number.isFinite(banked[set]) ? banked[set] : prefill(exercises[ex], previous, set);
    paint();
  }

  function bank() {
    if (!active) return;
    const ex = exercises[active.ex];
    const list = draft[ex.id] || (draft[ex.id] = []);
    list[active.set] = value;
    persist();
    buzz(20);
    // Move on, and start the clock. Between sets of one exercise the rest is the session's; a
    // circuit rests only between ROUNDS, which is the same "set index" across every exercise.
    const next = firstOpen();
    const roundEnded = isCircuit && (!next || next.set !== active.set);
    const startClock = isCircuit ? roundEnded : true;
    active = next;
    value = active ? prefill(exercises[active.ex], previous, active.set) : 0;
    if (startClock && active) startRest(session.restSeconds || 60);
    paint();
  }

  function startRest(seconds) {
    stopRest();
    rest = { until: Date.now() + seconds * 1000, total: seconds };
    restTimer = setInterval(() => {
      if (!rest) return;
      if (Date.now() >= rest.until) { buzz([60, 40, 60]); stopRest(); }
      paint();
    }, 250);
  }
  function stopRest() {
    if (restTimer) clearInterval(restTimer);
    restTimer = null;
    rest = null;
  }

  async function finish() {
    if (busy) return;
    const done = progress(session, draft);
    if (!isComplete(session, draft)) {
      const ok = await confirmSheet(document.body, {
        title: "Finish with " + done.done + " of " + done.of + " sets?",
        body: "It still counts as a workout. The sets you skipped just won't be in the history.",
        confirmLabel: "Finish", cancelLabel: "Keep going",
      });
      if (!ok) return;
    }
    busy = true; paint();
    try {
      const exercisesOut = exercises.map((ex) => ({
        id: ex.id,
        sets: (draft[ex.id] || []).slice(0, ex.sets).map((n) => (Number.isFinite(n) ? n : null)),
      }));
      if (onFinished) {
        // A finisher hands its sets back to the rope session, which writes one event for the day.
        await onFinished(exercisesOut);
      } else {
        await finishWorkout({ programId: program.id, sessionId: session.id, day: today, exercises: exercisesOut });
      }
      clearDraft(session.id);
      stopRest();
      sheet.close();
    } catch (err) {
      busy = false;
      paint();
      const { showProblem } = await import("./problem.js");
      showProblem("Couldn't save the workout: " + (err && err.message ? err.message : err));
    }
  }

  function setTile(ex, exIndex, setIndex) {
    const banked = draft[ex.id] || [];
    const isActive = active && active.ex === exIndex && active.set === setIndex;
    const done = Number.isFinite(banked[setIndex]);
    const shown = done ? banked[setIndex] : prefill(ex, previous, setIndex);
    return el("button.wo-set" + (done ? ".is-done" : "") + (isActive ? ".is-active" : ""), {
      onclick: () => focus(exIndex, setIndex),
      "aria-label": "Set " + (setIndex + 1) + (done ? ", done, " + shown : ""),
    },
      el("span.wo-set-n", String(shown)),
      el("span.wo-set-i", done ? "✓" : String(setIndex + 1)),
    );
  }

  function activeControl(ex) {
    const unit = unitOf(ex);
    const step = ex.seconds ? 5 : 1;
    return el("div.wo-active",
      el("div.wo-stepper",
        el("button.step", { onclick: () => { value = Math.max(0, value - step); paint(); }, "aria-label": "Less" }, "−"),
        el("div.wo-value", String(value), el("span.wo-unit", " " + unit + (ex.perSide ? "/side" : ""))),
        el("button.step", { onclick: () => { value += step; paint(); }, "aria-label": "More" }, "+"),
      ),
      el("button.tap.wo-done", { onclick: bank },
        "Done" + (active ? " · set " + (active.set + 1) + " of " + ex.sets : "")),
    );
  }

  function exerciseCard(ex, i) {
    const isActiveEx = active && active.ex === i;
    const lastTime = previous && previous.exercises.find((e) => e.id === ex.id);
    return el("section.wo-ex" + (isActiveEx ? ".is-active" : ""),
      el("div.wo-ex-head",
        el("span.wo-ex-name", ex.name),
        el("span.wo-ex-rx", prescription(ex)),
      ),
      el("div.wo-sets", Array.from({ length: ex.sets }, (_, s) => setTile(ex, i, s))),
      isActiveEx ? activeControl(ex) : null,
      // The cue while it is the thing you are doing; the watch-for underneath, quieter.
      isActiveEx && ex.cue ? el("p.wo-cue", "💡 " + ex.cue) : null,
      isActiveEx && ex.watch ? el("p.wo-watch", "Watch for: " + ex.watch) : null,
      lastTime && lastTime.sets.length
        ? el("p.wo-last", "Last time: " + lastTime.sets.filter(Number.isFinite).join(" · ") + " " + unitOf(ex))
        : null,
    );
  }

  function paint() {
    const done = progress(session, draft);
    sheet.paint(
      el("div.form.wo",
        el("div.sheet-head",
          el("span.sheet-title", (finisherOf ? finisherOf + " · " : "") + session.name),
          el("span.wo-progress", done.done + " of " + done.of + (isCircuit ? " rounds" : " sets")),
        ),
        el("div.wo-bar", el("i", { style: "width:" + Math.round((done.done / Math.max(1, done.of)) * 100) + "%" })),
        session.intro ? el("p.sheet-now", session.intro) : null,
        previous ? el("p.note-inline", "Prefilled from " + fmt.dayLabel(previous.day) + ". Tap + when you beat it.") : null,

        rest
          ? el("div.wo-rest",
              el("span.wo-rest-label", "Rest"),
              el("b.wo-rest-clock", clock((rest.until - Date.now()) / 1000)),
              el("button.link", { onclick: () => { stopRest(); paint(); } }, "Skip"),
            )
          : null,

        exercises.map(exerciseCard),

        el("div.sheet-actions",
          el("button.ghost", { onclick: () => { stopRest(); sheet.close(); } }, "Later"),
          el("button.tap", { onclick: finish, disabled: busy },
            busy ? "Saving…" : (finisherOf ? "Finish " + session.name.toLowerCase() : "Finish workout")),
        ),
        el("p.note-inline", "Closing keeps what you've banked. Finish writes it down and counts the workout."),
      ),
    );
  }

  paint();
}

// ---------------------------------------------------------------------------
// Rope: intervals, then the finisher
// ---------------------------------------------------------------------------

function ropeSession(sheet, { state, program, session, me, today }) {
  const rx = intervalsFor(program, session, today);
  const saved = loadDraft(program.id, session.id, today);
  // The lengths in force: the low end of the range until the person bumps them.
  let work = (saved && saved.work) || rx.work[0];
  let restLen = (saved && saved.rest) || rx.rest[0];
  let target = rx.rounds[0];
  let completed = (saved && saved.rounds) || 0;

  let phase = "idle";      // idle | work | rest | done
  let until = 0;           // when the current phase ends
  let timer = null;
  let busy = false;

  function persist() {
    saveDraft({ programId: program.id, sessionId: session.id, day: today, rounds: completed, work, rest: restLen });
  }

  function start() {
    phase = "work";
    until = Date.now() + work * 1000;
    tick();
    timer = setInterval(tick, 250);
  }
  function tick() {
    if (phase === "idle" || phase === "done") return;
    if (Date.now() < until) { paint(); return; }
    if (phase === "work") {
      completed += 1;
      persist();
      buzz([80, 40, 80]);
      if (completed >= target) { phase = "done"; stop(); paint(); return; }
      phase = "rest";
      until = Date.now() + restLen * 1000;
    } else {
      buzz(120);
      phase = "work";
      until = Date.now() + work * 1000;
    }
    paint();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  function pause() { stop(); phase = "idle"; paint(); }

  function finisher() {
    // Hand over to the ordinary sets screen for the core finisher. Its Finish comes back here
    // with the sets, and one event is written for the whole rope day.
    stop();
    // Its own id for the draft, or its sets would overwrite the rope's banked rounds under the
    // same key. The event it produces is still the rope session's — see onFinished.
    const fin = { ...session.finisher, id: session.id + ":finisher", kind: "sets", restSeconds: 45 };
    setsSession(sheet, {
      state, program, session: fin, me, today, finisherOf: "Rope", historyId: session.id,
      onFinished: async (exercises) => {
        await finishWorkout({
          programId: program.id, sessionId: session.id, day: today,
          exercises, rounds: completed, work, rest: restLen,
        });
        // The rope's own draft; the finisher's is cleared by the sets screen that owns it.
        clearDraft(session.id);
      },
    });
  }

  async function finishNow() {
    if (busy) return;
    if (completed < target) {
      const ok = await confirmSheet(document.body, {
        title: "Finish with " + completed + " of " + target + " rounds?",
        body: "It still counts as a workout. You can skip the core finisher too.",
        confirmLabel: "Finish", cancelLabel: "Keep going",
      });
      if (!ok) return;
    }
    busy = true; paint();
    try {
      await finishWorkout({
        programId: program.id, sessionId: session.id, day: today,
        exercises: [], rounds: completed, work, rest: restLen,
      });
      clearDraft(session.id); stop(); sheet.close();
    } catch (err) {
      busy = false; paint();
      const { showProblem } = await import("./problem.js");
      showProblem("Couldn't save the workout: " + (err && err.message ? err.message : err));
    }
  }

  function lengthChip(label, get, set, range) {
    return el("div.wo-len",
      el("span.wo-len-label", label),
      el("div.wo-len-ctl",
        el("button.step.small", { onclick: () => { set(Math.max(5, get() - 5)); persist(); paint(); }, disabled: phase !== "idle" }, "−"),
        el("b", get() + "s"),
        el("button.step.small", { onclick: () => { set(get() + 5); persist(); paint(); }, disabled: phase !== "idle" }, "+"),
      ),
      el("span.wo-len-range", range[0] === range[1] ? "" : range[0] + "–" + range[1] + "s this week"),
    );
  }

  function paint() {
    const left = phase === "work" || phase === "rest" ? (until - Date.now()) / 1000 : (phase === "idle" ? work : 0);
    sheet.paint(
      el("div.form.wo",
        el("div.sheet-head",
          el("span.sheet-title", "Rope"),
          el("span.wo-progress", "Week " + rx.week),
        ),
        el("p.wo-stage", rx.name),
        el("p.sheet-now", rx.note),

        el("div.wo-clock-wrap" + (phase === "work" ? ".is-work" : phase === "rest" ? ".is-rest" : phase === "done" ? ".is-done" : ""),
          el("span.wo-clock-phase",
            phase === "work" ? "WORK" : phase === "rest" ? "REST" : phase === "done" ? "DONE" : "READY"),
          el("b.wo-clock", phase === "done" ? "✓" : clock(left)),
          // Resting: what is banked. Working: which one this is. "Round 2 of 8" over a rest clock
          // read as being in round 2, when round 1 had just finished.
          el("span.wo-clock-round",
            phase === "done" ? completed + " rounds"
              : phase === "rest" ? completed + " of " + target + " done · next is round " + (completed + 1)
              : "Round " + Math.min(target, completed + 1) + " of " + target),
        ),

        phase === "idle"
          ? el("div.wo-lens",
              lengthChip("Work", () => work, (v) => { work = v; }, rx.work),
              lengthChip("Rest", () => restLen, (v) => { restLen = v; }, rx.rest),
            )
          : null,

        session.basics ? el("p.wo-cue", "💡 " + session.basics.cue) : null,
        session.basics ? el("p.wo-watch", "Watch for: " + session.basics.watch) : null,

        el("div.sheet-actions",
          phase === "idle" && completed < target
            ? el("button.tap", { onclick: start }, completed ? "Resume" : "Start")
            : phase === "work" || phase === "rest"
              ? el("button.tap", { onclick: pause }, "Pause")
              : el("button.tap", { onclick: finisher }, "Core finisher →"),
        ),
        el("div.sheet-actions",
          el("button.ghost", { onclick: () => { stop(); sheet.close(); } }, "Later"),
          el("button.ghost", { onclick: finishNow, disabled: busy }, busy ? "Saving…" : "Finish without finisher"),
        ),
      ),
    );
  }

  paint();
}
