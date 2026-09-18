// format.js — how a number is spoken.
//
// Kept apart from the dashboard because the same value is rendered in several places and a metric
// that reads "450" in one and "7h 30m" in another looks like two different numbers.

import { METRIC, AT_MOST, SOURCE, PERIOD } from "../schema.js";

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

/**
 * A feed row's day, relative and unambiguous: "today" / "yesterday" / "Mon" / "Sat 13".
 *
 * Reads off the day the thing is ABOUT (a habit-day), not when the event was written — a reading
 * synced late is still yesterday's. And past the last week a bare weekday collides: two different
 * Saturdays look identical, so the date is pinned on once "Sat" alone stops being enough.
 */
export function feedDayLabel(day, today) {
  if (!day) return "";
  if (today && day === today) return "today";
  const diff = today ? daysBetweenISO(day, today) : null; // whole days day→today, positive if past
  if (diff === 1) return "yesterday";
  const [y, m, d] = day.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
  return diff !== null && diff >= 2 && diff <= 6 ? wd : wd + " " + d;
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
    // The run-in is not a month, and calling it one is exactly the kind of thing that reads as
    // a bug on the morning it starts.
    if (p.next.short && p.next.to) {
      return name + " starts " + dayLabel(p.next.from) + " on its own — a short one, to "
        + dayLabel(p.next.to) + "; then a month, every month from the " + ordinal(p.next.every) + ".";
    }
    return name + " starts " + dayLabel(p.next.from) + " on its own — a month, every month from the "
      + ordinal(p.next.every) + ".";
  }
  return name + " starts " + dayLabel(p.next.from) + ".";
}

/** "23:14" — a clock time in the reader's own zone. Used for when a night began and ended. */
export function clockLabel(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "07:00" from a minute of the day — the reminder-time field's display. */
export function toClock(minute) {
  return String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
}

/**
 * A minute of the day from a "07:00" field, clamped to a real time, or null when it is not one.
 *
 * Deliberately lenient on the parse (a typed field is), strict on the range: anything that is not
 * two numbers is null, and anything in range is clamped to [0, 1439] so a reminder is never set to
 * a minute that does not exist.
 */
export function fromClock(text) {
  const [h, m] = String(text || "").split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(1439, h * 60 + m));
}

/**
 * "23:14 \u2192 07:09" for a night; with "(phone quiet)" when it is the phone's estimate rather than
 * a watch's record, because the two are not the same claim and the history should say which.
 */
export function windowLabel(w) {
  if (!w) return null;
  return clockLabel(w.start) + " \u2192 " + clockLabel(w.end) + (w.source === "pause" ? " (phone quiet)" : "");
}

// ---------------------------------------------------------------------------
// The history chart's words: its axis, its ticks, and the range it is looking at.
//
// Pure, so the choices in them are pinned — which tick gets a second line, how a value is shortened
// to fit beside a bar — rather than living inline in the sheet where nothing could test them.
// ---------------------------------------------------------------------------

const MON_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_LETTER = ["M", "T", "W", "T", "F", "S", "S"];

function parts(day) {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m, d, dow: (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 };
}

/**
 * A value shortened for an axis, where there is room for four characters and no more.
 *
 * Minutes become hours ("7h", "7.5h", "45m"), thousands become "k" ("10k", "12.5k") and anything
 * else is rounded — the axis names a scale, the panel below names the number.
 */
export function axisValue(metric, n) {
  if (n == null || !Number.isFinite(n)) return "";
  if (metric === METRIC.SLEEP || metric === METRIC.SCREEN_MINUTES) {
    if (Math.abs(n) < 60) return Math.round(n) + "m";
    const h = n / 60;
    return (Number.isInteger(h) ? h : Math.round(h * 10) / 10) + "h";
  }
  if (Math.abs(n) >= 1000) {
    const k = n / 1000;
    return (Number.isInteger(k) ? k : Math.round(k * 10) / 10) + "k";
  }
  return String(Math.round(n));
}

/**
 * The top of a chart's scale: the smallest round number at or above the window's biggest value.
 *
 * Bars drawn to the raw maximum always have one touching the ceiling and an axis that reads
 * "7.8h"; a round top gives the tallest bar a little air and the axis a number somebody would say.
 * Round in the metric's own units — whole or half hours for a duration, thousands for steps — and
 * for anything under ten, the next whole one: a chart of workouts has no use for a top of 4.4.
 */
export function niceTop(metric, n) {
  if (!Number.isFinite(n) || n <= 0) return 1;
  let step;
  if (metric === METRIC.SLEEP || metric === METRIC.SCREEN_MINUTES) step = n < 240 ? 30 : 60;
  else if (n < 10) step = 1;
  else step = Math.pow(10, Math.floor(Math.log10(n))) / 5;
  return Math.ceil(n / step - 1e-9) * step;
}

/**
 * The stretch of days a chart covers, said once: "7 – 20 Sep", "31 Aug – 13 Sep", or across a
 * year "28 Dec 2025 – 10 Jan 2026". A months view names months: "Apr – Sep 2026".
 */
export function dateRange(from, to, view = PERIOD.DAY) {
  if (!from || !to) return "";
  const a = parts(from);
  const b = parts(to);
  if (view === PERIOD.MONTH) {
    if (a.y === b.y && a.m === b.m) return MON_ABBR[a.m - 1] + " " + a.y;
    if (a.y === b.y) return MON_ABBR[a.m - 1] + " – " + MON_ABBR[b.m - 1] + " " + a.y;
    return MON_ABBR[a.m - 1] + " " + a.y + " – " + MON_ABBR[b.m - 1] + " " + b.y;
  }
  if (from === to) return a.d + " " + MON_ABBR[a.m - 1];
  if (a.y !== b.y) {
    return a.d + " " + MON_ABBR[a.m - 1] + " " + a.y + " – " + b.d + " " + MON_ABBR[b.m - 1] + " " + b.y;
  }
  if (a.m === b.m) return a.d + " – " + b.d + " " + MON_ABBR[a.m - 1];
  return a.d + " " + MON_ABBR[a.m - 1] + " – " + b.d + " " + MON_ABBR[b.m - 1];
}

/**
 * What goes under each bar: a main label, and a second line only where the calendar turns.
 *
 * Days are their weekday letter, with the date under Mondays (and the first bar) so a fortnight
 * can be placed without counting. Weeks are the date of their Monday, with the month under the
 * first bar of each month. Months are their name, with the year under each January and the first.
 * Labelling every bar twice would double the ink for nothing; the second line is a landmark.
 */
export function chartTicks(entries) {
  let prev = null;
  return (entries || []).map((e) => {
    const p = parts(e.from);
    let main;
    let sub = null;
    if (e.period === PERIOD.WEEK) {
      main = String(p.d);
      if (!prev || prev.m !== p.m) sub = MON_ABBR[p.m - 1];
    } else if (e.period === PERIOD.MONTH) {
      main = MON_ABBR[p.m - 1];
      if (!prev || prev.y !== p.y) sub = String(p.y);
    } else {
      main = DOW_LETTER[p.dow];
      if (!prev || p.dow === 0) sub = String(p.d);
    }
    prev = p;
    return { main, sub };
  });
}
