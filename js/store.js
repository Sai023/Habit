// store.js — the app's command layer.
//
// Every mutation follows the local-first invariant:
//   1) build an immutable event   2) commit to IndexedDB   3) invalidate derived   4) enqueue
//
// The UI always renders from local state, so nothing here depends on the network being up. The
// sync engine drains the queue whenever it can, and merges what other people wrote.

import { db } from "./db.js";
import { replay } from "./habits.js";
import { ev, T, SOURCE } from "./schema.js";
import { uuid, groupCode as newGroupCode, normalizeGroupCode } from "./id.js";
import { samplesToEvents, discreteEvent } from "./ingest.js";
import { encodeSetup, encodeInvite } from "./setup-code.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

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

/**
 * Start a new group. Returns the code to share with the others.
 *
 * Habits are created here rather than left for later because a group with none is a dead end:
 * there is nothing for anyone to show up for, and nothing for a phone's background sync to read.
 * They are ordinary habits once made — editable, deletable — not a fixed set.
 */
export async function createGroup(name, myName, starters = []) {
  const code = newGroupCode();
  await db.setMeta("groupCode", code);
  await db.setMeta("name", myName || "Me");
  const { memberId } = await identity();

  const specs = [
    ev.meta({ name: name || "Our group", createdAt: Date.now() }),
    ev.member(memberId, myName || "Me"),
  ];
  for (const starter of starters) {
    const { habitId = uuid(), ...fields } = starter;
    specs.push(ev.habit(habitId, fields));
    // A browser cannot read health data, so "manual" is the honest binding until Pause joins on a
    // phone and re-declares it. Claiming otherwise would have missed days read as a broken watch.
    specs.push(ev.bind(memberId, habitId, SOURCE.MANUAL));
  }
  await commitAll(specs);
  return code;
}

/**
 * Make sure every habit has a source declared for me.
 *
 * Called after a join, once the room's habits have actually arrived — you cannot bind to a habit
 * you have not heard of yet. Without this a joiner has no binding at all, and every quiet day
 * falls back to the habit's default source rather than to what their device can really supply.
 */
export async function ensureBindings(source = SOURCE.MANUAL) {
  const state = await getState();
  const { memberId } = await identity();
  const specs = [];
  for (const habit of state.habits.values()) {
    if (!state.bindings.has(memberId + "|" + habit.habitId)) {
      specs.push(ev.bind(memberId, habit.habitId, source));
    }
  }
  if (specs.length) await commitAll(specs);
  return specs.length;
}

/**
 * The string to paste into Pause on this phone.
 *
 * Carries the member id, so the shell posts as the same person this browser does rather than
 * appearing as a second member with half the data. Not for sharing — see setup-code.js.
 */
/**
 * The string to send somebody so they can join.
 *
 * Deliberately built from the same connection details as the setup code and WITHOUT the member
 * id, so it can be forwarded to a group chat without turning anybody into anybody else.
 */
export async function inviteCode() {
  const { code } = await identity();
  if (!code) return "";
  const web = typeof location !== "undefined" ? location.origin : "";
  return encodeInvite({ url: SUPABASE_URL, key: SUPABASE_ANON_KEY, code, web });
}

export async function setupCode() {
  const { memberId, name, code } = await identity();
  if (!code) return "";
  // location.origin travels too: Pause fires the daily reminders, and tapping one has to open
  // this app rather than dead-ending in the shell.
  const web = typeof location !== "undefined" ? location.origin : "";
  return encodeSetup({ url: SUPABASE_URL, key: SUPABASE_ANON_KEY, code, memberId, name, web });
}

/**
 * Take on an identity the shell has already established.
 *
 * Pause has been posting to the room under a member id of its own since setup. This browsing
 * context has never seen it: a WebView starts with an empty database, so left alone it would walk
 * the user through onboarding a second time and mint a second id for the same person — half their
 * data on one leaderboard row, half on another, and nothing anywhere saying why.
 *
 * Deliberately refuses to overwrite. If this context has already joined something — someone
 * testing standalone, or a build from before this existed — that stays authoritative, because
 * silently repointing a device at a different room is far worse than showing onboarding once.
 */
export async function adoptIdentity({ code, memberId, name } = {}) {
  if (!code || !memberId) return false;
  if (await db.getMeta("groupCode", null)) return false;

  await db.setMeta("groupCode", code);
  await db.setMeta("memberId", memberId);
  await db.setMeta("name", name || "Me");
  invalidateDerived();
  // No member event is committed here. The shell already pushed one under this id when it joined,
  // so this device is adopting an identity the room has heard of, not announcing a new one.
  return true;
}

/**
 * Join an existing group. Creates nothing but the local pointer; the next pull brings the habits,
 * the members and the whole history down and the app materialises from that.
 */
export async function joinGroup(code, myName) {
  // Normalise rather than merely validate: what arrives has been read off one screen and typed
  // into another phone, so it turns up with stray spaces, an autocorrected dash, or no prefix.
  const normalized = normalizeGroupCode(code);
  if (!normalized) throw new Error("That doesn't look like a group code.");
  await db.setMeta("groupCode", normalized);
  await db.setMeta("name", myName || "Me");
  const { memberId } = await identity();
  await commit(ev.member(memberId, myName || "Me"));
  return normalized;
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
  // A millisecond apart, deliberately. Identical timestamps make replay fall back to comparing
  // event ids, which are random — so a batch of habits created together would come out in a
  // different order on every device, and the dashboard would shuffle its own cards.
  const events = specs.map((s, i) => ({
    eventId: uuid(), type: s.type, author: memberId, ts: now + i, payload: s.payload,
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

/**
 * Set MY goals: which of the group's habits I'm doing, and my own number for each.
 *
 * Committed as one batch so a whole setup screen is a single sync, and so the group never sees a
 * half-configured member with three of their five goals in place.
 */
export async function setGoals(entries) {
  const { memberId } = await identity();
  const specs = (entries || []).map((e) =>
    ev.goal(memberId, e.habitId, { target: e.target, active: e.active !== false }));
  return commitAll(specs);
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
