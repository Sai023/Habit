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
import { installBridge, caps, isNative, setSyncConfig, openSettings } from "./bridge.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

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
  renderApp(root, {
    ...ctx, ...ui, now: Date.now(), embedded: caps().embedded,
    onTab, onUrge, onStart, onFixSync, onEditHabit, onEditGoals, onOpenHabits, onLog,
    onOpenSettings,
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

/**
 * Nothing fails quietly.
 *
 * Every one of these handlers is an async function on a click, so a thrown error becomes an
 * unhandled rejection: no message, no console anybody is reading, and a button that does nothing.
 * Two separate bugs hid behind exactly that for a release — one of them a one-character argument
 * mismatch — and on a phone there is no console to check, so "it does nothing" was the entire bug
 * report available to the person using it.
 *
 * A wrapper rather than a try/catch in each: the ones people forget to write are the ones that
 * matter, and forgetting is the normal case.
 */
function guard(what, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error("[" + what + "]", err);
      showProblem("Something went wrong opening " + what + ". " + (err && err.message ? err.message : err));
      return undefined;
    }
  };
}

/** A dismissible banner. Deliberately ugly: it is meant to be reported, not lived with. */
function showProblem(message) {
  const existing = document.querySelector(".problem");
  if (existing) existing.remove();
  const bar = document.createElement("div");
  bar.className = "problem";
  bar.setAttribute("role", "alert");
  bar.textContent = message;
  const close = document.createElement("button");
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => bar.remove();
  bar.append(close);
  document.body.append(bar);
}

// The same net, under everything that never went through guard(). A phone has no console, so an
// error nobody surfaces is an error nobody can report.
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[unhandled]", e.reason);
    showProblem("Something went wrong: " + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });
}

/**
 * Hand off to the shell's settings sheet, and say so if there is nothing to hand off to.
 *
 * This was silently dead for a release. The bridge call failed on an argument-count mismatch, the
 * failure was swallowed, and the button did nothing at all — which is indistinguishable from a
 * button nobody wired up. It reports now, and so does everything else that can fail.
 */
const onOpenSettings = guard("settings", async () => {
  const { openSettings } = await import("./bridge.js");
  if (!openSettings()) {
    showProblem("Couldn't open Pause's settings from here. Open the Pause app directly.");
  }
});

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
 * Everything that is not Today or Board is a sheet now.
 *
 * These were full-screen takeovers that owned the root and hid the tab bar, which is workable in a
 * browser and wrong inside a native shell: the shell's bar stays on screen regardless, so a web
 * screen that assumed it had the whole window left the app looking like two apps arguing over one
 * viewport.
 *
 * They mount on <body> rather than the app root, because a sync landing mid-edit repaints the root
 * and would take the form with it — the bug already found and fixed once in the log sheet.
 */
async function showGoals(firstRun = false) {
  const [{ getState, identity }, { openGoalsSheet }] = await Promise.all([
    import("./store.js"), import("./ui/goals.js"),
  ]);
  const state = await getState();
  // Nothing to set targets for yet. The dashboard's own empty state offers the same thing, so a
  // slow first pull is not a dead end.
  if (!state.habits.size) return refresh();
  const { memberId } = await identity();
  openGoalsSheet(document.body, {
    state, me: memberId, firstRun,
    onDone: () => refresh(),
  });
}

function onEditGoals() {
  if (demoBlocked()) return;
  showGoals(false);
}

async function onEditHabit(habitId) {
  if (demoBlocked()) return;
  const { openEditorSheet } = await import("./ui/editor.js");
  openEditorSheet(document.body, {
    state: ctx.state,
    me: ctx.me,
    habitId: habitId || null, // null means new
    onDone: () => refresh(),
  });
}

/** The menu: the habit list, your goals, and — inside Pause — the shell's own settings. */
const onOpenHabits = guard("menu", async () => {
  if (demoBlocked()) return;
  const { openHabitsSheet } = await import("./ui/habitsheet.js");
  openHabitsSheet(document.body, {
    state: ctx.state,
    me: ctx.me,
    today: ctx.today,
    embedded: caps().embedded,
    onEditHabit,
    onEditGoals,
    onOpenSettings,
    onClosed: () => refresh(),
  });
});

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
/**
 * The urge, and what came of it.
 *
 * Inside Pause the shell owns this: a notification with the two answers on it, so the decision can
 * be made from the lock screen at the moment it matters. In a browser there is no breathing screen
 * to show, so the least it can do is ask.
 *
 * It used to log a 1 the instant the button was pressed — charging somebody a puff for admitting
 * they wanted one, before they had decided anything. That made the number wrong in the direction
 * that matters most, since resisting is the whole point of pressing it, and it turned the one
 * button meant to help into a reason not to touch the app.
 */
async function onUrge(habit) {
  if (caps().native) {
    const { notify } = await import("./bridge.js");
    notify({ title: "Pause", body: "Take a breath.", actions: ["Resisted", "Vaped anyway"] });
    return;
  }
  if (demoBlocked()) return;
  const [{ openSheet }, { el }] = await Promise.all([
    import("./ui/sheet.js"), import("./dom.js"),
  ]);
  const sheet = openSheet(document.body);
  const answer = async (amount) => {
    const { logDiscrete } = await import("./store.js");
    // Zero is a real entry, not a no-op: it is the record of a resisted urge, and it is what makes
    // a clean day something the engine can see rather than something it has to assume.
    await logDiscrete(habit.habitId, ctx.today, amount);
    sheet.close();
    await refresh();
  };
  sheet.paint(
    el("div.sheet-head",
      el("span.card-icon", habit.icon || "\u25c6"),
      el("span.sheet-title", "Take a breath"),
    ),
    el("p.sheet-now", "Sixty seconds is usually all it takes. What happened?"),
    el("div.sheet-actions",
      el("button.ghost", { onclick: () => answer(1) }, "I gave in"),
      el("button.tap", { onclick: () => answer(0) }, "I resisted"),
    ),
  );
}

async function onStart() {
  ctx = null;
  await showOnboard();
}

/**
 * The bridge between the symptom and the diagnosis.
 *
 * The symptom is seen here — a row on the board with nothing in it — and the cause is always on
 * somebody's phone. When that phone is THIS one and Pause is hosting us, the shell now has a real
 * answer to the question, worked out from whether Android has actually been running the sync
 * rather than guessed at. Sending someone to it beats repeating a list of things it might be.
 *
 * For anybody else's row there is nothing to open, so the advice stays advice. It no longer says
 * "watch", which was a guess that a screen-time habit makes plainly wrong.
 */
function onFixSync(row) {
  if (row.memberId === ctx?.me && caps().embedded) {
    openSettings();
    return;
  }
  const who = row.memberId === ctx?.me ? "Your" : (row.name || "Their") + "'s";
  alert(
    who + " phone hasn't reported this week.\n\n"
    + "On that phone, in Pause: open the group settings and read what the delivery card says. "
    + "It is usually battery optimisation putting the app to sleep \u2014 on Samsung, check "
    + "Settings \u2192 Battery \u2192 Background usage limits and make sure Pause is not sleeping.",
  );
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
  tellShell(state, memberId, code);
  tellShellSummary(state, memberId);
}

let lastSummary = "";

/**
 * Keep the shell's copy of today's answers current.
 *
 * Sent on every refresh rather than on a timer: the shell's Home and Insights are native and open
 * without this app running at all, so the last thing it was told has to be the truth as of the
 * last time anybody looked. Guarded by a signature, because a repaint is not news.
 */
async function tellShellSummary(state, memberId) {
  if (!isNative()) return;
  try {
    const [{ buildSummary, summarySignature }, { setSummary }] = await Promise.all([
      import("./summary.js"), import("./bridge.js"),
    ]);
    const summary = buildSummary(state, memberId, todayKey(state));
    const signature = summarySignature(summary);
    if (signature === lastSummary) return;
    lastSummary = signature;
    setSummary(summary);
  } catch (err) {
    // Never let a display nicety take the dashboard down with it.
    console.warn("[summary]", err);
  }
}

let lastShellConfig = "";

/**
 * Keep the shell's copy of the habit list current.
 *
 * The shell reports screen time on a thirty-minute schedule with no WebView open, which means it
 * needs to know a screen-time habit exists WITHOUT anybody visiting a settings screen to tell it.
 * Until this, it learned the list only when its own settings sheet was opened: you could add the
 * habit here, watch it appear on the board, and it would never once be reported.
 *
 * Sent on every refresh rather than on save, because habits also arrive by sync — somebody else
 * adding one on their phone has to reach this phone's worker too, and there is no save on this
 * device for that. It is a cheap local write, and the signature check keeps it to genuine changes.
 */
function tellShell(state, memberId, code) {
  if (!isNative()) return;
  const habits = [...state.habits.values()].map((h) => ({
    habitId: h.habitId, metric: h.metric, tz: h.tz, dayStartHour: h.dayStartHour,
  }));
  const signature = code + "|" + memberId + "|" + JSON.stringify(habits);
  if (signature === lastShellConfig) return;
  lastShellConfig = signature;
  setSyncConfig({
    groupCode: code, memberId, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_ANON_KEY, habits,
  });
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
      await refresh();
      // Dashboard first, then the sheet over it — a sheet floating over nothing reads as an error.
      if (pendingGoals) { pendingGoals = false; await showGoals(true); }
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
