// smoke.spec.mjs — does the real engine's output actually reach the screen.
//
// Runs against ?demo=1: a real event log through the real engine (see js/ui/demo.js), never
// IndexedDB, and every write refused with a banner rather than silently doing nothing. That refusal
// is itself something to test — it is a real code path (demoBlocked() in app.js) that a click has
// to actually reach through dom.js's rendering and app.js's event wiring, which is exactly the seam
// the 55 engine-only test files in test/ cannot see.

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (err) => { throw new Error(`Uncaught page error: ${err.message}`); });
});

test("demo boots, renders real engine output, and throws no console errors", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });

  await page.goto("/?demo=1");

  await expect(page).toHaveTitle(/Goal Buddy/);
  // Names baked into demo.js's fixture (js/ui/demo.js) — real replay() output, not markup.
  await expect(page.getByText("Steps", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Vape puffs", { exact: true }).first()).toBeVisible();

  expect(errors, `console errors on load:\n${errors.join("\n")}`).toEqual([]);
});

test("tab navigation switches between Today and Board", async ({ page }) => {
  await page.goto("/?demo=1");

  const todayTab = page.getByRole("button", { name: /Today/ });
  const boardTab = page.getByRole("button", { name: /Board/ });

  await expect(todayTab).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".board-tabs")).toHaveCount(0);

  await boardTab.click();
  await expect(boardTab).toHaveAttribute("aria-current", "page");
  // "This week" / "All time" / "Awards" chips only exist on Board.
  await expect(page.locator(".board-tabs")).toBeVisible();

  await todayTab.click();
  await expect(todayTab).toHaveAttribute("aria-current", "page");
});

test("logging a habit in demo mode is refused with a clear message, not silently", async ({ page }) => {
  await page.goto("/?demo=1");

  // Steps is SOURCE.MANUAL in the demo fixture, so it has a "＋ Log" button (sensor-fed habits,
  // like Sleep, deliberately don't — see dashboard.js's comment on why).
  await page.locator("button.logbtn").first().click();

  const banner = page.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("This is example data");
});
