// format.js — how a number is spoken.
//
// Kept apart from the dashboard because the same value is rendered in several places and a metric
// that reads "450" in one and "7h 30m" in another looks like two different numbers.

import { METRIC, AT_MOST, SOURCE } from "../schema.js";

/** A metric's value, in the words a person would use for it. */
export function value(metric, n) {
  if (n == null) return "—";
  // Both of these are stored in minutes and neither is spoken in them. Sleep has always been
  // rendered as a duration; screen time is the same kind of number and reading "144" where the
  // rest of the app says "2h 24m" is how one value starts looking like two.
  if (metric === METRIC.SLEEP || metric === METRIC.SCREEN_MINUTES) {
    const total = Math.round(n);
    const h = Math.floor(total / 60);
    const m = total % 60;
    // Under an hour, an "0h" prefix is noise — and screen time lives under an hour on a good day,
    // which is exactly when the number is worth reading cleanly.
    if (h === 0) return m + "m";
    return h + "h " + String(m).padStart(2, "0") + "m";
  }
  return Math.round(n).toLocaleString();
}

/** The target, phrased as the goal rather than as a bare number. */
export function goal(habit, target) {
  const v = value(habit.metric, target);
  return habit.direction === AT_MOST ? "of " + v + " max" : "of " + v;
}

/**
 * What a reduce habit has left, rather than what it has used.
 *
 * A budget counts DOWN. Showing "6 of 20" for something you are trying to quit puts the emphasis
 * on the wrong number and makes a bad day look like progress.
 */
export function remaining(habit, used, target) {
  const left = Math.max(0, target - (used || 0));
  return left + " left";
}

const SOURCE_LABEL = {
  [SOURCE.HEALTH_CONNECT]: { icon: "⌚", label: "auto" },
  [SOURCE.STRAVA]: { icon: "🔗", label: "Strava" },
  [SOURCE.PAUSE]: { icon: "📱", label: "on this phone" },
  // Named as a guess, every time it is shown. It is a good guess and it is still a guess, and a
  // number that quietly claims more than it can deliver is one somebody stops believing entirely.
  [SOURCE.PHONE]: { icon: "🛏", label: "estimated" },
  [SOURCE.MANUAL]: { icon: "✋", label: "manual" },
};

/**
 * How a number got here.
 *
 * Shown on every row on purpose. Manual entry is unfalsifiable in a group of friends, so rather
 * than trying to prevent it, the app makes the difference visible and lets that do the work.
 */
export function source(src) {
  return SOURCE_LABEL[src] || SOURCE_LABEL[SOURCE.MANUAL];
}

const DAY_MS = 86400000;

/** "today" / "yesterday" / "Mon" — a feed reads better in relative time. */
export function whenLabel(ts, now = Date.now()) {
  const diff = now - ts;
  if (diff < 60_000) return "now";
  if (diff < DAY_MS) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (diff < 2 * DAY_MS) return "yest";
  return new Date(ts).toLocaleDateString(undefined, { weekday: "short" });
}

/** The header's date line. */
export function dayLabel(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
}
