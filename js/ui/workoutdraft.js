// workoutdraft.js — what has been banked in a session that is not finished yet.
//
// Split out of workoutsheet.js so two screens can read it. A workout sheet swiped away mid-session
// — which is what a pull-down at the top of any sheet in this app does — keeps every set in this
// draft, and the person who did the swiping then has to be able to FIND it: on the hub, where the
// session says "in progress · 4 of 15 sets", and on the Workouts habit's detail, where the way
// back in is one tap. Before this the draft was there and nothing on any screen said so, which
// reads as the sets having been lost.
//
// One draft per session, keyed on the session id and checked against the day, so a rope day and
// the finisher that follows it do not share a slot and yesterday's half-session does not open as
// today's.

import { progress } from "../workout.js";

const draftKey = (sessionId) => "workout-draft:" + sessionId;

export function loadDraft(programId, sessionId, day) {
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (d.programId === programId && d.sessionId === sessionId && d.day === day) return d;
  } catch { /* corrupt or unavailable */ }
  return null;
}

export function saveDraft(d) {
  try { localStorage.setItem(draftKey(d.sessionId), JSON.stringify(d)); } catch { /* full or unavailable */ }
}

export function clearDraft(sessionId) {
  try { localStorage.removeItem(draftKey(sessionId)); } catch { /* ignore */ }
}

/**
 * How far today's draft of a session has got, or null when there is none.
 *
 * Sets sessions count banked sets; a rope session counts rounds. Either way `{ done, of }`, and
 * only when at least one thing has been banked — an empty draft is not a session in progress.
 */
export function draftProgress(program, session, day) {
  if (!program || !session) return null;
  const d = loadDraft(program.id, session.id, day);
  if (!d) return null;
  if (session.kind === "intervals") {
    return d.rounds > 0 ? { done: d.rounds, of: null } : null;
  }
  const p = progress(session, d.draft || {});
  return p.done > 0 ? p : null;
}

/** Every session of the program with a draft for today, in program order. */
export function draftsInProgress(program, sessions, day) {
  return (sessions || [])
    .map((session) => ({ session, at: draftProgress(program, session, day) }))
    .filter((x) => x.at);
}
