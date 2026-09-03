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
    const cursorKey = "cursor:" + groupCode;
    const since = await db.getMeta(cursorKey, 0);
    const incoming = await adapter.pull(groupCode, since);

    let maxSeq = since;
    let merged = 0;
    let restamped = 0;

    for (const r of incoming) {
      if (typeof r.seq === "number") maxSeq = Math.max(maxSeq, r.seq);
      const serverTs = Date.parse(r.inserted_at) || 0;
      const seq = typeof r.seq === "number" ? r.seq : undefined;
      const existing = await db.getEvent(r.uuid);

      if (!existing) {
        await db.addEvent({
          eventId: r.uuid,
          type: r.type,
          author: r.author,
          ts: Number(r.ts) || serverTs || Date.now(),
          seq,
          serverTs: serverTs || undefined,
          payload: r.payload || {},
        });
        merged += 1;
      } else if (serverTs && !existing.serverTs) {
        // One of OUR OWN events coming back. Stamping it matters: without it, the device that
        // authored an event orders it by its own (possibly wrong) clock while every other device
        // orders it by the server's — and the same log then derives different streaks on
        // different phones. Cheap, and it happens only once per event.
        await db.addEvent({ ...existing, seq: seq ?? existing.seq, serverTs });
        restamped += 1;
      }
    }

    if (maxSeq !== since) await db.setMeta(cursorKey, maxSeq);

    resetBreaker();
    setState(STATES.SYNCED);

    // A restamp changes no CONTENT, so the derived cache (keyed on event count) would happily
    // serve stale state — but it can change ORDER, and order decides streaks. Drop it.
    if (restamped) invalidateDerived();
    if (merged || restamped) onData();
  } catch (err) {
    if ((typeof navigator !== "undefined" && !navigator.onLine) || err.name === "TypeError") {
      setState(STATES.OFFLINE);
    } else {
      const code = Number(err && err.status) || 0;
      const reason = code >= 400 && code < 500 ? "rejected" : "unreachable";
      console.warn("[sync] cloud " + reason + (code ? " (" + code + ")" : "") + ", degrading gracefully:", err);
      tripBreaker(reason);
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
