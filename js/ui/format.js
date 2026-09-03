// format.js — how a number is spoken.
//
// Kept apart from the dashboard because the same value is rendered in several places and a metric
// that reads "450" in one and "7h 30m" in another looks like two different numbers.

import { METRIC, AT_MOST, SOURCE } from "../schema.js";

/** A metric's value, in the words a person would use for it. */
export function value(metric, n) {
  if (n == null) return "—";
  if (metric === METRIC.SLEEP) {
    const h = Math.floor(n / 60);
    const m = Math.round(n % 60);
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
  [SOURCE.PAUSE]: { icon: "🫁", label: "Pause" },
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
