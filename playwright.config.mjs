// playwright.config.mjs — config for the browser-level smoke suite (e2e/).
//
// Everything below `test/` is the pure engine, run with node:test and no browser at all. It has
// caught real bugs for years, but it structurally cannot reach the seam between that engine and
// the DOM — dom.js, app.js's click handlers, js/ui/*.js — which is exactly where a class of past
// bugs actually lived (see the "UI seam sweep" note in project history). This is a small, separate
// suite for that seam, not a replacement for the engine tests and not meant to grow into one.

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // "list" for readable local/CI logs; the html report only matters when something failed and
  // CI's job needs a real artifact to attach, so it's never opened automatically.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5174",
    trace: "retain-on-failure",
  },
  // Reuses a server you already have running locally (npm run dev); starts one fresh in CI.
  webServer: {
    command: "node scripts/dev-server.mjs",
    url: "http://localhost:5174",
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
