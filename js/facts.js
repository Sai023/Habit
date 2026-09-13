// facts.js — things the log can say about a person, worded and ready to show.
//
// ---- What this is ----
//
// Tap your own name on Insights and this is what opens: a handful of facts about you, drawn from
// the record — how far you have walked since you joined, your best day, the weekday you are
// strongest on, the vape ceiling that has come down, the habit you have never once missed.
//
// ---- Three rules ----
//
// Nothing is said without enough to say it. A "strongest weekday" off two Tuesdays is the kind
// of claim somebody changes their week for, so every fact has a floor and is simply absent below
// it. A new member gets two or three facts and more arrive as the record grows.
//
// Everything is the person's own. These are computed from their log for their screen, and the
// shell shows them only to them. Nothing here crosses to the board or the group feed, which is
// what lets a sentence about the vape be said at all.
//
// Nothing is a verdict. The board judges; this observes. "You are best on Sundays" is a fact;
// "you should train on Sundays" would be advice, and the app is not in a position to give it.
//
// ---- Wire shape ----
//
// Each fact is { icon, title, text } — an emoji, a short label, one sentence — already worded,
// because the shell draws them and has no metric table. Same rule as every other field on the
// summary.

import {
  valueForPeriod, periodKey, addDays, targetFor, rawDayStatus, compareDays, HIT, MISS,
} from "./habits.js";
import { METRIC, PERIOD, AT_MOST, PAUSE_METRICS } from "./schema.js";
import { lifetime, titleBand, thresholdFor } from "./levels.js";
import { neverMissed } from "./history.js";
import { seasonTally } from "./season.js";
import { programFor, workoutInsights, MIN_INSIGHT_SESSIONS } from "./workout.js";
import * as fmt from "./ui/format.js";

/** Metres per step, a fair average adult stride. Only ever used for a sentence. */
const STEP_METRES = 0.762;
const MARATHON_KM = 42.195;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MIN_DAYS = 3;
const MIN_WEEKDAY_SAMPLES = 2;
const COMPARE_WINDOW_DAYS = 30;

const n = (x) => Math.round(x).toLocaleString();

export function factsAbout(state, memberId, today) {
  const life = lifetime(state, memberId, today);
  const out = [];
  if (!life.since || life.days < 1) return out;

  const habits = [...state.habits.values()];
  const mine = (metric) => habits.find((h) => h.metric === metric);
  const totals = dailyTotals(state, memberId, habits, life.since, addDays(today, -1));

  // ---- the record itself ----
  out.push({
    icon: "🗓",
    title: "Days played",
    text: n(life.days) + (life.days === 1 ? " day" : " days") + " since " + fmt.dayLabel(life.since)
      + " · " + n(life.banked) + " " + fmt.XP + ", " + n(life.banked / life.days) + " a day.",
  });
  if (life.days >= MIN_DAYS && life.bestDay) {
    out.push({
      icon: "⭐",
      title: "Your best day",
      text: fmt.dayLabel(life.bestDay.day) + " — " + life.bestDay.xp + " " + fmt.XP
        + (life.bestDay.xp > 100 ? ", goals beaten as well as met." : "."),
    });
  }
  if (life.weeksPlayed >= 2 && life.bestWeek) {
    out.push({
      icon: "📈",
      title: "Your best week",
      text: n(life.bestWeek.xp) + " " + fmt.XP + " in the week of " + fmt.dayLabel(life.bestWeek.week) + ".",
    });
  }
  if (life.perfectDays >= 1) {
    out.push({
      icon: "💯",
      title: "Perfect days",
      text: life.perfectDays === 1
        ? "One day at a full 100 — every goal met."
        : life.perfectDays + " days at a full 100 — every goal met.",
    });
  }

  // ---- the weekday pattern, only when there is one ----
  const byDay = life.weekdays
    .map((d, i) => ({ i, avg: d.days ? d.xp / d.days : null, days: d.days }))
    .filter((d) => d.days >= MIN_WEEKDAY_SAMPLES);
  if (byDay.length >= 3) {
    const best = byDay.reduce((a, b) => (b.avg > a.avg ? b : a));
    const worst = byDay.reduce((a, b) => (b.avg < a.avg ? b : a));
    out.push({
      icon: "📅",
      title: "Your strongest day",
      text: DAYS[best.i] + "s — " + n(best.avg) + " " + fmt.XP + " on average.",
    });
    if (best.avg - worst.avg >= 15) {
      out.push({
        icon: "🌥",
        title: "Your softest day",
        text: DAYS[worst.i] + "s — " + n(worst.avg) + " on average, " + n(best.avg - worst.avg) + " under your best.",
      });
    }
  }

  // ---- what the habits add up to ----
  const steps = mine(METRIC.STEPS);
  if (steps && totals.get(steps.habitId) && totals.get(steps.habitId).sum >= 1000) {
    const t = totals.get(steps.habitId);
    const km = (t.sum * STEP_METRES) / 1000;
    const marathons = km / MARATHON_KM;
    out.push({
      icon: "👟",
      title: "Distance walked",
      text: n(t.sum) + " steps since you joined — about " + (km >= 10 ? n(km) : km.toFixed(1)) + " km"
        + (marathons >= 1 ? ", " + (marathons >= 2 ? n(marathons) + " marathons." : "a marathon.") : ".")
        + (t.best ? " Your biggest day was " + n(t.best.value) + " on " + fmt.dayLabel(t.best.day) + "." : ""),
    });
  }
  const sleep = mine(METRIC.SLEEP);
  if (sleep && totals.get(sleep.habitId) && totals.get(sleep.habitId).days >= MIN_DAYS) {
    const t = totals.get(sleep.habitId);
    const hours = t.sum / 60;
    out.push({
      icon: "😴",
      title: "Time asleep",
      text: n(hours) + " hours over " + t.days + " nights — " + fmt.value(METRIC.SLEEP, t.sum / t.days) + " a night."
        + (t.best ? " Your longest was " + fmt.value(METRIC.SLEEP, t.best.value) + " on " + fmt.dayLabel(t.best.day) + "." : ""),
    });
  }
  const puffs = mine(METRIC.PUFFS);
  if (puffs && totals.get(puffs.habitId) && totals.get(puffs.habitId).days >= MIN_DAYS) {
    const t = totals.get(puffs.habitId);
    const first = targetFor(state, puffs, memberId, puffs.createdDay, puffs.createdDay);
    const now = targetFor(state, puffs, memberId, today, today);
    out.push({
      icon: "💨",
      title: "The vape",
      text: n(t.sum) + " puffs logged over " + t.days + " days, " + n(t.sum / t.days) + " a day."
        + (now < first ? " Your ceiling has come down from " + first + " to " + now + "." : ""),
    });
  }
  const screen = habits.find((h) => PAUSE_METRICS.has(h.metric) && h.period === PERIOD.DAY);
  if (screen && totals.get(screen.habitId) && totals.get(screen.habitId).judged >= MIN_DAYS) {
    const t = totals.get(screen.habitId);
    out.push({
      icon: "📱",
      title: (screen.name || "Screen time"),
      text: "Under your limit on " + t.hits + " of " + t.judged + " days"
        + (screen.metric === METRIC.SCREEN_MINUTES ? " — " + fmt.value(METRIC.SCREEN_MINUTES, t.sum) + " in total." : "."),
    });
  }
  const workouts = mine(METRIC.SESSIONS);
  if (workouts && totals.get(workouts.habitId) && totals.get(workouts.habitId).sum >= 1) {
    const t = totals.get(workouts.habitId);
    const program = programFor(state, memberId);
    const ins = program ? workoutInsights(state, memberId, program, today) : null;
    out.push({
      icon: "🏋",
      title: "Workouts",
      text: n(t.sum) + (t.sum === 1 ? " workout" : " workouts") + " logged since you joined."
        + (ins && ins.pbs.size ? " " + ins.pbs.size + " personal " + (ins.pbs.size === 1 ? "best" : "bests") + " on the books." : "")
        + (ins && ins.favourite && ins.sessions >= MIN_INSIGHT_SESSIONS ? " Favourite exercise: " + ins.favourite.name + "." : ""),
    });
  }
  const money = mine(METRIC.AMOUNT);
  if (money && totals.get(money.habitId) && totals.get(money.habitId).sum > 0) {
    out.push({
      icon: "💰",
      title: "Saved",
      text: fmt.value(METRIC.AMOUNT, totals.get(money.habitId).sum) + " put away since you joined.",
    });
  }

  // ---- the two things the board already says, said to you ----
  const unbroken = neverMissed(state, memberId, today);
  if (unbroken.length) {
    const top = unbroken[0];
    out.push({
      icon: "🛡",
      title: "Never missed",
      text: (top.habit.name || "A habit") + " — " + top.periods + " " + periodWord(top.period, top.periods) + " without a miss"
        + (unbroken.length > 1 ? ", and " + (unbroken.length - 1) + " more habit" + (unbroken.length > 2 ? "s" : "") + " unbroken." : "."),
    });
  }
  const noticed = correlation(state, memberId, habits, today);
  if (noticed) out.push(noticed);

  const members = [...state.members.keys()];
  if (members.length > 1) {
    const season = seasonTally(state, members, today);
    const me = season.rows.find((r) => r.memberId === memberId);
    if (me && season.weeks >= 1) {
      out.push({
        icon: "👑",
        title: "On the board",
        text: (me.crowns ? me.crowns + " of " + season.weeks + (season.weeks === 1 ? " week" : " weeks") + " won" : "No weeks won yet of " + season.weeks)
          + " · #" + me.rank + " of " + season.rows.length + " this season.",
      });
    }
  }

  // ---- what is coming ----
  if (!life.max && life.days >= MIN_DAYS) {
    const pace = life.banked / life.days;
    const band = titleBand(life.level);
    const nextDays = Math.ceil(life.need / pace);
    let text = "Level " + (life.level + 1) + " in about " + nextDays + (nextDays === 1 ? " day" : " days") + ".";
    if (band.nextAt) {
      const toTitle = Math.max(0, thresholdFor(band.nextAt) - life.banked);
      const titleDays = Math.ceil(toTitle / pace);
      text += " " + band.nextName + " (Level " + band.nextAt + ") around " + fmt.dayLabel(addDays(today, titleDays)) + ".";
    }
    out.push({ icon: "🧭", title: "At your pace", text });
  }

  return out;
}

/** "days" / "weeks" / "months" in the habit's own cadence. */
function periodWord(period, count) {
  const one = period === PERIOD.WEEK ? "week" : period === PERIOD.MONTH ? "month" : "day";
  return count === 1 ? one : one + "s";
}

/**
 * Every daily habit's values since joining, added up — with the best day for the ones where a
 * biggest number is a good number — and the hit count for the ones judged by a limit.
 *
 * Weekly and monthly habits are summed by period. A value that was never logged adds nothing.
 */
function dailyTotals(state, memberId, habits, from, to) {
  const out = new Map();
  if (from > to) return out;
  for (const habit of habits) {
    const period = habit.period || PERIOD.DAY;
    const t = { sum: 0, days: 0, best: null, hits: 0, judged: 0 };
    const seen = new Set();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (d < habit.createdDay) continue;
      const key = periodKey(d, period);
      if (seen.has(key)) continue;
      seen.add(key);
      const value = valueForPeriod(state, habit, memberId, key);
      if (period === PERIOD.DAY) {
        const status = rawDayStatus(state, habit, memberId, d, to);
        if (status === HIT || status === MISS) {
          t.judged += 1;
          if (status === HIT) t.hits += 1;
        }
      }
      if (!Number.isFinite(value)) continue;
      t.sum += value;
      t.days += 1;
      const reduce = habit.direction === AT_MOST;
      if (!reduce && (!t.best || value > t.best.value)) t.best = { day: d, value };
    }
    if (t.days || t.judged) out.set(habit.habitId, t);
  }
  return out;
}

/** The dashboard's "worth noticing", said to the person. Same engine call, same floors. */
function correlation(state, memberId, habits, today) {
  const daily = habits.filter((h) => h.period === PERIOD.DAY);
  const gate = daily.find((h) => PAUSE_METRICS.has(h.metric));
  if (!gate) return null;
  const from = addDays(today, -(COMPARE_WINDOW_DAYS - 1));
  let best = null;
  for (const subject of daily) {
    if (subject.habitId === gate.habitId) continue;
    const r = compareDays(state, gate.habitId, subject.habitId, memberId, from, today);
    if (!r) continue;
    const weight = r.met.days + r.missed.days;
    if (!best || weight > best.weight) best = { subject, r, weight };
  }
  if (!best || best.r.delta === 0) return null;
  const { subject, r } = best;
  const better = r.delta > 0;
  const gap = fmt.value(subject.metric, Math.abs(r.met.average - r.missed.average));
  return {
    icon: "🔍",
    title: "Worth noticing",
    text: "On the " + r.met.days + " days you kept " + (gate.name || "screen time") + " under, you averaged "
      + fmt.value(subject.metric, r.met.average) + " " + (subject.name || "").toLowerCase()
      + (better
        ? " — " + gap + " " + (subject.direction === AT_MOST ? "fewer" : "more") + " than the " + r.missed.days + " days you didn't."
        : " — the " + r.missed.days + " days you didn't were better by " + gap + "."),
  };
}
