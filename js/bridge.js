// bridge.js — the web half of the HabitBridge contract with the Pause shell.
//
// Pause hosts this app in a WebView and injects a `PauseNative` object; this module installs the
// handlers Pause calls back into, and wraps the calls that go the other way. In a plain browser
// none of that exists, so every native call degrades to a no-op and the app stays fully usable —
// which is what makes the whole UI developable and testable in Chrome, with no APK in the loop.
//
// ---- The one rule ----
//
// Native emits OBSERVATIONS, never verdicts. It says "steps were 8412 at 14:20"; it never says
// "streak is 12" or "goal met". Every derived number comes from habits.js, on this side, from the
// shared log. That is what stops the Kotlin and the JavaScript drifting into two answers for the
// same question — and it means a new habit type usually needs no native change at all.
//
// Keep this surface small. Its size is what decides how often three phones need a signed release.

import { ingestSamples, logDiscrete, getState } from "./store.js";
import { todayFor } from "./ingest.js";

export const BRIDGE_VERSION = 1;

let capabilities = { version: 0, healthConnect: false, alarms: false, tile: false, native: false };
let onChange = () => {};

/** What the shell can actually do. Screens use this to hide controls that would do nothing. */
export function caps() {
  return { ...capabilities };
}
export function isNative() {
  return capabilities.native;
}

function nativeObj() {
  return typeof window !== "undefined" ? window.PauseNative : undefined;
}

/**
 * Install the handlers Pause calls. Safe to call in any browser — without a shell, nothing ever
 * invokes them.
 *
 * Everything crossing the bridge is a JSON string: Android's addJavascriptInterface can only pass
 * primitives, and a string that we parse here is both simpler and easier to version than a
 * hand-marshalled object.
 */
export function installBridge({ onData } = {}) {
  if (typeof window === "undefined") return;
  onChange = onData || (() => {});

  window.HabitBridge = {
    /** Sent once, as soon as the WebView is live. Tells us what this build of Pause supports. */
    onBridgeReady(json) {
      const info = safeParse(json) || {};
      capabilities = {
        version: Number(info.version) || 0,
        healthConnect: !!info.healthConnect,
        alarms: !!info.alarms,
        tile: !!info.tile,
        native: true,
      };
      onChange();
    },

    /** A batch of readings: { source, samples: [{ metric, start, end, value, externalId }] }. */
    onSensorData(json) {
      const batch = safeParse(json);
      if (!batch) return;
      ingestSamples(batch).then((written) => { if (written.length) onChange(); })
        .catch((e) => console.warn("[bridge] ingest failed:", e));
    },

    /**
     * Something discrete happened in the shell — usually the breathe screen resolving into
     * "resisted" or "gave in". `outcome` decides the value, so the native side never has to know
     * what the habit's target is.
     */
    onLocalEvent(json) {
      const e = safeParse(json);
      if (!e || !e.habitId) return;
      (async () => {
        const state = await getState();
        const habit = state.habits.get(e.habitId);
        if (!habit) return;
        const day = e.day || todayFor(habit, e.ts || Date.now());
        const amount = e.outcome === "resisted" ? 0 : 1;
        await logDiscrete(e.habitId, day, e.amount != null ? e.amount : amount, e.source || "pause");
        onChange();
      })().catch((err) => console.warn("[bridge] local event failed:", err));
    },
  };

  // A shell that was already up before this script parsed needs a nudge to re-announce itself.
  const n = nativeObj();
  if (n && typeof n.requestReady === "function") { try { n.requestReady(); } catch { /* ignore */ } }
}

// ---- Web → Native ----------------------------------------------------------
// Each of these is a no-op without a shell. They return false so a caller can tell the difference
// between "done" and "there was nobody to ask", and show the browser fallback instead.

function call(name, payload) {
  const n = nativeObj();
  if (!n || typeof n[name] !== "function") return false;
  try {
    n[name](typeof payload === "string" ? payload : JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn("[bridge] " + name + " failed:", e);
    return false;
  }
}

/**
 * Ask the shell to fire a local notification at a wall-clock time.
 *
 * This is the whole reason the shell exists for notifications: the web has no scheduled-
 * notification API at all (Notification Triggers never shipped), a service worker is killed long
 * before a timer fires, and periodicSync is measured in hours. AlarmManager is exact and works
 * with nothing running.
 */
export function scheduleAlarm(id, epochMs, payload = {}) {
  return call("scheduleAlarm", { id, at: epochMs, payload });
}
export function cancelAlarm(id) {
  return call("cancelAlarm", { id });
}

/** Ask for OS permissions. The shell drives the real dialogs; we only ask it to start. */
export function requestPermissions(list) {
  return call("requestPermissions", { permissions: list });
}

/** Show a notification now, with optional action buttons ("+1", "Resisted"). */
export function notify({ title, body, actions = [] }) {
  return call("notify", { title, body, actions });
}

function safeParse(json) {
  if (json && typeof json === "object") return json;
  try { return JSON.parse(json); } catch { return null; }
}
