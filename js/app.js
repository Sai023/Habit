// app.js — bootstrap. Decides what state the dashboard is looking at, and keeps it fresh.
//
// Two modes, and only two:
//   ?demo=1  a generated three weeks, replayed through the real engine. Nothing is stored.
//   default  the device's own log, from IndexedDB, mirrored to the group's room when configured.
//
// The demo path deliberately never touches IndexedDB. Looking at example data should not leave
// anything behind on the device, and a review session should not be able to corrupt real history.

import { renderApp } from "./ui/dashboard.js";
import { demoState } from "./ui/demo.js";
import { dayKey } from "./habits.js";
import { HABIT_DEFAULTS } from "./schema.js";
import { installBridge, caps } from "./bridge.js";

const root = document.getElementById("app");
const params = new URLSearchParams(location.search);
const isDemo = params.get("demo") === "1";

const ui = {
  tab: params.get("tab") || "today",
  sync: { state: "LOCAL_ONLY", queued: 0 },
};

let ctx = null;

function todayKey(state) {
  const first = [...state.habits.values()][0];
  const tz = first?.tz || HABIT_DEFAULTS.tz;
  const startHour = first?.dayStartHour ?? HABIT_DEFAULTS.dayStartHour;
  return dayKey(Date.now(), tz, startHour);
}

function paint() {
  if (!ctx) return;
  renderApp(root, { ...ctx, ...ui, now: Date.now(), onTab, onUrge, onStart, onFixSync });
}

function onTab(tab) {
  ui.tab = tab;
  const url = new URL(location.href);
  url.searchParams.set("tab", tab);
  history.replaceState(null, "", url); // survives a reload without adding history entries
  paint();
}

/**
 * The urge button. In the shell this hands off to Pause's breathing screen, which is native for a
 * reason: it has to appear instantly, possibly over another app, and a WebView cold start is far
 * too slow for the moment somebody is reaching for a vape.
 *
 * In a browser there is nothing to hand off to, so it logs directly — enough to develop against.
 */
async function onUrge(habit) {
  if (caps().native) {
    const { notify } = await import("./bridge.js");
    notify({ title: "Pause", body: "Take a breath.", actions: ["Resisted", "Vaped anyway"] });
    return;
  }
  if (isDemo) return;
  const { logDiscrete } = await import("./store.js");
  await logDiscrete(habit.habitId, ctx.today, 1);
  await refresh();
}

async function onStart() {
  // The join/create flow is the next screen to build; until then say so plainly rather than
  // wiring a button to nothing.
  alert("Group setup is the next screen. For now, add ?demo=1 to look at the dashboard.");
}

function onFixSync(row) {
  alert(`${row.name}'s watch hasn't reported this week.\n\nOn their phone: open Health Connect, check Pause has permission, and make sure battery optimisation isn't sleeping it.`);
}

async function refresh() {
  const { getState, identity } = await import("./store.js");
  const { db } = await import("./db.js");
  const state = await getState();
  const { memberId } = await identity();
  ctx = { state, events: await db.allEvents(), me: memberId, today: todayKey(state), demo: false };
  paint();
}

async function boot() {
  installBridge({ onData: () => { if (!isDemo) refresh(); } });

  if (isDemo) {
    const demo = demoState();
    ctx = { ...demo, demo: true };
    ui.sync = { state: "LOCAL_ONLY", queued: 0 };
    paint();
    return;
  }

  await refresh();

  // Sync is opt-in configuration: with config.js left blank the app is fully usable and simply
  // never talks to anything.
  const { cloudConfigured } = await import("./config.js");
  if (!cloudConfigured()) return;

  const [{ makeSupabaseAdapter }, sync, { currentCode }] = await Promise.all([
    import("./sync-adapter.js"), import("./sync.js"), import("./store.js"),
  ]);
  sync.onStatus((s) => { ui.sync = s; paint(); });
  sync.setOnData(refresh);
  sync.configureCloud(makeSupabaseAdapter(), await currentCode());
  sync.startSyncTriggers();
}

boot().catch((err) => {
  console.error("[app] boot failed:", err);
  root.textContent = "Something went wrong starting up. Reload to try again.";
});
