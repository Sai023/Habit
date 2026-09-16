// vitals.js — what the watch said about the workouts, and what that says about the person.
//
// ---- What this is built on ----
//
// A workout logged in the app carries a clock: when it began, when it ended, and when each set was
// banked (see workout.js spansOf). The phone reads Health Connect afterwards for that window —
// heart-rate samples, active calories — and writes a T.VITALS event that replay lays over the
// workout. Per exercise where the sets were stamped, because each set owns the time since the one
// before it. That is the whole trick: a watch measures time, the app measures what you did with
// it, and the join is the clock.
//
// ---- What it will not claim ----
//
// Nothing without a watch. The phone's own pedometer has no heart rate and estimates no calories
// for a plank; a workout with no vitals is simply a workout, and every figure below is absent
// rather than zero. Nothing from one session either: a cost-per-minute from a single Tuesday is
// an anecdote, so the ranking needs MIN_VITALS_SESSIONS workouts with vitals before it speaks.
//
// ---- Why calories per minute, not calories ----
//
// "Burpees burned 90 kcal" depends on how long you did them. "Burpees cost 9 kcal a minute" is a
// property of the exercise and the person, holds across sessions, and is the number that answers
// "what should I do more of when I am short on time". The heart rate beside it says how hard it
// felt, which is the half a calorie count leaves out.

/** Workouts with vitals before the ranking says anything. Three is a pattern; one is a day. */
export const MIN_VITALS_SESSIONS = 3;

/** Minutes an exercise needs across the log before its rate is believed. */
const MIN_EXERCISE_MINUTES = 3;

/**
 * Across the log: each exercise's cost per minute and average heart rate, ranked; the hardest
 * workout; the total. Takes the log from workoutLog, so the names and spans are already there.
 *
 * Returns null until MIN_VITALS_SESSIONS workouts carry vitals — see the header for why.
 */
export function vitalsInsights(log) {
  const withVitals = (log || []).filter((w) => w.vitals && (w.vitals.kcal || w.vitals.hrAvg));
  if (withVitals.length < MIN_VITALS_SESSIONS) return null;

  // Per exercise: calories and minutes summed across every stamped session, heart rate weighted
  // by the minutes it was measured over.
  const byId = new Map();
  for (const w of withVitals) {
    const per = (w.vitals.exercises || []);
    for (const ev of per) {
      const span = (w.spans || []).find((s) => s.id === ev.id);
      if (!span || span.ms <= 0) continue;
      const ex = w.exercises.find((e) => e.id === ev.id);
      const name = ex ? ex.name : (ev.id === w.sessionId ? w.sessionName : ev.id);
      const min = span.ms / 60_000;
      const e = byId.get(ev.id) || { id: ev.id, name, minutes: 0, kcal: 0, hrMinutes: 0, hrWeighted: 0, hrMax: null, sessions: 0 };
      e.minutes += min;
      if (Number.isFinite(ev.kcal)) e.kcal += ev.kcal;
      if (Number.isFinite(ev.hrAvg)) { e.hrMinutes += min; e.hrWeighted += ev.hrAvg * min; }
      if (Number.isFinite(ev.hrMax) && (e.hrMax === null || ev.hrMax > e.hrMax)) e.hrMax = ev.hrMax;
      e.sessions += 1;
      byId.set(ev.id, e);
    }
  }

  const exercises = [...byId.values()]
    .filter((e) => e.minutes >= MIN_EXERCISE_MINUTES && e.kcal > 0)
    .map((e) => ({
      id: e.id, name: e.name, sessions: e.sessions,
      minutes: Math.round(e.minutes),
      kcal: Math.round(e.kcal),
      kcalPerMin: e.kcal / e.minutes,
      hrAvg: e.hrMinutes ? e.hrWeighted / e.hrMinutes : null,
      hrMax: e.hrMax,
    }))
    .sort((a, b) => b.kcalPerMin - a.kcalPerMin);

  // The workout that cost the most, and the one that pushed the heart hardest — usually the
  // same day, and worth naming when they are not.
  const dearest = withVitals.reduce((best, w) => (!best || (w.vitals.kcal || 0) > (best.vitals.kcal || 0) ? w : best), null);
  const hardest = withVitals.reduce((best, w) => (!best || (w.vitals.hrMax || 0) > (best.vitals.hrMax || 0) ? w : best), null);

  const totalKcal = withVitals.reduce((n, w) => n + (w.vitals.kcal || 0), 0);
  const totalMin = withVitals.reduce((n, w) => n + (w.minutes || 0), 0);
  const hrAvg = (() => {
    const measured = withVitals.filter((w) => w.vitals.hrAvg && w.minutes);
    const min = measured.reduce((n, w) => n + w.minutes, 0);
    return min ? measured.reduce((n, w) => n + w.vitals.hrAvg * w.minutes, 0) / min : null;
  })();

  // Recovery across workouts: the drop a minute after a set, averaged over the sessions that
  // measured one. The one number here that is about fitness rather than about effort.
  const recovered = withVitals.filter((w) => Number.isFinite(w.vitals.recovery));
  const recovery = recovered.length
    ? recovered.reduce((n, w) => n + w.vitals.recovery, 0) / recovered.length
    : null;
  const rested = withVitals.filter((w) => Number.isFinite(w.vitals.hrRest));
  const hrRest = rested.length ? rested.reduce((n, w) => n + w.vitals.hrRest, 0) / rested.length : null;

  const top = exercises[0] || null;
  const line = top
    ? top.name + " costs the most at " + top.kcalPerMin.toFixed(1) + " kcal a minute"
      + (exercises.length > 1 ? "; " + exercises[exercises.length - 1].name + " the least at "
        + exercises[exercises.length - 1].kcalPerMin.toFixed(1) : "")
      + ". Over " + withVitals.length + " workouts with a watch on: " + Math.round(totalKcal) + " kcal in "
      + Math.round(totalMin) + " minutes"
      + (hrAvg ? ", averaging " + Math.round(hrAvg) + " bpm" : "") + "."
      + (recovery !== null ? " Your heart drops " + Math.round(recovery) + " bpm in the minute after a set." : "")
    : "The watch has heart rate for " + withVitals.length + " workouts but no exercise has three stamped minutes yet.";

  return {
    sessions: withVitals.length,
    totalKcal: Math.round(totalKcal),
    totalMinutes: Math.round(totalMin),
    hrAvg: hrAvg === null ? null : Math.round(hrAvg),
    hrRest: hrRest === null ? null : Math.round(hrRest),
    recovery: recovery === null ? null : Math.round(recovery),
    exercises,
    dearest: dearest && dearest.vitals.kcal
      ? { day: dearest.day, name: dearest.sessionName, kcal: Math.round(dearest.vitals.kcal) }
      : null,
    hardest: hardest && hardest.vitals.hrMax
      ? { day: hardest.day, name: hardest.sessionName, hrMax: Math.round(hardest.vitals.hrMax) }
      : null,
    line,
  };
}

/**
 * The workouts the phone should go and read the watch for: the timed ones from the last few
 * days, with each exercise's window. Handed to the shell with the sync config; it reads Health
 * Connect for each window on every sync and writes a T.VITALS event when the answer changed.
 *
 * Days rather than "the last one", because a watch's data reaches Health Connect late — hours,
 * sometimes a day — and a window read once at the end of the workout would find nothing. Two
 * days is the same allowance the log gives a backfilled reading.
 */
export function windowsToRead(log, today, addDays, backfillDays) {
  const oldest = addDays(today, -backfillDays);
  return (log || [])
    .filter((w) => w.timed && w.day >= oldest && w.endedAt > w.startedAt)
    .map((w) => ({
      sessionId: w.sessionId,
      day: w.day,
      start: w.startedAt,
      end: w.endedAt,
      exercises: (w.spans || []).map((s) => ({ id: s.id, spans: s.spans })),
    }));
}
