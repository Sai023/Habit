// dev-server.mjs — a static file server for local development.
//
// Node built-ins only, so `npm run dev` needs no install. ES modules must be served over http
// with correct MIME types (opening index.html from the filesystem fails on module CORS), which
// is the only reason this exists.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT) || 5174;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";

    // Contain every request inside the project directory: a dev server still should not serve
    // "../../.ssh" to anything on the machine that asks.
    const target = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    if (!target.startsWith(root)) { res.writeHead(403).end("Forbidden"); return; }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) { res.writeHead(404).end("Not found"); return; }

    res.writeHead(200, {
      "Content-Type": TYPES[extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store", // always see the edit you just made
    });
    res.end(await readFile(target));
  } catch (err) {
    res.writeHead(500).end(String(err && err.message ? err.message : err));
  }
}).listen(port, () => {
  console.log(`Habits dev server → http://localhost:${port}`);
  console.log(`Example data      → http://localhost:${port}/?demo=1`);
});
