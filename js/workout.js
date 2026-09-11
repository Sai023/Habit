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

/**
 * Every session the program has, in the order the week puts them, with which days suggest each.
 *
 * ---- Why every session, not today's ----
 *
 * The schedule is a suggestion. People shift days — a Monday session done on Tuesday is the same
 * session, and refusing it because the calendar says otherwise would lose the one thing this
 * feature exists to keep, which is the record of what was done. So the hub lists all of them,
 * marks the one the schedule suggests for today, and starts whichever is tapped. What is logged
 * is the session and the day it was actually done.
 *
 * The finisher and the rest days are not sessions; the first belongs to a rope day and the second
 * to nothing.
 */
export function sessionsOf(program) {
  if (!program) return [];
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const seen = new Map();
  for (let d = 1; d <= 7; d += 1) {
    const slot = program.schedule[d];
    if (typeof slot !== "string") continue;
    const session = program.sessions[slot];
    if (!session) continue;
    if (!seen.has(slot)) seen.set(slot, { session, days: [] });
    seen.get(slot).days.push(DAYS[d - 1]);
  }
  return [...seen.values()];
}

/** The rest days, as "Wed Rest · Thu Tennis" — the part of the week that is not a session. */
export function restDaysOf(program) {
  if (!program) return [];
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const out = [];
  for (let d = 1; d <= 7; d += 1) {
    const slot = program.schedule[d];
    if (slot == null) out.push({ day: DAYS[d - 1], label: "Rest" });
    else if (typeof slot === "object") out.push({ day: DAYS[d - 1], label: slot.rest, note: slot.note || null });
  }
  return out;
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

/**
 * Every exercise this member has ever logged under a program, with its sessions in date order.
 *
 * ---- The shape ----
 *
 *   [{ id, name, unit, perSide, sessions: [{ day, sets, total, best }], trend }]
 *
 * One entry per exercise the PROGRAM defines, in program order, whether or not it has been done
 * yet — a history screen that only lists what you have already done cannot show you what is
 * still to come. Rope days are one entry, "Rope", whose sessions carry rounds rather than sets.
 *
 * `trend` compares the most recent session's total with the one before it: "up", "down", "same",
 * or null with fewer than two. Total rather than best, because three sets of 10 beating three
 * sets of 9 is the progression the program asks for, and a best-set comparison would call a
 * session where you added a whole set a regression if the last one was short.
 */
export function exerciseHistory(state, memberId, program) {
  if (!program) return [];
  const all = ((state.workouts && state.workouts.get(memberId)) || [])
    .filter((w) => w.programId === program.id)
    .slice()
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  // Every exercise the program defines, once, in the order it first appears. The circuit reuses
  // Monday's movements; those are the same exercise and share a history.
  const order = [];
  const byId = new Map();
  for (const session of Object.values(program.sessions)) {
    if (session.kind === "intervals") {
      if (!byId.has(session.id)) {
        byId.set(session.id, { id: session.id, name: session.name, unit: "rounds", perSide: false, sessions: [] });
        order.push(session.id);
      }
      for (const ex of (session.finisher && session.finisher.exercises) || []) {
        if (!byId.has(ex.id)) {
          byId.set(ex.id, { id: ex.id, name: ex.name, unit: unitOf(ex), perSide: !!ex.perSide, sessions: [] });
          order.push(ex.id);
        }
      }
      continue;
    }
    for (const ex of session.exercises || []) {
      if (!byId.has(ex.id)) {
        byId.set(ex.id, { id: ex.id, name: ex.name, unit: unitOf(ex), perSide: !!ex.perSide, sessions: [] });
        order.push(ex.id);
      }
    }
  }

  for (const w of all) {
    if (Number.isFinite(w.rounds) && byId.has(w.sessionId)) {
      byId.get(w.sessionId).sessions.push({ day: w.day, sets: [w.rounds], total: w.rounds, best: w.rounds, work: w.work, rest: w.rest });
    }
    for (const e of w.exercises || []) {
      const entry = byId.get(e.id);
      if (!entry) continue;
      const sets = e.sets.filter((n) => Number.isFinite(n));
      if (!sets.length) continue;
      entry.sessions.push({ day: w.day, sets, total: sets.reduce((a, b) => a + b, 0), best: Math.max(...sets) });
    }
  }

  return order.map((id) => {
    const entry = byId.get(id);
    const n = entry.sessions.length;
    let trend = null;
    if (n >= 2) {
      const a = entry.sessions[n - 2].total, b = entry.sessions[n - 1].total;
      trend = b > a ? "up" : b < a ? "down" : "same";
    }
    return { ...entry, trend };
  });
}
