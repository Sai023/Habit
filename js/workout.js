// workout.js — the arithmetic of a workout, with no screen attached.
//
// Everything a session screen needs to decide before it draws anything: which session today is,
// which week of a progression somebody is in, what number to put in a set before they touch it,
// and what a finished session adds up to. Pure, so the decisions that would otherwise be made in
// a sheet full of buttons are made somewhere a test can reach them.
//
// ---- Why prefill is the important function ----
//
// The whole feature is "log reps as you go", and the difference between something you use
// mid-workout and something you fill in afterwards is how many taps a set costs. If the number is
// already right, a set is one tap. So every set opens on what you did LAST time in that set of
// that exercise, and the first time ever on the low end of the prescription. Progress is then a
// single "+" over last time, which is also exactly what the program asks for.

import { PROGRAMS } from "./programs.js";
import { isoDayOfWeek, daysBetween } from "./habits.js";

/** The program a member follows, or null. */
export function programFor(state, memberId) {
  const id = state.programs && state.programs.get(memberId);
  return id ? PROGRAMS[id] || null : null;
}

/**
 * What the program asks for on a day.
 *
 * Returns { session } for a training day, { rest: label, note } for a rest day, and null when the
 * program has nothing at all for that weekday, which should not happen with a full schedule but
 * is the honest answer if it does.
 */
export function planFor(program, day) {
  if (!program) return null;
  const slot = program.schedule[isoDayOfWeek(day)];
  if (slot == null) return { rest: "Rest" };
  if (typeof slot === "object") return { rest: slot.rest, note: slot.note || null };
  const session = program.sessions[slot];
  return session ? { session } : null;
}

/**
 * Which week of a progression a day falls in. 1 on the start day and the six days after it.
 *
 * Counted in whole weeks from the start date rather than from the week's Monday, because the
 * document counts it that way — "weeks 1–2" begin on the day he started, not on the Monday before.
 */
export function progressionWeek(program, day) {
  if (!program || !program.startDay) return 1;
  const elapsed = daysBetween(program.startDay, day);
  if (elapsed < 0) return 1;
  return Math.floor(elapsed / 7) + 1;
}

/** The rope prescription in force on a day, or null for a program with no intervals. */
export function intervalsFor(program, session, day) {
  if (!session || session.kind !== "intervals") return null;
  const week = progressionWeek(program, day);
  const stage = session.progression.find(
    (p) => week >= p.fromWeek && (p.toWeek == null || week <= p.toWeek),
  ) || session.progression[session.progression.length - 1];
  return { week, ...stage };
}

/**
 * The most recent finished session of this kind, for this member, before (not on) a day.
 *
 * Before, not on: opening today's session again must prefill from LAST time, not from the copy of
 * today that a Finish just wrote — or a second tap on Finish would see itself in the mirror.
 */
export function lastSession(state, memberId, sessionId, beforeDay) {
  const list = (state.workouts && state.workouts.get(memberId)) || [];
  let best = null;
  for (const w of list) {
    if (w.sessionId !== sessionId) continue;
    if (beforeDay && w.day >= beforeDay) continue;
    if (!best || w.day > best.day) best = w;
  }
  return best;
}

/**
 * The number a set opens on.
 *
 * Last time's number for that set, when there was a last time. Otherwise the low end of the
 * prescription — the document's own starting point. Never the high end: a first session that
 * opens on 15 push-ups is asking to be talked down, and a number that has to be lowered before
 * it can be logged is not a prefill, it is a form.
 */
export function prefill(exercise, previous, setIndex) {
  if (previous && previous.exercises) {
    const prior = previous.exercises.find((e) => e.id === exercise.id);
    if (prior && prior.sets && Number.isFinite(prior.sets[setIndex])) return prior.sets[setIndex];
    // A set they did not reach last time opens on the last set they did. Better than the floor,
    // which would read as a regression on the one set they are adding.
    if (prior && prior.sets && prior.sets.length) {
      const last = prior.sets[prior.sets.length - 1];
      if (Number.isFinite(last)) return last;
    }
  }
  const range = exercise.reps || exercise.seconds || [0, 0];
  return range[0];
}

/** Reps or seconds — the word for what a set of this exercise counts. */
export function unitOf(exercise) {
  if (exercise.unit) return exercise.unit;
  return exercise.seconds ? "s" : "reps";
}

/** "3 × 8–15", "3 × 30–45s", "3 × 10/side" — the prescription as the document writes it. */
export function prescription(exercise) {
  const range = exercise.reps || exercise.seconds || [0, 0];
  const span = range[0] === range[1] ? String(range[0]) : range[0] + "–" + range[1];
  const unit = exercise.seconds ? "s" : (exercise.unit ? " " + exercise.unit : "");
  const side = exercise.perSide ? "/side" : "";
  return exercise.sets + " × " + span + unit + side;
}

/**
 * What a logged session adds up to, for a history line: total reps (or seconds) per exercise,
 * and how many of the prescribed sets were actually done.
 */
export function summarise(session, logged) {
  const out = [];
  for (const exercise of session.exercises || []) {
    const entry = (logged.exercises || []).find((e) => e.id === exercise.id);
    const sets = entry ? entry.sets.filter((n) => Number.isFinite(n)) : [];
    out.push({
      id: exercise.id,
      name: exercise.name,
      done: sets.length,
      of: exercise.sets,
      total: sets.reduce((a, b) => a + b, 0),
      best: sets.length ? Math.max(...sets) : null,
      sets,
    });
  }
  return out;
}

/** Every set banked, across the session? Used to decide whether Finish needs a confirmation. */
export function isComplete(session, draft) {
  return (session.exercises || []).every((ex) => {
    const sets = (draft[ex.id] || []);
    return sets.length >= ex.sets && sets.slice(0, ex.sets).every((n) => Number.isFinite(n));
  });
}

/** How many sets have been banked, out of how many there are. */
export function progress(session, draft) {
  let done = 0, of = 0;
  for (const ex of session.exercises || []) {
    of += ex.sets;
    done += (draft[ex.id] || []).filter((n) => Number.isFinite(n)).length;
  }
  return { done, of };
}
