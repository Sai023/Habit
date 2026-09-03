// sync.js — the "local-first with cloud fail-safe" engine.
//
// The app is always fully usable from IndexedDB. This module MIRRORS the local event queue to the
// group's cloud room and pulls back what everyone else wrote, degrading gracefully when it can't.
//
// States (the pill in the header):
//   LOCAL_ONLY — no cloud configured, or no group joined. Everything works; nothing syncs.
//   OFFLINE    — network gone. The queue grows locally and drains on reconnect.
//   SYNCING    — actively pushing or pulling.
//   SYNCED     — queue empty, up to date.
//   DEGRADED   — the cloud errored or is paused. Circuit breaker tripped: behave local-only and
//                probe again with exponential backoff. The user never sees a crash.
//
// Simpler than Passport's engine in one way and not at all in another. Simpler: a habit device is
// in exactly ONE room, so there is no per-trip loop and no priority scheduling. Not simpler: the
// server-timestamp restamp below matters MORE here than it does for a trip, because habit state
// is derived by walking days in order and an unstamped event would sort by the author's own
// clock — so the same log could produce different streaks on different phones.

import { db } from "./db.js";
import { invalidateDerived } from "./store.js";

export const STATES = {
  LOCAL_ONLY: "LOCAL_ONLY",
  OFFLINE: "OFFLINE",
  SYNCING: "SYNCING",
  SYNCED: "SYNCED",
  DEGRADED: "DEGRADED",
};

const POLL_MS = 15_000;          // while the app is open and visible
const BACKOFF_START = 30_000;
const BACKOFF_MAX = 10 * 60_000;
/** pull_events caps a page at 1000 rows; a full page means there is more behind it. */
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;            // 20k events in one flush is a catch-up, not a normal sync

// ============================================================================
// The decisions, extracted so they can be tested
// ============================================================================
//
// The rest of this file is I/O — IndexedDB, fetch, window events — and cannot run under `node`.
// The two things in it that are actually easy to get wrong are not I/O at all, so they live here
// as pure functions instead of being locked away behind a database.

/**
 * What kind of failure was that?
 *
 * Three outcomes that look identical to a user and need completely different responses. Getting
 * this wrong is how a dead sync spends a fortnight looking like a slow one.
 */
export function classifySyncError(err, online) {
  // fetch rejects with a TypeError when the network is simply gone. Nothing is wrong with us.
  if (!online || (err && err.name === "TypeError")) return { state: STATES.OFFLINE, reason: null };
  const status = Number(err && err.status) || 0;
  return {
    state: STATES.DEGRADED,
    // 4xx: the server is alive and refusing us — a wrong key, a missing function, a policy change.
    // 5xx or no answer: on the free tier, most likely a project paused for inactivity. Neither is
    // fixed by retrying, but the two need different words and different fixes.
    reason: status >= 400 && status < 500 ? "rejected" : "unreachable",
    status,
  };
}

/**
 * Work out what a page of pulled rows means for the local log.
 *
 * `known` maps uuid to the event we already hold. Three cases:
 *   new           store it
 *   ours, unstamped   restamp with the server's arrival time — see below
 *   already stamped   nothing to do
 *
 * The restamp is the subtle one. An event authored here is written with only a local timestamp;
 * every OTHER device receives it with the server's. Without stamping our own copy, the authoring
 * device orders it by its own clock while everyone else orders it by the server's, and the same
 * log derives different streaks on different phones — silently, and only for whoever wrote it.
 */
export function planMerge(rows, known) {
  const toAdd = [];
  const toRestamp = [];
  let maxSeq = 0;

  for (const r of rows) {
    if (typeof r.seq === "number") maxSeq = Math.max(maxSeq, r.seq);
    const serverTs = Date.parse(r.inserted_at) || 0;
    const seq = typeof r.seq === "number" ? r.seq : undefined;
    const existing = known.get(r.uuid);

    if (!existing) {
      toAdd.push({
        eventId: r.uuid,
        type: r.type,
        author: r.author,
        ts: Number(r.ts) || serverTs || 0,
        seq,
        serverTs: serverTs || undefined,
        payload: r.payload || {},
      });
    } else if (serverTs && !existing.serverTs) {
      toRestamp.push({ ...existing, seq: seq ?? existing.seq, serverTs });
    }
  }

  return { toAdd, toRestamp, maxSeq };
}

let adapter = null;
let groupCode = null;
let state = STATES.LOCAL_ONLY;
let breakerUntil = 0;
let degradedReason = null;       // "unreachable" | "rejected"
let backoff = BACKOFF_START;
let queuedCount = 0;
let flushing = false;

const listeners = new Set();
let onData = () => {};

export function onStatus(fn) {
  listeners.add(fn);
  fn(status());
  return () => listeners.delete(fn);
}
export function setOnData(fn) { onData = fn; }

export function status() {
  return {
    state,
    hasCloud: !!adapter && !!groupCode,
    queued: queuedCount,
    reason: state === STATES.DEGRADED ? degradedReason : null,
  };
}

function setState(s) {
  if (state === s) return;
  state = s;
  for (const fn of listeners) fn(status());
}

/** Point the engine at a cloud adapter and a room. Either being absent means local-only. */
export function configureCloud(a, code) {
  adapter = a || null;
  groupCode = code || null;
  if (!adapter || !groupCode) { setState(STATES.LOCAL_ONLY); return; }
  setState(navigator.onLine ? STATES.SYNCED : STATES.OFFLINE);
  flush();
}

function breakerTripped() { return Date.now() < breakerUntil; }

/**
 * `reason` separates two situations that both used to read as "paused":
 *   unreachable — 5xx or no answer. On the free tier the likeliest cause by far is the project
 *                 being PAUSED for inactivity, which needs a human to press Restore. No amount of
 *                 retrying fixes it.
 *   rejected    — 4xx. The server is alive and refusing us: bad key, missing RPC, a policy change.
 *                 Also unfixable by retrying, but the fix is completely different.
 * Saying "retrying…" for either is a small lie, and it is the lie that makes a dead sync look
 * like a slow one for weeks.
 */
function tripBreaker(reason) {
  degradedReason = reason || null;
  breakerUntil = Date.now() + backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX);
  setState(STATES.DEGRADED);
}
function resetBreaker() { backoff = BACKOFF_START; breakerUntil = 0; degradedReason = null; }

/**
 * Drain the queue to the cloud and pull back everything new. Safe to call at any time; it no-ops
 * when it cannot run, and it never throws.
 */
export async function flush() {
  if (flushing) return;

  const q = await db.queued();
  queuedCount = q.length;

  if (!adapter || !groupCode) { setState(STATES.LOCAL_ONLY); return; }
  if (typeof navigator !== "undefined" && !navigator.onLine) { setState(STATES.OFFLINE); return; }
  if (breakerTripped()) { setState(STATES.DEGRADED); return; }

  flushing = true;
  setState(STATES.SYNCING);
  try {
    // ---- PUSH: queued local events → the room (idempotent on uuid) ----
    if (q.length) {
      const rows = [];
      for (const { eventId } of q) {
        const e = await db.getEvent(eventId);
        if (!e) continue; // queued then removed — nothing to send
        rows.push({
          uuid: e.eventId,
          trip_code: groupCode,
          type: e.type,
          author: e.author || null,
          ts: e.ts,
          payload: e.payload || {},
        });
      }
      if (rows.length) await adapter.push(rows);
      // Clear the queue only AFTER the server has accepted, so a failed push retries rather than
      // silently dropping someone's day.
      for (const { eventId } of q) await db.dequeue(eventId);
      queuedCount = 0;
    }

    // ---- PULL: everything in the room newer than our cursor ----
    //
    // Paged, because pull_events returns at most 1000 rows. A device coming back after a long time
    // away would otherwise merge a thousand events, report itself SYNCED, and sit there a page
    // behind until the next poll — repeatedly, for as long as it took to catch up.
    const cursorKey = "cursor:" + groupCode;
    let since = await db.getMeta(cursorKey, 0);
    let merged = 0;
    let restamped = 0;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const incoming = await adapter.pull(groupCode, since);
      if (!incoming.length) break;

      const known = new Map();
      for (const r of incoming) {
        const existing = await db.getEvent(r.uuid);
        if (existing) known.set(r.uuid, existing);
      }

      const plan = planMerge(incoming, known);
      for (const e of plan.toAdd) { await db.addEvent(e); merged += 1; }
      for (const e of plan.toRestamp) { await db.addEvent(e); restamped += 1; }
      if (plan.maxSeq > since) {
        since = plan.maxSeq;
        await db.setMeta(cursorKey, since);
      }

      if (incoming.length < PAGE_SIZE) break; // a short page is the last one
    }

    resetBreaker();
    setState(STATES.SYNCED);

    // A restamp changes no CONTENT, so the derived cache (keyed on event count) would happily
    // serve stale state — but it can change ORDER, and order decides streaks. Drop it.
    if (restamped) invalidateDerived();
    if (merged || restamped) onData();
  } catch (err) {
    const online = typeof navigator === "undefined" || navigator.onLine;
    const verdict = classifySyncError(err, online);
    if (verdict.state === STATES.OFFLINE) {
      setState(STATES.OFFLINE);
    } else {
      console.warn("[sync] cloud " + verdict.reason
        + (verdict.status ? " (" + verdict.status + ")" : "") + ", degrading gracefully:", err);
      tripBreaker(verdict.reason);
    }
  } finally {
    flushing = false;
  }
}

/**
 * Triggers: reconnect, foreground, and a poll.
 *
 * The poll is the stand-in for Background Sync, which is unreliable on the web. Inside the Pause
 * WebView it is also not the main path — the native WorkManager job syncs on its own schedule and
 * keeps working when no window is open at all. This only has to cover the case where someone is
 * actually looking at the screen.
 */
export function startSyncTriggers() {
  window.addEventListener("online", () => { resetBreaker(); flush(); });
  window.addEventListener("offline", () => setState(STATES.OFFLINE));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") flush();
  }, POLL_MS);
}
