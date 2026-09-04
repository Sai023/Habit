// service-worker.js — the offline shell.
//
// This exists because of where the app ends up living. Embedded as a tab inside Pause, a screen
// that needs a network round trip to render at all is a visible seam: every other tab in that app
// works on a plane, and this one would show a blank page. Standalone in a browser it matters less,
// but a habit tracker you cannot open on the underground is a habit tracker people stop opening.
//
// Strategy:
//   • App shell (HTML/CSS/JS/font): cache-first, so it opens instantly with no connection.
//   • Everything else same-origin: cache-first, filled in as it is fetched.
//   • Supabase: never cached. Sync is POSTs, which are skipped anyway, but the origin is excluded
//     outright so a future GET against it can never be served stale — a stale event log would
//     silently show the wrong streaks.
//
// ---- Why the version is generated and not typed ----
//
// It used to be a constant with a comment above it asking whoever changed an asset to remember to
// bump it. Nobody ever did, and the failure is silent in the worst possible way: a browser only
// re-installs a service worker whose BYTES have changed, so an unchanged version string meant an
// unchanged file meant no re-install — and a phone kept serving the modules it cached the first
// time it ever opened the app. Every fix shipped after that point simply never arrived, and the
// app carried on looking fine while being weeks out of date.
//
// So it is derived from the contents of everything in SHELL, by the same generator that writes
// SHELL, and `--check` fails the build if either has drifted. Change any shell file and the
// version moves on its own.

// GEN:VERSION-START — content hash of SHELL, written by scripts/gen-sw-shell.mjs
const CACHE_VERSION = "goalbuddy-b1b462635885";
// GEN:VERSION-END

const SHELL = [
  // GEN:SHELL-START — generated from the module graph by scripts/gen-sw-shell.mjs (npm run build:sw)
  "./",
  "./index.html",
  "./css/app.css",
  "./fonts/manrope.ttf",
  "./js/app.js",
  "./js/bridge.js",
  "./js/config.js",
  "./js/db.js",
  "./js/dom.js",
  "./js/habits.js",
  "./js/id.js",
  "./js/ingest.js",
  "./js/schema.js",
  "./js/setup-code.js",
  "./js/store.js",
  "./js/summary.js",
  "./js/sync-adapter.js",
  "./js/sync.js",
  "./js/ui/dashboard.js",
  "./js/ui/demo.js",
  "./js/ui/editor.js",
  "./js/ui/format.js",
  "./js/ui/goals.js",
  "./js/ui/habitsheet.js",
  "./js/ui/logsheet.js",
  "./js/ui/onboard.js",
  "./js/ui/sheet.js",
  // GEN:SHELL-END
];

self.addEventListener("install", (event) => {
  // Resilient precache: one bad or renamed asset must NOT reject the whole install, which would
  // leave a freshly installed app with no working shell at all. allSettled caches what it can and
  // the rest falls back to runtime caching.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // every Supabase call is a POST; let them all through

  const url = new URL(req.url);

  // Never serve the event log from cache. A stale read here would not look like an error — it
  // would look like someone's streak quietly being wrong.
  if (url.hostname.endsWith(".supabase.co")) return;

  // Navigation: cache-first, so launching offline opens the app rather than an error page. A newer
  // build arrives through the service worker update rather than through this fetch — which is only
  // true because the version above changes whenever the assets do. It was not true before, and
  // this comment was the claim that made it easy to miss.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html")
        .then((cached) => cached || fetch(req).catch(() => caches.match("./index.html"))),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached)),
    );
  }
});
