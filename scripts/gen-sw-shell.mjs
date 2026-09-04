// gen-sw-shell.mjs — generate the service worker's precache list from the ACTUAL module graph.
//
// A hand-maintained list drifts, and both directions hurt: a missing module breaks the app offline,
// a stale one wastes cache. Worse, both fail silently — the app works perfectly until the one time
// somebody opens it without signal.
//
//   node scripts/gen-sw-shell.mjs          # rewrite service-worker.js
//   node scripts/gen-sw-shell.mjs --check  # exit 1 if it is stale (CI)
//
// Ported from Passport, with one change: that project has an icons/ directory and a manifest and
// this one does not yet, so both are included only if they actually exist rather than being
// assumed. A generator that throws because an optional directory is missing is a generator people
// stop running.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (abs) => relative(root, abs).replace(/\\/g, "/");

// Entry module from index.html (<script type="module" src="./js/app.js">).
const html = readFileSync(resolve(root, "index.html"), "utf8");
const entry = (html.match(/<script[^>]+src="\.\/(js\/[^"]+\.js)"/) || [])[1] || "js/app.js";

// Breadth-first walk of the static import graph. Matches: from "./x" | import "./x" | import("./x")
const IMPORT_RE = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
const seen = new Set();
const queue = [entry];
while (queue.length) {
  const mod = queue.shift();
  if (seen.has(mod)) continue;
  seen.add(mod);
  let src;
  try { src = readFileSync(resolve(root, mod), "utf8"); } catch { continue; }
  let m;
  while ((m = IMPORT_RE.exec(src))) {
    let spec = m[1];
    if (!spec.startsWith(".")) continue;              // skip bare / URL imports
    spec = spec.split("?")[0].split("#")[0];          // drop ?query / #hash
    let target = rel(resolve(dirname(resolve(root, mod)), spec));
    if (!/\.[cm]?js$/.test(target)) target += ".js";
    if (!seen.has(target)) queue.push(target);
  }
}

const optional = (path) => (existsSync(resolve(root, path)) ? ["./" + path] : []);
const dir = (name, pattern) => (existsSync(resolve(root, name))
  ? readdirSync(resolve(root, name)).filter((f) => pattern.test(f)).sort().map((f) => `./${name}/${f}`)
  : []);

const jsFiles = [...seen].sort().map((p) => "./" + p);
const fonts = dir("fonts", /\.(ttf|woff2?)$/);
const icons = dir("icons", /\.(png|svg|ico)$/);

const assets = [
  "./",
  "./index.html",
  ...optional("manifest.json"),
  "./css/app.css",
  ...fonts,
  ...jsFiles,
  ...icons,
];

const block =
  "  // GEN:SHELL-START — generated from the module graph by scripts/gen-sw-shell.mjs (npm run build:sw)\n" +
  assets.map((a) => `  "${a}",`).join("\n") +
  "\n  // GEN:SHELL-END";

// The cache version, derived from what is actually IN the cache.
//
// A browser re-installs a service worker only when its bytes change, so a hand-typed version that
// nobody remembers to bump means the file never changes, the worker never re-installs, and phones
// serve the modules they cached on first run for as long as the app is installed. Every fix after
// that point ships to a server nobody is reading from. Hashing the contents makes the version move
// on its own, and --check makes forgetting impossible rather than merely unlikely.
const hash = createHash("sha256");
for (const asset of assets) {
  const path = asset === "./" ? "index.html" : asset.replace(/^\.\//, "");
  const abs = resolve(root, path);
  if (!existsSync(abs)) continue;
  hash.update(asset);
  hash.update("\u0000");
  hash.update(readFileSync(abs));
}
const version = "goalbuddy-" + hash.digest("hex").slice(0, 12);
const versionBlock =
  "// GEN:VERSION-START — content hash of SHELL, written by scripts/gen-sw-shell.mjs\n" +
  `const CACHE_VERSION = "${version}";\n` +
  "// GEN:VERSION-END";

const swPath = resolve(root, "service-worker.js");
const sw = readFileSync(swPath, "utf8");
const MARKERS = /[ \t]*\/\/ GEN:SHELL-START[\s\S]*?[ \t]*\/\/ GEN:SHELL-END/;
const VERSION_MARKERS = /\/\/ GEN:VERSION-START[\s\S]*?\/\/ GEN:VERSION-END/;
if (!MARKERS.test(sw)) {
  console.error("✗ GEN:SHELL markers not found in service-worker.js");
  process.exit(2);
}
if (!VERSION_MARKERS.test(sw)) {
  console.error("✗ GEN:VERSION markers not found in service-worker.js");
  process.exit(2);
}
// The list first, then the hash — the version covers the worker's own contents through the assets
// it names, and writing them in the other order would hash a file that is about to change.
const next = sw.replace(MARKERS, block).replace(VERSION_MARKERS, versionBlock);

if (process.argv.includes("--check")) {
  if (next !== sw) {
    console.error("✗ service-worker.js is stale — run `npm run build:sw` and commit.");
    console.error("  (the precache list, the cache version, or both)");
    process.exit(1);
  }
  console.log(`✓ SW up to date: ${jsFiles.length} modules, ${fonts.length} fonts, ${version}.`);
} else {
  writeFileSync(swPath, next);
  console.log(`✓ SW written: ${jsFiles.length} modules, ${fonts.length} fonts, ${version}.`);
}
