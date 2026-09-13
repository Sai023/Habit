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
/**
 * What the currency is called on screen.
 *
 * "XP" — experience points. One constant rather than the word typed in eleven places, because it
 * was "pts" in eleven places and renaming it meant finding all eleven; the next rename should be
 * one line. `XP_LONG` is the spelled-out form for the first mention on an explanatory screen.
 */
export const XP = "XP";
export const XP_LONG = "experience points";

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

/**
 * Date arithmetic for screens, kept here rather than importing the engine into a sheet.
 *
 * The same maths habits.js does, and it has to stay the same: a sheet that computes an end date one
 * day off from the one the board later shows is a sheet that lied at the moment of agreeing.
 */
export function addDaysISO(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`; negative when b is earlier. */
export function daysBetweenISO(a, b) {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

/** The Monday of the ISO week containing this day. */
export function mondayOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const iso = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  return addDaysISO(day, 1 - iso);
}

/**
 * How one habit went over a week, from the board's per-habit bookkeeping: "5 of 6 days",
 * "done this week", "40% of the way this month". Null when there is nothing to say yet.
 */
export function habitWeek(h) {
  if (h.period === "day") {
    return h.eligible ? h.hits + " of " + h.eligible + (h.eligible === 1 ? " day" : " days") : null;
  }
  const unit = h.period === "week" ? "week" : "month";
  if (h.open != null) return h.open >= 1 ? "done this " + unit : Math.round(h.open * 100) + "% of the way this " + unit;
  if (h.eligible) return h.hits ? "met this " + unit : "missed this " + unit;
  return null;
}

/** "20th", "1st", "22nd" — a day of the month, said the way people say it. */
export function ordinal(n) {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return n + "th";
  const last = n % 10;
  return n + (last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th");
}

/**
 * How long is left of a season, in the largest unit that is still honest.
 *
 * "38 days" is a number somebody has to convert; "5 weeks" is the same fact already converted. It
 * switches to days inside a fortnight, because that is the point at which the days start mattering
 * individually — and to "today" on the last one, which is the only day the wording has to be
 * exactly right. Takes the progress object from seasonProgress.
 */
export function seasonLeft(p) {
  if (p.ended) return "Season over";
  if (p.daysLeft === 0) return "Ends today";
  if (p.daysLeft === 1) return "1 day left";
  if (p.daysLeft < 14) return p.daysLeft + " days left";
  const weeks = Math.round(p.daysLeft / 7);
  return weeks + " weeks left";
}

/**
 * The season after this one, as a sentence — or null when nothing follows.
 *
 * Under a schedule the next season starts by itself, and the sentence says so, because a season
 * that begins with nobody pressing anything is a season nobody was warned about otherwise. Booked
 * by hand, it is simply announced.
 */
export function seasonNext(p) {
  if (!p.next) return null;
  const name = p.next.index ? "Season " + p.next.index : "The next season";
  if (p.next.every) {
    return name + " starts " + dayLabel(p.next.from) + " on its own — a month, every month from the "
      + ordinal(p.next.every) + ".";
  }
  return name + " starts " + dayLabel(p.next.from) + ".";
}
