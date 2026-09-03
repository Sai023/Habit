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
let pendingGoals = false;

function todayKey(state) {
  const first = [...state.habits.values()][0];
  const tz = first?.tz || HABIT_DEFAULTS.tz;
  const startHour = first?.dayStartHour ?? HABIT_DEFAULTS.dayStartHour;
  return dayKey(Date.now(), tz, startHour);
}

function paint() {
  if (!ctx || onboarding) return;
  if (ui.editing !== undefined) { paintEditor(); return; }
  renderApp(root, {
    ...ctx, ...ui, now: Date.now(), embedded: caps().embedded,
    onTab, onUrge, onStart, onFixSync, onEditHabit, onEditGoals, onLog, onOpenSettings,
  });
}

/**
 * In the demo, every write is refused — and says so.
 *
 * Not silently: a button that does nothing reads as broken. And it cannot simply fall through to
 * the real store either, because the demo's state is generated rather than stored, so saving would
 * write against a group this browser has not joined and then bounce the reader out to onboarding.
 */
function demoBlocked() {
  if (!isDemo) return false;
  alert("This is example data. Start or join a real group to change anything.");
  return true;
}

/** Hand off to the shell's settings sheet. Only drawn when embedded, so only reachable there. */
async function onOpenSettings() {
  const { openSettings } = await import("./bridge.js");
  openSettings();
}

/** Type a number in — the only way half these habits ever get a value. */
async function onLog(habit) {
  if (demoBlocked()) return;
  const { openLogSheet } = await import("./ui/logsheet.js");
  // Mounted on <body>, not on the app root. A sync landing mid-entry repaints the root, and
  // anything living inside it would vanish with the number half typed.
  openLogSheet(document.body, {
    state: ctx.state, habit, me: ctx.me, today: ctx.today,
    onSaved: () => refresh(),
  });
}

/**
 * "Which of these are you in for, and what's your number?"
 *
 * Shown once after joining, and on demand afterwards. If the room's habits have not landed yet the
 * dashboard's own empty state offers the same thing, so a slow first pull is not a dead end.
 */
async function showGoals(firstRun = false) {
  const [{ getState, identity }, { renderGoals }] = await Promise.all([
    import("./store.js"), import("./ui/goals.js"),
  ]);
  const state = await getState();
  if (!state.habits.size) { onboarding = false; await refresh(); return; }
  const { memberId } = await identity();
  onboarding = true; // this flow owns the root, same as onboarding does
  renderGoals(root, {
    state, me: memberId, firstRun,
    onDone: async () => { onboarding = false; await refresh(); },
  });
}

function onEditGoals() {
  if (demoBlocked()) return;
  showGoals(false);
}

/** The editor owns the root while it is open, the same way onboarding does. */
async function paintEditor() {
  const { renderEditor } = await import("./ui/editor.js");
  renderEditor(root, {
    state: ctx.state,
    habitId: ui.editing,
    onDone: async () => {
      ui.editing = undefined;
      await refresh(); // a saved habit changes the log, so re-derive rather than repaint
    },
  });
}

function onEditHabit(habitId) {
  if (demoBlocked()) return;
  ui.editing = habitId || null; // null means "new"; undefined means "not editing"
  paintEditor();
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
      if (opts.bindAfterSync) { bindOnNextSync = true; pendingGoals = true; }
      // Sync starts while the share screen is still up, so the group exists on the server by the
      // time anyone acts on the code — but the screen stays put until they say they are done.
      await startSync();
      if (!opts.done) return;
      onboarding = false;
      // A joiner picks their habits and targets next. By the time they have read the two codes the
      // first pull has almost always landed, so the list is there to choose from.
      if (pendingGoals) { pendingGoals = false; await showGoals(true); return; }
      await refresh();
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

/** Embedded, the shell draws the tab bar, so this app must stop drawing its own. */
function applyEmbedded() {
  if (caps().embedded) document.body.classList.add("embedded");
}

async function boot() {
  let handover = null;
  let announce;
  const announced = new Promise((resolve) => { announce = resolve; });

  installBridge({
    onData: () => { if (!isDemo) refresh(); },
    onReady: (setup) => { handover = setup; applyEmbedded(); announce(); },
    onNavigate: (tab) => { ui.tab = tab; paint(); },
  });

  if (isDemo) {
    ctx = { ...demoState(), demo: true };
    ui.sync = { state: "LOCAL_ONLY", queued: 0 };
    paint();
    return;
  }

  // Give the shell a moment to announce itself before deciding whether this device needs
  // onboarding — it may be about to hand over an identity that makes that question moot. In a
  // plain browser nothing ever answers, so the wait is capped rather than open-ended.
  await Promise.race([announced, new Promise((resolve) => setTimeout(resolve, 400))]);
  if (handover) {
    const { adoptIdentity } = await import("./store.js");
    await adoptIdentity(handover);
  }

  await refresh();
  await startSync();
}

boot().catch((err) => {
  console.error("[app] boot failed:", err);
  root.textContent = "Something went wrong starting up. Reload to try again.";
});
