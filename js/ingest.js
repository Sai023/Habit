// ingest.js — turn raw sensor readings into habit log events. Pure, so it is node-testable.
//
// This is the seam between the native shell and everything else. Pause's WorkManager job reads
// Health Connect (which Samsung Health writes into on One UI 6+, so an S25 FE needs no separate
// Samsung integration), hands the readings over the bridge, and this decides what — if anything —
// is worth writing to the shared log.
//
// ---- Why this is not just "append what arrived" ----
//
// Health Connect is polled, and it re-reports the day's RUNNING TOTAL every time. A 15-minute
// job would append ~96 events per habit per day; three people with three habits would put roughly
// 300k rows a year into a log that every device replays on open, and that pull_events hands back
// 1000 at a time. The log would drown in telemetry.
//
// So the rule is: the event log records the day's OUTCOME, not the day's telemetry. A reading is
// written only when it actually says something new —
//
//   • the first reading of a day                          (there was nothing before)
//   • a reading that flips the day's verdict               (you just hit 10k — worth telling people)
//   • a backfill for an earlier day                        (the final word on a closed day)
//   • otherwise, at most once every THROTTLE_MS            (so the day's value still drifts upward)
//
// A live number for today's card comes from the sensor directly, not from the log. That is the
// distinction that keeps this cheap.

import { dayKey, daysBetween, valueOn, targetFor, sourceFor, isTracking } from "./habits.js";
import { ev, METRIC, MAX_BACKFILL_DAYS, AT_MOST, AGGREGATE } from "./schema.js";

/** Backstop for a value that keeps creeping without ever flipping the verdict. */
export const THROTTLE_MS = 30 * 60 * 1000;

/**
 * Which instant a reading belongs to.
 *
 * Sleep is attributed to the day you WOKE UP, which is the only convention that matches how
 * people talk about it ("I slept badly last night" is a statement about today). Everything else
 * belongs to when it happened.
 */
export function instantFor(metric, sample) {
  if (metric === METRIC.SLEEP) return sample.end != null ? sample.end : sample.start;
  return sample.start != null ? sample.start : sample.end;
}

function meets(state, habit, memberId, value, day) {
  const target = targetFor(state, habit, memberId, day);
  return habit.direction === AT_MOST ? value <= target : value >= target;
}

/**
 * Convert a batch of sensor readings into the events worth writing.
 *
 * Returns `{ events, emitted }` rather than writing anything: `emitted` is the updated throttle
 * bookkeeping, which the caller persists and hands back next time. Keeping that state outside
 * makes the whole decision pure and therefore testable without a database or a clock.
 *
 * @param state    replayed group state (see habits.replay)
 * @param memberId whose device is reporting
 * @param batch    { source, samples: [{ metric, start, end, value, externalId? }] }
 * @param opts     { now, emitted: Map, throttleMs }
 */
export function samplesToEvents(state, memberId, batch, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const throttleMs = opts.throttleMs != null ? opts.throttleMs : THROTTLE_MS;
  const emitted = new Map(opts.emitted || []);
  const events = [];
  const source = batch && batch.source;
  if (!source) return { events, emitted };

  for (const sample of (batch.samples || [])) {
    for (const habit of state.habits.values()) {
      if (!habit.metric || habit.metric !== sample.metric) continue;
      // A habit is only fed by the source this member is actually bound to. Without this, one
      // person's watch would write into a habit another person types in by hand.
      if (sourceFor(state, habit, memberId) !== source) continue;
      // Discrete events (urges, workouts) are appended as they happen by their own path — the
      // "has it changed?" test below is meaningless for something that is always +1.
      if (habit.aggregate === AGGREGATE.SUM) continue;
      // Nothing to report for a habit this person opted out of.
      if (!isTracking(state, habit, memberId)) continue;

      const instant = instantFor(habit.metric, sample);
      if (instant == null) continue;

      const day = dayKey(instant, habit.tz, habit.dayStartHour);
      const todayKey = dayKey(now, habit.tz, habit.dayStartHour);

      // Do not write rows the engine will reject on replay anyway — see MAX_BACKFILL_DAYS.
      if (daysBetween(day, todayKey) > MAX_BACKFILL_DAYS) continue;

      const value = Number(sample.value) || 0;
      const known = valueOn(state, habit, memberId, day);
      if (known === value) continue; // the common case: nothing has changed since the last poll

      const isFirst = known === null;
      const flips = !isFirst && meets(state, habit, memberId, known, day) !== meets(state, habit, memberId, value, day);
      const isClosedDay = day !== todayKey;

      if (!isFirst && !flips && !isClosedDay) {
        const key = habit.habitId + "|" + day;
        const last = emitted.get(key) || 0;
        if (now - last < throttleMs) continue;
      }

      events.push(ev.log(habit.habitId, memberId, day, value, source, sample.externalId || null));
      emitted.set(habit.habitId + "|" + day, now);
    }
  }

  return { events, emitted };
}

/**
 * One discrete thing that happened — an urge resisted or given in to, a logged workout.
 *
 * Kept separate from samplesToEvents because the semantics invert: there is no running total to
 * compare against and no reason to throttle. Each of these IS the record.
 */
export function discreteEvent(state, memberId, habitId, day, amount = 1, source = "pause", externalId = null) {
  const habit = state.habits.get(habitId);
  if (!habit) return null;
  return ev.log(habitId, memberId, day, amount, source, externalId);
}

/** Today's day key for a habit, using its pinned timezone rather than the device's. */
export function todayFor(habit, now = Date.now()) {
  return dayKey(now, habit.tz, habit.dayStartHour);
}
