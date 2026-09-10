// pull.js — how far a drag down at the top of the page has actually pulled.
//
// Separated from the gesture handling because this is the half that can be wrong quietly. The
// listeners either fire or they do not, and a dead listener announces itself the first time
// somebody tries; a resistance curve that triggers at the wrong distance just feels bad, on a
// phone, to somebody who will report it as "it does not really work".
//
// ---- Why there is resistance at all ----
//
// A pull-to-refresh that tracks the finger one-to-one fires by accident. Flicking to the top of a
// list overshoots, and an overshoot is a drag down at scroll zero, which is the exact gesture. The
// damping is what makes a deliberate pull feel different from an enthusiastic scroll — you have to
// keep going after the list has stopped, and that continuing is the intent.
//
// Past the trigger it damps harder, so the indicator visibly stops following. That is the only
// signal available that you have gone far enough: there is no click and nothing to press against.

/** Slack before anything moves, so a tap with a shaky thumb is not a pull. */
export const START_PX = 6;

/** How far the indicator must travel to arm the refresh. */
export const TRIGGER_PX = 64;

/** How far it can travel at all, however hard you pull. */
export const MAX_PX = 92;

/** Indicator pixels per finger pixel, before the trigger. */
const RESIST = 0.8;

/** Indicator pixels per finger pixel, after it. */
const OVER_RESIST = 0.3;

/**
 * How far the indicator has moved, given how far the finger has.
 *
 * Monotonic and clamped: never negative, never past [MAX_PX]. A negative dy is a drag UP, which is
 * an ordinary scroll and not this gesture at all.
 */
export function pullDistance(dy) {
  const travelled = (dy || 0) - START_PX;
  if (travelled <= 0) return 0;

  const linear = travelled * RESIST;
  if (linear <= TRIGGER_PX) return linear;

  return Math.min(MAX_PX, TRIGGER_PX + (linear - TRIGGER_PX) * OVER_RESIST);
}

/** Would letting go now start a sync? */
export function armed(dy) {
  return pullDistance(dy) >= TRIGGER_PX;
}

/**
 * How far through the pull we are, 0 to 1 — what the indicator draws itself with.
 *
 * Capped at 1 at the trigger rather than at [MAX_PX], because the thing being expressed is "this
 * will fire", and a ring that keeps filling after the decision has been made is telling you about
 * your finger instead of about the app.
 */
export function pullProgress(dy) {
  return Math.min(1, pullDistance(dy) / TRIGGER_PX);
}
