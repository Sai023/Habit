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

const swPath = resolve(root, "service-worker.js");
const sw = readFileSync(swPath, "utf8");
const MARKERS = /[ \t]*\/\/ GEN:SHELL-START[\s\S]*?[ \t]*\/\/ GEN:SHELL-END/;
if (!MARKERS.test(sw)) {
  console.error("✗ GEN:SHELL markers not found in service-worker.js");
  process.exit(2);
}
const next = sw.replace(MARKERS, block);

if (process.argv.includes("--check")) {
  if (next !== sw) {
    console.error("✗ service-worker.js precache list is stale — run `npm run build:sw` and commit.");
    process.exit(1);
  }
  console.log(`✓ SW precache list up to date (${jsFiles.length} modules, ${fonts.length} fonts).`);
} else {
  writeFileSync(swPath, next);
  console.log(`✓ SW precache list written: ${jsFiles.length} modules, ${fonts.length} fonts.`);
}
