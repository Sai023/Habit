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
import { isoDayOfWeek, daysBetween, addDays, isoWeekKey } from "./habits.js";

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
    // A class is its own row: one number, the minutes, and how it felt beside it.
    if (session.kind === "video") {
      if (!byId.has(session.id)) {
        byId.set(session.id, { id: session.id, name: session.name, unit: "min", perSide: false, sessions: [] });
        order.push(session.id);
      }
      continue;
    }
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
    if (Number.isFinite(w.minutes) && byId.has(w.sessionId) && byId.get(w.sessionId).unit === "min") {
      byId.get(w.sessionId).sessions.push({ day: w.day, sets: [w.minutes], total: w.minutes, best: w.minutes, effort: w.effort || null });
      continue;
    }
    if (Number.isFinite(w.rounds) && byId.has(w.sessionId)) {
      byId.get(w.sessionId).sessions.push({ day: w.day, sets: [w.rounds], total: w.rounds, best: w.rounds, work: w.work, rest: w.rest });
    }
    for (const e of w.exercises || []) {
      const entry = byId.get(e.id);
      if (!entry) continue;
      // A set banked at zero was skipped — Done pressed on an empty stepper to move on — and a
      // session with nothing but those never happened for this exercise. Neither is a data
      // point: a "0 · 0 · 0" from a quick test of the app must not read as a collapse in form.
      const sets = e.sets.filter((n) => Number.isFinite(n) && n > 0);
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

// ---------------------------------------------------------------------------
// Personal bests, and what the record says about you
// ---------------------------------------------------------------------------

/**
 * The best single set and the best session total, per exercise, with the day each was set.
 *
 * Two bests, not one, because they answer different questions. The best SET is the number to beat
 * on the next rep — it is what the session screen shows beside the stepper. The best TOTAL is the
 * best session, which is what "am I getting stronger" actually means for three sets of push-ups;
 * a single lucky set of 15 followed by two of 6 is not a better day than 12, 12, 12.
 *
 * Only exercises with at least one logged set appear. Keyed by exercise id.
 */
export function personalBests(state, memberId, program) {
  const out = new Map();
  for (const row of exerciseHistory(state, memberId, program)) {
    // A class has no record to beat: twenty-five minutes is the length of the video.
    if (row.unit === "min") continue;
    let bestSet = null, bestTotal = null;
    for (const ses of row.sessions) {
      if (row.unit === "rounds") {
        if (!bestTotal || ses.total > bestTotal.value) bestTotal = { value: ses.total, day: ses.day };
        if (!bestSet || ses.total > bestSet.value) bestSet = { value: ses.total, day: ses.day };
        continue;
      }
      if (!bestSet || ses.best > bestSet.value) bestSet = { value: ses.best, day: ses.day };
      if (!bestTotal || ses.total > bestTotal.value) bestTotal = { value: ses.total, day: ses.day };
    }
    if (bestSet) out.set(row.id, { id: row.id, name: row.name, unit: row.unit, set: bestSet, total: bestTotal });
  }
  return out;
}

/**
 * Would banking `value` on this exercise be a new best set?
 *
 * Strictly greater: matching a best is not a new one. `pbs` is the map from personalBests, taken
 * BEFORE the session started, so a set banked earlier in this session that already beat the record
 * still reads as the record being beaten again — which is right, and is what makes the second
 * "new PB" of a good day feel like the second rather than a repeat.
 */
export function beatsBest(pbs, exerciseId, value) {
  const pb = pbs && pbs.get(exerciseId);
  if (!pb || !pb.set) return false;
  return Number.isFinite(value) && value > pb.set.value;
}

/** How many sets have to be behind a claim before it is worth making. */
export const MIN_INSIGHT_SESSIONS = 3;

/**
 * What the record says, in a handful of facts a person would actually want to be told.
 *
 * ---- What "favourite" means here, and why it is said ----
 *
 * The app cannot know what anybody enjoys. What it can see is which exercise gets finished in full
 * every time and which gets cut short — and those are what favourite and least favourite are
 * measured as: the completion rate of prescribed sets across every session the exercise appeared
 * in. The screen says "never cut short" and "cut short most" rather than pretending to read minds,
 * and only once there are enough sessions for a rate to mean anything.
 *
 * ---- Everything else ----
 *
 *   sessions        how many finished, and how many in the last 30 days
 *   sets            lifetime sets banked
 *   volume          lifetime reps and lifetime seconds held, separately, because adding them
 *                   would be adding apples to a clock
 *   mostImproved    the exercise whose latest total is furthest above its first, as a percentage,
 *                   with both numbers so the claim can be checked
 *   busiestDay      the weekday you actually train on most — which the schedule does not decide
 *   streakWeeks     consecutive weeks, counting back from the current one, with at least one
 *                   finished session in each. The current week counts if it has one.
 *   rope            for a rope program: total rounds, the longest work interval reached, and the
 *                   week of the progression today falls in
 *   pbs             the personalBests map, so a screen can list records without a second pass
 */
export function workoutInsights(state, memberId, program, today) {
  const empty = { sessions: 0, recent: 0, sets: 0, volume: { reps: 0, seconds: 0 },
    favourite: null, leastFavourite: null, mostImproved: null, busiestDay: null,
    streakWeeks: 0, rope: null, classes: null, pbs: new Map(), days: [] };
  if (!program) return empty;

  const all = ((state.workouts && state.workouts.get(memberId)) || [])
    .filter((w) => w.programId === program.id)
    .slice()
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (!all.length) return empty;

  // Prescribed sets per exercise per session, so completion can be measured against it.
  const prescribed = new Map();
  for (const session of Object.values(program.sessions)) {
    for (const ex of session.exercises || []) prescribed.set(session.id + "|" + ex.id, ex.sets);
    for (const ex of (session.finisher && session.finisher.exercises) || []) {
      prescribed.set(session.id + "|" + ex.id, ex.sets);
    }
  }
  const secondsExercises = new Set();
  for (const session of Object.values(program.sessions)) {
    for (const ex of [...(session.exercises || []), ...((session.finisher && session.finisher.exercises) || [])]) {
      if (ex.seconds) secondsExercises.add(ex.id);
    }
  }

  let sets = 0, reps = 0, seconds = 0;
  const completion = new Map();   // exerciseId -> { name, done, of, appearances }
  const names = new Map();
  for (const row of exerciseHistory(state, memberId, program)) names.set(row.id, row.name);
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const weeks = new Set();
  let rounds = 0, longestWork = 0;

  for (const w of all) {
    weekdays[isoDayOfWeek(w.day) - 1] += 1;
    weeks.add(isoWeekKey(w.day));
    if (Number.isFinite(w.rounds)) {
      rounds += w.rounds;
      if (Number.isFinite(w.work)) longestWork = Math.max(longestWork, w.work);
    }
    for (const e of w.exercises || []) {
      const done = e.sets.filter(Number.isFinite);
      const of = prescribed.get(w.sessionId + "|" + e.id) || done.length;
      sets += done.length;
      const sum = done.reduce((a, b) => a + b, 0);
      if (secondsExercises.has(e.id)) seconds += sum; else reps += sum;
      const c = completion.get(e.id) || { id: e.id, name: names.get(e.id) || e.id, done: 0, of: 0, appearances: 0 };
      c.done += done.length; c.of += of; c.appearances += 1;
      completion.set(e.id, c);
    }
  }

  // Favourite and least favourite: completion rate, only where there is enough to go on. Ties on
  // rate break on appearances — the one you have shown up for more is the stronger claim.
  const rated = [...completion.values()]
    .filter((c) => c.appearances >= MIN_INSIGHT_SESSIONS && c.of > 0)
    .map((c) => ({ ...c, rate: c.done / c.of }));
  let favourite = null, leastFavourite = null;
  if (rated.length >= 2) {
    const sorted = rated.slice().sort((a, b) => b.rate - a.rate || b.appearances - a.appearances);
    favourite = sorted[0];
    leastFavourite = sorted[sorted.length - 1];
    // If everything is always finished in full there is no least favourite worth naming.
    if (leastFavourite.rate >= 0.999) leastFavourite = null;
  }

  // Most improved: latest total over first total, per exercise, needing two sessions at least.
  let mostImproved = null;
  for (const row of exerciseHistory(state, memberId, program)) {
    if (row.sessions.length < 2 || row.unit === "rounds") continue;
    const first = row.sessions[0].total, last = row.sessions[row.sessions.length - 1].total;
    if (first <= 0) continue;
    const gain = (last - first) / first;
    if (gain > 0 && (!mostImproved || gain > mostImproved.gain)) {
      mostImproved = { id: row.id, name: row.name, unit: row.unit, from: first, to: last, gain };
    }
  }

  // Busiest weekday, only if it is actually busier than the rest.
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let busiestDay = null;
  const top = Math.max(...weekdays);
  if (top >= 2 && weekdays.filter((n) => n === top).length === 1) {
    busiestDay = { day: DAYS[weekdays.indexOf(top)], count: top };
  }

  // Weeks in a row with a session, counting back from this week.
  let streakWeeks = 0;
  let cursor = today;
  for (let i = 0; i < 260; i += 1) {
    if (!weeks.has(isoWeekKey(cursor))) {
      // The current week has not had one YET; that does not break a streak that ran up to last
      // week. Only a gap before that does.
      if (i === 0) { cursor = addDays(cursor, -7); continue; }
      break;
    }
    streakWeeks += 1;
    cursor = addDays(cursor, -7);
  }

  const since = addDays(today, -30);
  const recent = all.filter((w) => w.day > since).length;

  const rope = program.sessions && Object.values(program.sessions).some((x) => x.kind === "intervals")
    ? { rounds, longestWork, week: progressionWeek(program, today) }
    : null;

  // Classes: minutes moved, the one done most, and how they have been feeling lately.
  let classes = null;
  if (program.sessions && Object.values(program.sessions).some((x) => x.kind === "video")) {
    const done = all.filter((w) => Number.isFinite(w.minutes));
    const minutes = done.reduce((n, w) => n + w.minutes, 0);
    const counts = new Map();
    for (const w of done) counts.set(w.sessionId, (counts.get(w.sessionId) || 0) + 1);
    let top = null;
    for (const [id, count] of counts) if (!top || count > top.count) top = { id, count };
    const session = top && program.sessions[top.id];
    const felt = done.slice(-4).map((w) => w.effort).filter(Boolean);
    const hard = felt.filter((f) => f === "hard").length;
    const easy = felt.filter((f) => f === "easy").length;
    classes = {
      minutes,
      favourite: session ? { id: session.id, name: session.name, count: top.count } : null,
      // Four hard in a row is a sign to ease off; four easy, to move up. Neither is advice the
      // app gives — the sentence says what was said and stops.
      feeling: felt.length >= 3 ? (hard >= 3 ? "hard" : easy >= 3 ? "easy" : "right") : null,
    };
  }

  return {
    sessions: all.length,
    recent,
    sets,
    volume: { reps, seconds },
    favourite, leastFavourite, mostImproved, busiestDay,
    streakWeeks,
    rope,
    classes,
    pbs: personalBests(state, memberId, program),
    days: all.map((w) => w.day),
  };
}

// ---------------------------------------------------------------------------
// The log: every workout, one by one
// ---------------------------------------------------------------------------

/**
 * Every exercise a program can produce, by id, with its name and unit — the finisher's included,
 * and the rope and each class as a row of their own. The log needs names for ids the program
 * still defines; an id the program has since dropped is shown by its id, never hidden.
 */
function exerciseIndex(program) {
  const byId = new Map();
  if (!program) return byId;
  for (const session of Object.values(program.sessions)) {
    if (session.kind === "video") { byId.set(session.id, { name: session.name, unit: "min", perSide: false }); continue; }
    if (session.kind === "intervals") byId.set(session.id, { name: session.name, unit: "rounds", perSide: false });
    for (const ex of [...(session.exercises || []), ...((session.finisher && session.finisher.exercises) || [])]) {
      if (!byId.has(ex.id)) byId.set(ex.id, { name: ex.name, unit: unitOf(ex), perSide: !!ex.perSide });
    }
  }
  return byId;
}

/**
 * How long each exercise's WORK took, from the clock the sets carry.
 *
 * A guided session stamps both ends of a set — when the rest clock ran out or Start was tapped,
 * and when Done was — so a set's span is its work and nothing else. A set from before that kept
 * only its end, and owns the time since the set before it, rest included; the first such set
 * owns the time since the session began. A workout from a build that kept no clock has no
 * spans, and the history says so rather than guessing.
 *
 * Returns [{ id, ms, spans: [[from, to], ...] }] in the order the exercises were first done. A
 * rope day's rounds are the rope's own spans under `id: sessionId` — each round's work, exactly,
 * because the app's own clock ran it — and a class is one span, the whole window.
 */
export function spansOf(workout) {
  if (!workout || !Number.isFinite(workout.startedAt)) return [];
  const sets = [];
  for (const ex of workout.exercises || []) {
    (ex.at || []).forEach((t, i) => {
      if (!Number.isFinite(t) || !Number.isFinite(ex.sets[i])) return;
      const from = (ex.from || [])[i];
      sets.push({ id: ex.id, at: t, from: Number.isFinite(from) && from < t ? from : null });
    });
  }
  sets.sort((a, b) => a.at - b.at);

  const out = new Map();
  const add = (id, from, to) => {
    if (!(to > from)) return;
    const e = out.get(id) || { id, ms: 0, spans: [] };
    e.ms += to - from;
    e.spans.push([from, to]);
    out.set(id, e);
  };

  let cursor = workout.startedAt;
  const rounds = Number.isFinite(workout.rounds) && workout.rounds > 0 ? workout.rounds : 0;
  if (rounds) {
    const ends = (workout.roundsAt || []).filter(Number.isFinite);
    if (ends.length && Number.isFinite(workout.work) && workout.work > 0) {
      for (const end of ends) add(workout.sessionId, end - workout.work * 1000, end);
      cursor = ends[ends.length - 1];
    } else {
      // No round clock kept: the rope ran from the start until the finisher began.
      const ropeEnd = sets.length ? sets[0].at : (workout.endedAt || cursor);
      add(workout.sessionId, cursor, ropeEnd);
      cursor = ropeEnd;
    }
  }
  for (const s of sets) { add(s.id, s.from !== null && s.from >= cursor ? s.from : cursor, s.at); cursor = s.at; }
  if (!sets.length && !rounds && Number.isFinite(workout.endedAt)) {
    add(workout.sessionId, cursor, workout.endedAt);
  }
  return [...out.values()];
}

/**
 * Every workout this member has done, newest first, each one readable on its own.
 *
 * Per session: what it was, when, how long it ran, every exercise with its sets beside last
 * time's and the record marked, and the vitals the phone laid over it if a watch was worn (see
 * T.WORKOUT_VITALS). Across programs, because a person who switched keeps their history.
 */
export function workoutLog(state, memberId, today = null) {
  const all = ((state.workouts && state.workouts.get(memberId)) || []).slice()
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : (b.ts || 0) - (a.ts || 0)));
  const indexes = new Map();

  return all.map((w) => {
    const program = PROGRAMS[w.programId] || null;
    if (program && !indexes.has(program.id)) indexes.set(program.id, exerciseIndex(program));
    const names = program ? indexes.get(program.id) : new Map();
    const session = program && program.sessions[w.sessionId] ? program.sessions[w.sessionId] : null;
    const previous = lastSession(state, memberId, w.sessionId, w.day);
    const bests = program ? bestsBefore(state, memberId, program, w.day) : new Map();

    const exercises = (w.exercises || []).map((e) => {
      const meta = names.get(e.id) || { name: e.id, unit: "reps", perSide: false };
      // A set of zero is a set skipped, and reads as one — a dash, not a number.
      const sets = e.sets.map((n) => (Number.isFinite(n) && n > 0 ? n : null));
      const prev = previous && previous.exercises.find((x) => x.id === e.id);
      const before = bests.get(e.id);
      const done = sets.filter(Number.isFinite);
      return {
        id: e.id, name: meta.name, unit: meta.unit, perSide: meta.perSide,
        sets,
        previous: prev ? prev.sets.map((n) => (Number.isFinite(n) && n > 0 ? n : null)) : null,
        total: done.reduce((a, b) => a + b, 0),
        best: done.length ? Math.max(...done) : null,
        // Which sets beat the record as it stood BEFORE this day — a record set today beats
        // nothing but yesterday's, and that is the honest reading of "PB". The first time an
        // exercise is ever done beats nothing, the same as the session screen says (beatsBest).
        pb: sets.map((n) => Number.isFinite(n) && before !== undefined && n > before),
      };
    });
    // Nothing banked at all: a finish pressed on an empty session. Kept, and shown for what it
    // was, rather than removed — the log is append-only and it did happen.
    const empty = !exercises.some((e) => e.sets.some(Number.isFinite))
      && !(Number.isFinite(w.rounds) && w.rounds > 0) && !Number.isFinite(w.minutes);
    const reps = exercises.filter((e) => e.unit !== "s").reduce((n, e) => n + e.total, 0);
    const seconds = exercises.filter((e) => e.unit === "s").reduce((n, e) => n + e.total, 0);
    const setsDone = exercises.reduce((n, e) => n + e.sets.filter(Number.isFinite).length, 0);
    const minutes = Number.isFinite(w.startedAt) && Number.isFinite(w.endedAt) && w.endedAt > w.startedAt
      ? Math.round((w.endedAt - w.startedAt) / 60000)
      : (Number.isFinite(w.minutes) ? w.minutes : null);

    return {
      day: w.day,
      programId: w.programId,
      programName: program ? program.name : (w.programId || "Workout"),
      sessionId: w.sessionId,
      sessionName: session ? session.name : w.sessionId,
      kind: session ? session.kind : (Number.isFinite(w.rounds) ? "intervals" : Number.isFinite(w.minutes) ? "video" : "sets"),
      startedAt: w.startedAt ?? null,
      endedAt: w.endedAt ?? null,
      minutes,
      timed: Number.isFinite(w.startedAt) && Number.isFinite(w.endedAt),
      effort: w.effort || null,
      rounds: Number.isFinite(w.rounds) ? w.rounds : null,
      work: w.work ?? null,
      rest: w.rest ?? null,
      classMinutes: Number.isFinite(w.minutes) ? w.minutes : null,
      exercises,
      sets: setsDone,
      reps,
      seconds,
      pbs: exercises.filter((e) => e.pb.some(Boolean)).map((e) => e.name),
      empty,
      spans: spansOf(w),
      vitals: w.vitals || null,
      isToday: today ? w.day === today : false,
    };
  });
}

/** The best single set per exercise from every session BEFORE a day. */
function bestsBefore(state, memberId, program, day) {
  const out = new Map();
  for (const w of (state.workouts && state.workouts.get(memberId)) || []) {
    if (w.programId !== program.id || w.day >= day) continue;
    for (const e of w.exercises || []) {
      for (const n of e.sets) {
        if (!Number.isFinite(n) || n <= 0) continue;
        if (!out.has(e.id) || n > out.get(e.id)) out.set(e.id, n);
      }
    }
  }
  return out;
}

/**
 * One exercise, every time it was done, newest first — the rows an exercise's own sheet lists.
 *
 * Built from the workout log so each row carries the day, the sets with the record marked, the
 * total, and what the watch said about THIS exercise on that day. Across programs, because the
 * circuit and Monday's push day share a push-up, and so does the program somebody switched from.
 * `best` is the best single set ever and the day it was set; `bestTotal` the best session.
 */
export function exerciseLog(state, memberId, exerciseId, today = null) {
  const rows = [];
  let best = null;
  let bestTotal = null;
  for (const w of workoutLog(state, memberId, today)) {
    const e = w.exercises.find((x) => x.id === exerciseId);
    // Skipped throughout is not a session of it; the sets above already read zero as skipped.
    if (!e || !e.sets.some(Number.isFinite)) continue;
    const ev = w.vitals && w.vitals.exercises ? w.vitals.exercises.find((x) => x.id === exerciseId) : null;
    const span = (w.spans || []).find((x) => x.id === exerciseId);
    rows.push({
      day: w.day,
      sessionId: w.sessionId,
      sessionName: w.sessionName,
      name: e.name,
      unit: e.unit,
      perSide: e.perSide,
      sets: e.sets,
      pb: e.pb,
      total: e.total,
      best: e.best,
      minutes: span && span.ms >= 30_000 ? Math.round(span.ms / 60_000) : null,
      kcal: ev && Number.isFinite(ev.kcal) ? Math.round(ev.kcal) : null,
      kcalPerMin: ev && Number.isFinite(ev.kcal) && span && span.ms >= 60_000 ? ev.kcal / (span.ms / 60_000) : null,
      hrAvg: ev && Number.isFinite(ev.hrAvg) ? Math.round(ev.hrAvg) : null,
      hrMax: ev && Number.isFinite(ev.hrMax) ? Math.round(ev.hrMax) : null,
    });
  }
  // The record stands from the day it was first set: matching it later is not beating it, the
  // same rule the session screen uses (beatsBest). So the walk for it runs oldest-first and
  // only a strictly greater day moves it.
  for (const r of rows.slice().reverse()) {
    if (r.best !== null && (!best || r.best > best.value)) best = { value: r.best, day: r.day };
    if (!bestTotal || r.total > bestTotal.value) bestTotal = { value: r.total, day: r.day };
  }
  // Oldest-first for the chart; the rows above are newest-first for the list.
  const series = rows.slice().reverse().map((r) => ({ day: r.day, total: r.total, best: r.best }));
  return { rows, series, best, bestTotal, unit: rows.length ? rows[0].unit : "reps", name: rows.length ? rows[0].name : exerciseId };
}
