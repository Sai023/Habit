// app.js — bootstrap. Decides what the screen is looking at, and keeps it fresh.
//
// Three states, and only three:
//   ?demo=1     a generated three weeks, replayed through the real engine. Nothing is stored.
//   no group    onboarding: start a group, or join one.
//   otherwise   the device's own log, mirrored to the group's room.
//
// The demo path deliberately never touches IndexedDB. Looking at example data should not leave
// anything behind, and a review session should not be able to corrupt real history.

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
let syncStarted = false;
// While onboarding is on screen it OWNS the root. Creating a group pushes events, the first pull
// merges them straight back, and the resulting "new data" callback would otherwise re-render the
// dashboard over the top of the share screen — losing the group code and setup code the user was
// meant to copy, in the second between them appearing and being read.
let onboarding = false;
// A joiner has nothing to bind to until the room's habits actually arrive, so the binding waits
// for the first successful pull rather than happening at join time.
let bindOnNextSync = false;

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
  history.replaceState(null, "", url); // survives a reload without stacking history entries
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
  ctx = null;
  await showOnboard();
}

function onFixSync(row) {
  alert(`${row.name}'s watch hasn't reported this week.\n\nOn their phone: open Health Connect, check Pause has permission, and make sure battery optimisation isn't sleeping it.`);
}

async function refresh() {
  const { getState, identity } = await import("./store.js");
  const { db } = await import("./db.js");
  const { memberId, code } = await identity();
  if (!code) { await showOnboard(); return; }
  if (onboarding) return; // the share screen is still being read; do not paint over it

  const state = await getState();
  ctx = { state, events: await db.allEvents(), me: memberId, today: todayKey(state), demo: false };
  paint();
}

async function showOnboard() {
  const { renderOnboard } = await import("./ui/onboard.js");
  onboarding = true;
  renderOnboard(root, {
    onComplete: async (opts = {}) => {
      if (opts.bindAfterSync) bindOnNextSync = true;
      // Sync starts while the share screen is still up, so the group exists on the server by the
      // time anyone acts on the code — but the screen stays put until they say they are done.
      await startSync();
      if (opts.done) { onboarding = false; await refresh(); }
    },
  });
}

/** Wire up the cloud once. Safe to call again — re-pointing at a room is all that repeats. */
async function startSync() {
  const { cloudConfigured } = await import("./config.js");
  if (!cloudConfigured()) return;

  const [{ makeSupabaseAdapter }, sync, store] = await Promise.all([
    import("./sync-adapter.js"), import("./sync.js"), import("./store.js"),
  ]);

  if (!syncStarted) {
    sync.onStatus((s) => { ui.sync = s; paint(); });
    sync.setOnData(async () => {
      if (bindOnNextSync) {
        bindOnNextSync = false;
        await store.ensureBindings(); // now the room's habits are here, declare how I feed them
      }
      await refresh();
    });
    sync.startSyncTriggers();
    syncStarted = true;
  }
  sync.configureCloud(makeSupabaseAdapter(), await store.currentCode());
}

async function boot() {
  installBridge({ onData: () => { if (!isDemo) refresh(); } });

  if (isDemo) {
    ctx = { ...demoState(), demo: true };
    ui.sync = { state: "LOCAL_ONLY", queued: 0 };
    paint();
    return;
  }

  await refresh();
  await startSync();
}

boot().catch((err) => {
  console.error("[app] boot failed:", err);
  root.textContent = "Something went wrong starting up. Reload to try again.";
});
