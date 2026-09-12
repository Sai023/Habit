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
  sessionsOf, restDaysOf, personalBests, beatsBest, workoutInsights, MIN_INSIGHT_SESSIONS,
} from "../workout.js";
import * as fmt from "./format.js";
import { loadDraft, saveDraft, clearDraft, draftProgress } from "./workoutdraft.js";

/** " reps", "s", " taps" — the unit as it follows a number. */
function unitSuffix(ex) {
  const u = unitOf(ex);
  return u === "s" ? "s" : " " + u;
}

/** "0:47" */
function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/** A short buzz where the phone allows one. Silent failure everywhere else. */
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* not a phone */ }
}

/**
 * The program, and every session in it. Today's is suggested; any can be started.
 *
 * ---- Why a hub and not "today's session" ----
 *
 * The first cut opened straight into whatever the schedule said today was, and on a rest day it
 * opened into a screen that said so. Which is fine until Monday's session happens on Tuesday —
 * which it will, because life — and the app has no way to take it. The schedule is the
 * document's suggestion; the job is to keep the record. So this lists every session, says which
 * one today suggests, and starts whichever is tapped. What gets logged is that session on the
 * day it was actually done.
 */
export function openWorkoutSheet(host, { state, program, me, today, onDone, onChooseProgram }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });
  hub(sheet, { state, program, me, today, onChooseProgram });
}

/**
 * What the record says about you, in a handful of tiles.
 *
 * Nothing here unless there is something to say: a person one session in gets the session count
 * and nothing that pretends to be a pattern. Favourite and least favourite are said for what they
 * are — finished in full, and cut short — because the app cannot read minds and should not act
 * as though it can. See workoutInsights for the definitions.
 */
function trainingBlock(ins) {
  if (!ins || !ins.sessions) return null;
  const tiles = [];
  const tile = (n, label, cls = "") => el("div.wo-stat" + cls, el("b", String(n)), el("span", label));

  tiles.push(tile(ins.sessions, ins.sessions === 1 ? "session" : "sessions"));
  if (ins.streakWeeks >= 2) tiles.push(tile(ins.streakWeeks, "weeks in a row", ".is-hot"));
  else if (ins.recent) tiles.push(tile(ins.recent, "in 30 days"));
  if (ins.sets) tiles.push(tile(ins.sets, "sets banked"));
  if (ins.volume.reps) tiles.push(tile(ins.volume.reps.toLocaleString(), "reps lifted"));
  if (ins.volume.seconds >= 60) tiles.push(tile(Math.round(ins.volume.seconds / 60), "minutes held"));
  if (ins.rope && ins.rope.rounds) tiles.push(tile(ins.rope.rounds, "rope rounds"));

  const lines = [];
  if (ins.favourite) {
    lines.push(el("p.wo-fact",
      el("span.wo-fact-k", "💚 Favourite"),
      el("span", ins.favourite.name + " \u2014 never cut short"),
    ));
  }
  if (ins.leastFavourite) {
    lines.push(el("p.wo-fact",
      el("span.wo-fact-k", "😒 Least favourite"),
      el("span", ins.leastFavourite.name + " \u2014 finished " + Math.round(ins.leastFavourite.rate * 100) + "% of its sets"),
    ));
  }
  if (ins.mostImproved) {
    lines.push(el("p.wo-fact",
      el("span.wo-fact-k", "📈 Most improved"),
      el("span", ins.mostImproved.name + " \u2014 " + ins.mostImproved.from + " \u2192 " + ins.mostImproved.to
        + " (+" + Math.round(ins.mostImproved.gain * 100) + "%)"),
    ));
  }
  if (ins.busiestDay) {
    lines.push(el("p.wo-fact",
      el("span.wo-fact-k", "📅 Your day"),
      el("span", ins.busiestDay.day + " \u2014 " + ins.busiestDay.count + " sessions there, whatever the plan says"),
    ));
  }
  if (ins.rope && ins.rope.longestWork) {
    lines.push(el("p.wo-fact",
      el("span.wo-fact-k", "🔥 Longest interval"),
      el("span", ins.rope.longestWork + "s of work, week " + ins.rope.week + " of the progression"),
    ));
  }

  // The records, compactly. Best single set per exercise, newest first.
  const records = [...ins.pbs.values()]
    .sort((a, b) => (a.set.day < b.set.day ? 1 : -1))
    .slice(0, 6);

  return el("div.wo-training",
    el("h2.sec-title", "Your training"),
    el("div.wo-stats", tiles),
    lines.length ? el("div.wo-facts", lines) : null,
    records.length
      ? el("details.wo-records",
          el("summary", "Personal bests \u00b7 " + ins.pbs.size),
          el("div.wo-record-list", records.map((r) => el("div.wo-record",
            el("span.wo-record-name", r.name),
            el("b.wo-record-n", r.set.value + (r.unit === "s" ? "s" : r.unit === "rounds" ? " rounds" : "")),
            el("span.wo-record-when", fmt.dayLabel(r.set.day).split(",")[0]),
          ))),
        )
      : null,
    ins.sessions < MIN_INSIGHT_SESSIONS
      ? el("p.note-inline", "Favourites and patterns appear after " + MIN_INSIGHT_SESSIONS + " sessions.")
      : null,
  );
}

function hub(sheet, ctx) {
  const { state, program, me, today, onChooseProgram } = ctx;
  const plan = planFor(program, today);
  const suggested = plan && plan.session ? plan.session.id : null;
  const sessions = sessionsOf(program);
  const rests = restDaysOf(program);

  function start(session) {
    const args = { ...ctx, session, back: () => hub(sheet, ctx) };
    if (session.kind === "intervals") ropeSession(sheet, args);
    else setsSession(sheet, args);
  }

  /** One line about the last time this session was done, or that it has not been. */
  function lastLine(session) {
    const last = lastSession(state, me, session.id, null);
    if (!last) return "not done yet";
    const sets = (last.exercises || []).reduce((n, e) => n + e.sets.filter(Number.isFinite).length, 0);
    const what = Number.isFinite(last.rounds) ? last.rounds + " rounds" : sets + " sets";
    return "last " + fmt.dayLabel(last.day) + " \u00b7 " + what;
  }

  /** The rope session's line names the week's stage rather than its sets. */
  function ropeLine(session) {
    const rx = intervalsFor(program, session, today);
    return rx ? "Week " + rx.week + " \u00b7 " + rx.name : "";
  }

  const subFor = (session) => {
    // Half done beats everything else the line could say: it is the one fact that changes what
    // the next tap does.
    const at = draftProgress(program, session, today);
    if (at) return "In progress \u00b7 " + (at.of ? at.done + " of " + at.of + " sets" : at.done + " rounds");
    return session.kind === "intervals"
      ? ropeLine(session)
      : session.exercises.length + " exercises \u00b7 " + lastLine(session);
  };

  sheet.paint(
    el("div.form.wo",
      el("div.sheet-head", el("span.sheet-title", program.name)),
      el("p.sheet-now", program.tagline),

      // The document's own warnings, collapsed but present. Somebody who has never trained is
      // one screen from a set of push-ups, and "stop at sharp joint pain" belongs on the way in.
      program.before
        ? el("details.wo-before",
            el("summary", program.before.title),
            el("ul.wo-before-list", program.before.points.map((pt) => el("li", pt))),
          )
        : null,

      el("h2.sec-title", "Today \u00b7 " + fmt.dayLabel(today).split(",")[0]),
      plan && plan.session
        ? el("button.tap.wo-start", { onclick: () => start(plan.session) },
            el("span.wo-start-name", "Start " + plan.session.name + " \u2192"),
            el("span.wo-start-sub", subFor(plan.session)),
          )
        : el("div.wo-rest-today",
            el("b", (plan && plan.rest) || "Rest"),
            plan && plan.note ? el("span", plan.note) : null,
            el("span", "Or pick any session below. It is logged on the day you do it."),
          ),

      trainingBlock(workoutInsights(state, me, program, today)),

      el("h2.sec-title", "All sessions"),
      el("div.wo-sessions", sessions.map(({ session, days }) => el("button.wo-session"
        + (session.id === suggested ? ".is-today" : "")
        + (draftProgress(program, session, today) ? ".is-open" : ""), { onclick: () => start(session) },
        el("span.wo-session-main",
          el("span.wo-session-name", session.name),
          el("span.wo-session-sub", subFor(session)),
        ),
        el("span.wo-session-days", days.join(" \u00b7 ")),
        el("span.wo-session-go", "\u2192"),
      ))),

      rests.length
        ? el("div.wo-rests",
            el("p.wo-rests-line", rests.map((r) => r.day + " " + r.label).join(" \u00b7 ")),
            program.restNote
              ? el("details.wo-restnote", el("summary", "Why rest days matter"), el("p", program.restNote))
              : null,
          )
        : null,

      el("div.sheet-actions",
        el("button.ghost", { onclick: () => sheet.close() }, "Close"),
        onChooseProgram
          ? el("button.ghost", { onclick: () => { sheet.close(); onChooseProgram(); } }, "Change program")
          : null,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Sets and circuits
// ---------------------------------------------------------------------------

function setsSession(sheet, { state, program, session, me, today, finisherOf = null, onFinished = null, historyId = null, back = null }) {
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
  // Records as they stood when the session opened. Compared against, never updated mid-session,
  // so the second set that beats the old record is celebrated as beating it too — which is what
  // it did. The map is rebuilt from the log on the next open.
  const pbs = personalBests(state, me, program);
  // What just happened, for the one tile that should move. paint() rebuilds the DOM, so without
  // this every banked tile would replay its animation on every repaint.
  let just = null;       // { ex, set, pb: bool }

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
    just = null;
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
    const pb = beatsBest(pbs, ex.id, value);
    just = { ex: active.ex, set: active.set, pb };
    // A record gets a longer, different buzz than a set. It is the one moment in a workout worth
    // a phone's attention, and it should feel unlike the other fourteen.
    buzz(pb ? [40, 30, 40, 30, 120] : 20);
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
    // The clock and its bar are updated IN PLACE, four times a second. Rebuilding the sheet on
    // every tick was the cause of a bug worth writing down: paint() recreates every element, and
    // a recreated element restarts its CSS animation — so the "new personal best" banner and the
    // set-tile pop, both meant to play once, replayed every 250ms for the length of the rest and
    // strobed. Only the end of the rest is a structural change; only that calls paint().
    restTimer = setInterval(() => {
      if (!rest) return;
      if (Date.now() >= rest.until) { buzz([60, 40, 60]); stopRest(); paint(); return; }
      tickRest();
    }, 250);
  }

  /** The two things that move during a rest, moved without touching anything else. */
  function tickRest() {
    if (!rest) return;
    const left = (rest.until - Date.now()) / 1000;
    const clockEl = document.querySelector(".wo-rest-clock");
    const barEl = document.querySelector(".wo-rest-bar > i");
    if (clockEl) clockEl.textContent = clock(left);
    if (barEl) barEl.style.width = Math.max(0, Math.min(100, (left / rest.total) * 100)) + "%";
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
    const isJust = just && just.ex === exIndex && just.set === setIndex;
    const pbTile = done && beatsBest(pbs, ex.id, banked[setIndex]);
    return el("button.wo-set" + (done ? ".is-done" : "") + (isActive ? ".is-active" : "")
      + (isJust ? ".is-just" : "") + (pbTile ? ".is-pb" : ""), {
      onclick: () => focus(exIndex, setIndex),
      "aria-label": "Set " + (setIndex + 1) + (done ? ", done, " + shown : "") + (pbTile ? ", a personal best" : ""),
    },
      el("span.wo-set-n", String(shown)),
      el("span.wo-set-i", pbTile ? "PB" : done ? "✓" : String(setIndex + 1)),
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
    // How to do it: open on the FIRST set of each exercise, folded on the rest. Read it once per
    // session, then it is out of the way of the number — and a person who has never done a hollow
    // body hold is told what one is before being asked how long they held it.
    const firstSet = isActiveEx && active.set === 0;
    return el("section.wo-ex" + (isActiveEx ? ".is-active" : ""),
      el("div.wo-ex-head",
        el("span.wo-ex-name", ex.name),
        el("span.wo-ex-rx", prescription(ex)),
      ),
      isActiveEx && ex.steps && ex.steps.length
        ? el("details.wo-howto", firstSet ? { open: true } : {},
            el("summary", "How to do it"),
            el("ol", ex.steps.map((step) => el("li", step))),
          )
        : null,
      el("div.wo-sets", Array.from({ length: ex.sets }, (_, s) => setTile(ex, i, s))),
      isActiveEx ? activeControl(ex) : null,
      // The cue while it is the thing you are doing; the watch-for underneath. It is a safety line
      // as often as a form line, so it is always shown on the active exercise.
      isActiveEx && ex.cue ? el("p.wo-cue", "💡 " + ex.cue) : null,
      isActiveEx && ex.watch ? el("p.wo-watch", "⚠ " + ex.watch) : null,
      // Last time and the record, on one line, so the two numbers that decide what to aim for
      // are beside the tiles that take the aim. The record is the best single set ever, with its
      // date — a number to beat is only motivating if you believe it is real.
      (lastTime && lastTime.sets.length) || pbs.get(ex.id)
        ? el("p.wo-last",
            lastTime && lastTime.sets.length
              ? el("span", "Last " + lastTime.sets.filter(Number.isFinite).join(" \u00b7 "))
              : el("span", "First time"),
            pbs.get(ex.id)
              ? el("span.wo-pb", " \u00b7 PB " + pbs.get(ex.id).set.value + unitSuffix(ex)
                  + " (" + fmt.dayLabel(pbs.get(ex.id).set.day).split(",")[0] + ")")
              : null,
          )
        : null,
      // The moment. Drawn once, on the card, for the set that just beat the record.
      just && just.pb && just.ex === i
        ? el("p.wo-newpb", "🏆 New personal best \u2014 " + (draft[ex.id] || [])[just.set] + unitSuffix(ex))
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
        // Warm-up, before the first set and only then. Once something is banked they have started.
        program.warmup && done.done === 0 && !finisherOf
          ? el("p.wo-warmup", "🔥 " + program.warmup)
          : null,
        previous ? el("p.note-inline", "Prefilled from " + fmt.dayLabel(previous.day) + ". Tap + when you beat it.") : null,

        rest
          ? el("div.wo-rest",
              el("div.wo-rest-row",
                el("span.wo-rest-label", "Rest"),
                el("b.wo-rest-clock", clock((rest.until - Date.now()) / 1000)),
                el("button.link", { onclick: () => { stopRest(); paint(); } }, "Skip"),
              ),
              // Drains left to right as the rest runs out. Motion is information here: a glance
              // at the bar says "nearly" without reading a number.
              el("div.wo-rest-bar", el("i", {
                style: "width:" + Math.max(0, Math.min(100, ((rest.until - Date.now()) / 1000 / rest.total) * 100)) + "%",
              })),
            )
          : null,

        exercises.map(exerciseCard),

        el("div.sheet-actions",
          el("button.ghost", { onclick: () => { stopRest(); if (back) back(); else sheet.close(); } },
            back ? "\u2190 Back" : "Later"),
          el("button.tap" + (isComplete(session, draft) ? ".is-ready" : ""), { onclick: finish, disabled: busy },
            busy ? "Saving\u2026" : (finisherOf ? "Finish " + session.name.toLowerCase() : "Finish workout")),
        ),
        el("p.note-inline", "Going back keeps what you've banked. Finish writes it down and counts the workout."),
      ),
    );
  }

  paint();
}

// ---------------------------------------------------------------------------
// Rope: intervals, then the finisher
// ---------------------------------------------------------------------------

function ropeSession(sheet, { state, program, session, me, today, back = null }) {
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
    if (Date.now() < until) {
      // Same rule as the rest clock: the number moves, the sheet does not. A phase change is the
      // structural event and is the only thing below that repaints.
      const clockEl = document.querySelector(".wo-clock");
      if (clockEl) clockEl.textContent = clock((until - Date.now()) / 1000);
      return;
    }
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

        // The basics, open until the first round is banked. After that they are one tap away.
        session.basics && session.basics.steps
          ? el("details.wo-howto", completed === 0 && phase === "idle" ? { open: true } : {},
              el("summary", "Jump rope \u2014 the basics"),
              el("ol", session.basics.steps.map((step) => el("li", step))),
            )
          : null,
        session.basics ? el("p.wo-cue", "💡 " + session.basics.cue) : null,
        session.basics ? el("p.wo-watch", "⚠ " + session.basics.watch) : null,
        program.warmup && completed === 0 && phase === "idle" ? el("p.wo-warmup", "🔥 " + program.warmup) : null,

        el("div.sheet-actions",
          phase === "idle" && completed < target
            ? el("button.tap", { onclick: start }, completed ? "Resume" : "Start")
            : phase === "work" || phase === "rest"
              ? el("button.tap", { onclick: pause }, "Pause")
              : el("button.tap", { onclick: finisher }, "Core finisher →"),
        ),
        el("div.sheet-actions",
          el("button.ghost", { onclick: () => { stop(); if (back) back(); else sheet.close(); } },
            back ? "\u2190 Back" : "Later"),
          el("button.ghost", { onclick: finishNow, disabled: busy }, busy ? "Saving…" : "Finish without finisher"),
        ),
      ),
    );
  }

  paint();
}
