// update.js — noticing that a new build exists, and picking it up.
//
// ---- The half of the job that was missing ----
//
// The service worker versions itself off a content hash of the shell, so a new build always
// produces new worker bytes, a new cache, and a fresh precache. That machinery is correct. It was
// also only ever half the job: it knew how to FETCH a new generation and had no way to make a page
// that was already running USE one.
//
// What that looks like on a phone. A deploy lands. The app is opened. The OLD worker is the one in
// control, so it serves the old index.html and the old modules out of its cache — instantly, with
// no network, exactly as designed. Meanwhile the browser byte-compares service-worker.js, finds it
// changed, installs the new one, and because install calls skipWaiting it activates immediately and
// drops the old cache. Nothing reloads the page. The person is now looking at yesterday's app being
// served by today's worker, and nothing they can do from inside the app changes that: switching
// tabs is a bridge message to a document that is already parsed, and the WebView is deliberately
// kept alive across app switches so there is one browsing context, one database and one sync loop.
//
// It only ever came right when the Activity was destroyed and rebuilt and loadUrl ran again — which
// is why it presented as "sometimes the update lands, sometimes you have to force-close it twice".
//
// Two consequences of that gap were patched before the gap itself was. sheet.js reads the shell
// viewport off a global instead of importing it, and app.js reloads the page when a dynamic import
// fails with a skew error. Both exist because an old page can dynamic-import a NEW module across
// exactly this window. Reloading promptly is what closes the window; those two stay as the floor
// under the moments before the reload gets there.

import { onAppResume } from "./bridge.js";

/** How often a foreground is allowed to ask the network whether a new worker exists. */
const CHECK_GAP_MS = 60_000;

/**
 * Floor under two automatic reloads.
 *
 * A reload loop on a phone is not a degraded app, it is an app that cannot be opened at all, and
 * there would be no console to find out why. Session-scoped and time-based rather than once-ever:
 * a WebView here can stay alive for days across several deploys, and "one reload per session" would
 * quietly stop delivering updates after the first.
 */
const RELOAD_GAP_MS = 30_000;
const RELOAD_KEY = "last-update-reload";

let registration = null;
let lastCheck = 0;
let reloading = false;
let pending = false;

export function watchForUpdates() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  // A page with no controller is the first run on this device. The worker registering now is not an
  // update to anything, and the controllerchange it fires when it claims the page must not be read
  // as one — reloading there would cost a pointless round trip on every first launch.
  const hadController = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) armReload();
  });

  // Deferred to load, so registering never competes for bandwidth with the first paint.
  if (document.readyState === "complete") registerNow();
  else addEventListener("load", registerNow, { once: true });

  // Coming back to the app is the moment worth checking on: it is when somebody is about to read
  // the thing, and it is the only point at which a reload is both useful and cheap.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onForeground();
  });

  // The shell's own resume signal. See HabitWebHost.kt: the Activity's lifecycle is the dependable
  // one here, and the visibilitychange above is the standalone-browser equivalent. Registered
  // rather than assigned, because the day's numbers want this event too.
  onAppResume(onForeground);
}

function registerNow() {
  // updateViaCache "none" keeps the worker script and its imports out of the HTTP cache, so the
  // byte-comparison that decides whether an update exists is made against the server's copy rather
  // than against something a proxy is holding.
  navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" })
    .then((reg) => {
      registration = reg;
      checkNow();
    })
    // Non-fatal on purpose: a registration that fails must never stop the app loading. It runs
    // online-only, which is worse than the alternative and far better than a blank screen.
    .catch(() => {});
}

function onForeground() {
  checkNow();
  // A reload that was held back because a sheet was open gets its chance here.
  if (pending) armReload();
}

/** Whether enough time has passed since [lastCheckAt] to ask the network again. */
export function checkDue(lastCheckAt, now) {
  return !(lastCheckAt > 0) || now - lastCheckAt >= CHECK_GAP_MS;
}

function checkNow() {
  const now = Date.now();
  if (!registration || !checkDue(lastCheck, now)) return;
  lastCheck = now;
  // Offline, or a registration that has gone away. Neither is worth surfacing: the next foreground
  // asks again, and until then the cached app is entirely usable.
  registration.update().catch(() => {});
}

function armReload() {
  if (reloading) return;
  if (!safeToReload()) { pending = true; return; }
  if (!reloadAllowed()) return;
  reloading = true;
  location.reload();
}

/**
 * Do not pull the page out from under somebody mid-sentence.
 *
 * A sheet on screen means the app is holding a number that has been typed and not yet saved, and
 * losing it to a background update would be a worse bug than the staleness this fixes. The reload
 * waits for the next time the app is opened, which is at most one app switch away.
 */
export function holdsInput(sheetOpen, activeTag) {
  if (sheetOpen) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(String(activeTag || ""));
}

function safeToReload() {
  const active = document.activeElement;
  return !holdsInput(Boolean(document.querySelector(".sheet-layer")), active && active.tagName);
}

/** Whether an automatic reload is far enough from the last one to not be a loop. */
export function reloadDue(lastReloadAt, now) {
  if (!Number.isFinite(lastReloadAt) || lastReloadAt <= 0) return true;
  return now - lastReloadAt >= RELOAD_GAP_MS;
}

function reloadAllowed() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (!reloadDue(last, Date.now())) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    // No session storage means no way to stop a loop, so never start one.
    return false;
  }
}
