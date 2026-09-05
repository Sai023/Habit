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

let capabilities = {
  version: 0, healthConnect: false, alarms: false, tile: false, native: false,
  // Whether openFocus() goes anywhere. False on a shell where Focus is still a tab of its
  // own, so the control is simply not drawn rather than drawn and inert.
  focusSettings: false,
  // Hosted as a native tab rather than opened in a browser. Drives one thing only: the app stops
  // drawing its own bottom bar, because the shell is already drawing one.
  embedded: false,
};
let onChange = () => {};
let onReady = () => {};
let onNavigate = () => {};

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
/**
 * How tall the shell says the page really is, in CSS pixels, or 0 if it has not said.
 *
 * Kept here rather than measured, because measuring is what fails. A WebView laid out at the wrong
 * size reports that wrong size through every API the page has — innerHeight, visualViewport,
 * documentElement all agree with one another and all of them are wrong. The shell is the only
 * thing that knows both the size it gave the view and the size the view took.
 */
let shellViewport = 0;
export function shellViewportHeight() {
  return shellViewport;
}

export function installBridge({ onData, onReady: ready, onNavigate: navigate } = {}) {
  if (typeof window === "undefined") return;
  onChange = onData || (() => {});
  onReady = ready || (() => {});
  onNavigate = navigate || (() => {});

  window.HabitBridge = {
    /**
     * Sent once, as soon as the WebView is live. Tells us what this build of Pause supports — and,
     * when the shell has already been set up, hands over the identity it is using.
     *
     * That handover is the important part. A WebView is a brand-new browsing context with its own
     * empty database, so without it, opening this inside Pause for the first time would run the
     * device through onboarding again and mint a SECOND member id for a person the shell has
     * already been posting as. That is the two-of-you-on-the-leaderboard bug the setup code was
     * built to prevent, arrived at from the opposite direction.
     */
    onBridgeReady(json) {
      const info = safeParse(json) || {};
      capabilities = {
        version: Number(info.version) || 0,
        healthConnect: !!info.healthConnect,
        alarms: !!info.alarms,
        tile: !!info.tile,
        embedded: !!info.embedded,
        // Every field the shell announces has to be read out HERE. This object is rebuilt whole on
        // each announcement rather than merged, so a capability the shell sends and this line does
        // not name is silently dropped and reads as false forever — which is indistinguishable
        // from a shell too old to have the feature, and therefore invisible.
        focusSettings: !!info.focusSettings,
        native: true,
      };
      onReady(info.setup || null);
      onChange();
    },

    /**
     * The shell's tab bar was tapped. Embedded, Today and Board are native destinations, so
     * navigation arrives from outside rather than from a bar this app drew.
     */
    onNavigate(json) {
      const to = safeParse(json) || {};
      if (to.tab) onNavigate(to.tab);
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
  // The shell calls this on every layout change. A CSS variable as well as a value, so styling
  // can use it without every component having to ask.
  window.onShellViewport = (height) => {
    const h = Number(height) || 0;
    if (h <= 0) return;
    shellViewport = h;
    // Published on the window as well as held here, and that is not belt-and-braces — it is what
    // lets a lazily-loaded module read it WITHOUT importing this one. A dynamic import can be
    // served from a different service-worker generation than the page that requests it, so a
    // static import across that boundary is a hard module error rather than a missing feature.
    // A global is absent on an old build; an export that does not exist takes the screen down.
    window.__shellViewport = h;
    document.documentElement.style.setProperty("--shell-vh", h + "px");
  };

  if (n && typeof n.requestReady === "function") { try { n.requestReady(); } catch { /* ignore */ } }
}

// ---- Web → Native ----------------------------------------------------------
// Each of these is a no-op without a shell. They return false so a caller can tell the difference
// between "done" and "there was nobody to ask", and show the browser fallback instead.

/**
 * Call into the shell, tolerating either arity.
 *
 * Android's addJavascriptInterface throws when the argument count does not match the Kotlin
 * method, and it throws in a way nothing notices: the caller is usually an async click handler, so
 * the rejection is swallowed and the button simply does nothing. That is exactly what happened to
 * the settings button — `openSettings()` takes no parameter in Kotlin, every other method takes a
 * JSON string, and this sent one to all of them.
 *
 * The retry is not defensive padding. The two halves of this bridge ship on completely different
 * cycles: the web app deploys in a minute and the shell needs a signed APK on three phones, so
 * they are ALWAYS temporarily out of step with each other, in both directions. A call that works
 * against either arity is the difference between that being a non-event and being a dead button
 * for however long the APK takes.
 */
function call(name, payload) {
  const n = nativeObj();
  if (!n || typeof n[name] !== "function") return false;
  const json = typeof payload === "string" ? payload : JSON.stringify(payload);
  try {
    n[name](json);
    return true;
  } catch (withArg) {
    try {
      n[name]();
      return true;
    } catch (bare) {
      console.warn("[bridge] " + name + " failed with and without a payload:", withArg, bare);
      return false;
    }
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

/**
 * Hand the shell what its background job needs to sync without a WebView: the room, who this
 * device is, where to push, and just enough of each habit to work out which day a reading belongs
 * to. Deliberately no targets and no streak rules — the shell reports what it saw and never
 * decides whether a day was a success, so the two sides cannot disagree about it.
 *
 * Sending it from here rather than compiling it into the APK means pointing the group at a
 * different Supabase project never needs a signed release on three phones.
 */
export function setSyncConfig({ groupCode, memberId, supabaseUrl, supabaseKey, habits }) {
  return call("setSyncConfig", {
    groupCode, memberId, supabaseUrl, supabaseKey,
    habits: (habits || []).map((h) => ({
      habitId: h.habitId, metric: h.metric, tz: h.tz, dayStartHour: h.dayStartHour,
      // The schedule travels with the habit so the shell can raise the alarm on the right days
      // without holding a second opinion about which days those are.
      name: h.name || "", days: h.days || [], remindAt: h.remindAt ?? null,
    })),
  });
}

/**
 * Hand the shell the day's answers, already worked out.
 *
 * The shell caches this and draws its own Home and Insights from it, so those screens can show
 * every habit rather than only the screen-time ones Pause measures itself — without Kotlin ever
 * deciding what a hit is. Verdicts come from habits.js or they come from two places.
 */
export function setSummary(summary) {
  return call("setSummary", summary);
}

/**
 * Ask the shell to open its habit settings.
 *
 * Only meaningful embedded, where settings is a sheet rather than a tab. In a browser there is
 * nobody to ask and this reports false, which is why the control is only drawn when embedded.
 */
export function openSettings() {
  return call("openSettings", {});
}

/**
 * Open the screen-time controls: which apps get slowed, the goal, and the limits.
 *
 * Gated on caps().focusSettings rather than on being embedded. Those controls were a tab in every
 * shell up to this one, and a shell that still has the tab has no sheet to open — so an older
 * phone that picks up this build must not be offered a button that does nothing.
 */
export function openFocus() {
  return call("openFocus", {});
}

/** Show a notification now, with optional action buttons ("+1", "Resisted"). */
export function notify({ title, body, actions = [] }) {
  return call("notify", { title, body, actions });
}

function safeParse(json) {
  if (json && typeof json === "object") return json;
  try { return JSON.parse(json); } catch { return null; }
}
