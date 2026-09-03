// store.js — the app's command layer.
//
// Every mutation follows the local-first invariant:
//   1) build an immutable event   2) commit to IndexedDB   3) invalidate derived   4) enqueue
//
// The UI always renders from local state, so nothing here depends on the network being up. The
// sync engine drains the queue whenever it can, and merges what other people wrote.

import { db } from "./db.js";
import { replay } from "./habits.js";
import { ev, T } from "./schema.js";
import { uuid, groupCode as newGroupCode, isGroupCode } from "./id.js";
import { samplesToEvents, discreteEvent } from "./ingest.js";

export { uuid };

// ---- derived-state cache ----
//
// getState() replays the ENTIRE log. Every render would otherwise pay for it, several times over
// on a screen that shows a dashboard and a leaderboard together. Habits are UNBOUNDED where a
// trip ends, so this is the thing that ages worst if left alone.
//
// The log is append-only, so an unchanged event COUNT means unchanged derived state — and
// counting is an index read with no deserialization, where replaying is not. Events merged by the
// sync engine land via db.addEvent directly, bypassing this module, but they move the count, so
// the probe catches them without sync.js having to know this cache exists.
let _cache = null;    // { state, count }
let _inflight = null;

export function invalidateDerived() {
  _cache = null;
  _inflight = null;
}

export async function getState() {
  const count = await db.countEvents();
  if (_cache && _cache.count === count) return _cache.state;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const events = await db.allEvents();
    const state = replay(events);
    _cache = { state, count: events.length };
    _inflight = null;
    return state;
  })();
  return _inflight;
}

// ---- identity ----
//
// There are no accounts. The group code is the capability, exactly as a trip code is in Passport:
// knowing it lets you read and append to this one room and nothing else. A per-device memberId
// (a UUID) is minted once on join, so someone can rename themselves without orphaning their
// history — and so a future Health Connect binding has something stable to attach to.

export async function identity() {
  let memberId = await db.getMeta("memberId");
  if (!memberId) {
    memberId = uuid();
    await db.setMeta("memberId", memberId);
  }
  return {
    memberId,
    name: await db.getMeta("name", ""),
    code: await db.getMeta("groupCode", null),
  };
}

export async function currentCode() {
  return db.getMeta("groupCode", null);
}

/** Start a new group. Returns the code to share with the others. */
export async function createGroup(name, myName) {
  const code = newGroupCode();
  await db.setMeta("groupCode", code);
  await db.setMeta("name", myName || "Me");
  await commit(ev.meta({ name: name || "Our group", createdAt: Date.now() }));
  const { memberId } = await identity();
  await commit(ev.member(memberId, myName || "Me"));
  return code;
}

/**
 * Join an existing group. Creates nothing but the local pointer; the next pull brings the habits,
 * the members and the whole history down and the app materialises from that.
 */
export async function joinGroup(code, myName) {
  const upper = String(code || "").trim().toUpperCase();
  if (!isGroupCode(upper)) throw new Error("That doesn't look like a group code.");
  await db.setMeta("groupCode", upper);
  await db.setMeta("name", myName || "Me");
  const { memberId } = await identity();
  await commit(ev.member(memberId, myName || "Me"));
  return upper;
}

export async function rename(myName) {
  const { memberId } = await identity();
  await db.setMeta("name", myName);
  return commit(ev.member(memberId, myName));
}

// ---- the event helper ----

/**
 * Commit one event locally and queue it for the cloud.
 *
 * `author` is the memberId rather than a display name: names change, and a leaderboard keyed on a
 * string that someone can edit would lose their history the first time they fixed a typo.
 */
export async function commit(spec) {
  const { memberId } = await identity();
  const event = {
    eventId: uuid(),
    type: spec.type,
    author: memberId,
    ts: Date.now(),
    payload: spec.payload,
  };
  await db.addEvent(event);
  invalidateDerived();
  await db.enqueue(event.eventId);
  return event;
}

/** Commit several events as one batch — one derive invalidation, one queue pass. */
export async function commitAll(specs) {
  if (!specs || !specs.length) return [];
  const { memberId } = await identity();
  const now = Date.now();
  const events = specs.map((s) => ({
    eventId: uuid(), type: s.type, author: memberId, ts: now, payload: s.payload,
  }));
  for (const e of events) await db.addEvent(e);
  invalidateDerived();
  for (const e of events) await db.enqueue(e.eventId);
  return events;
}

// ---- habits ----

export async function saveHabit(habitId, fields) {
  return commit(ev.habit(habitId || uuid(), fields));
}

export async function deleteHabit(habitId) {
  return commit(ev.deleteHabit(habitId));
}

/** Point one of MY habits at a source. Per member — see schema.T.BINDING. */
export async function bindSource(habitId, source) {
  const { memberId } = await identity();
  return commit(ev.bind(memberId, habitId, source));
}

export async function setTravelMode(from, to, habitId = null) {
  const { memberId } = await identity();
  return commit(ev.exempt(memberId, from, to, "travel", habitId));
}

// ---- logging ----

/** A manual entry, or a value the user corrected by hand. */
export async function logValue(habitId, day, value, source = "manual") {
  const { memberId } = await identity();
  return commit(ev.log(habitId, memberId, day, value, source));
}

/** One discrete thing that just happened — an urge resisted, a workout done. */
export async function logDiscrete(habitId, day, amount = 1, source = "pause") {
  const state = await getState();
  const { memberId } = await identity();
  const spec = discreteEvent(state, memberId, habitId, day, amount, source);
  return spec ? commit(spec) : null;
}

/**
 * Take a batch of sensor readings from the native shell and write only what is worth writing.
 *
 * The throttle bookkeeping lives in `meta` so it survives the WebView being torn down and
 * recreated — which Android will do freely, and which would otherwise reset the throttle and put
 * the flood of per-poll rows straight back.
 */
export async function ingestSamples(batch, now = Date.now()) {
  const state = await getState();
  const { memberId } = await identity();
  const stored = await db.getMeta("ingest:emitted", []);
  const { events, emitted } = samplesToEvents(state, memberId, batch, {
    now,
    emitted: new Map(stored),
  });
  if (!events.length) return [];
  await commitAll(events);
  await db.setMeta("ingest:emitted", [...emitted]);
  return events;
}

/** Every event, oldest first — for export, and for the sync engine's initial push. */
export async function exportAll() {
  return { app: "habit", v: 1, code: await currentCode(), events: await db.allEvents() };
}
