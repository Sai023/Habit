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
import { showProblem } from "./ui/problem.js";
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
    onTab, onStart, onFixSync, onEditHabit, onEditGoals, onOpenHabits, onLog, onNewSeason,
    onOpenSettings, onBoardCategory, onBoardSeason,
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
  // showProblem, not alert: a WebView with no WebChromeClient swallows alert() entirely, so in
  // Pause this said nothing at all and a tap in demo mode simply appeared to do nothing.
  showProblem("This is example data. Start or join a real group to change anything.");
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
      if (recoverFromStaleModules(err)) return undefined;
      showProblem("Something went wrong opening " + what + ". " + (err && err.message ? err.message : err));
      return undefined;
    }
  };
}

/**
 * Half of the app is newer than the other half. Reload once and stop being.
 *
 * The service worker updates whenever any asset changes, and it claims open pages immediately so a
 * fix does not wait for every tab to close. The cost is that a page which has already evaluated
 * yesterday's modules can dynamically import today's — and where today's statically imports
 * something yesterday's does not export, that is a hard module error, not a graceful shortfall.
 *
 * The individual case is avoidable by not importing across that boundary, and the code no longer
 * does. This is for the next one, because the boundary is invisible at the point you write the
 * import and the failure only ever appears on a device that happened to be mid-update.
 *
 * Guarded by a one-shot flag: a reload loop is far worse than the error it is trying to clear.
 */
function recoverFromStaleModules(err) {
  const message = String((err && err.message) || err || "");
  const isModuleSkew = /does not provide an export|dynamically imported module|Importing a module script failed/i
    .test(message);
  if (!isModuleSkew) return false;
  try {
    if (sessionStorage.getItem("reloaded-for-skew")) return false;
    sessionStorage.setItem("reloaded-for-skew", String(Date.now()));
  } catch {
    return false; // no session storage means no way to stop a loop, so do not start one
  }
  showProblem("Finishing an update…");
  location.reload();
  return true;
}

// The same net, under everything that never went through guard(). A phone has no console, so an
// error nobody surfaces is an error nobody can report.
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[unhandled]", e.reason);
    if (recoverFromStaleModules(e.reason)) return;
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
    showProblem("Couldn't open settings from here. Open Goal Buddy directly.");
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
    onInvite,
    onClosed: () => refresh(),
  });
});

/**
 * The code to hand somebody so they can join.
 *
 * Its own screen rather than a line on the onboarding one, because inviting is something you do
 * whenever somebody new turns up — and the only code that stayed findable afterwards was the setup
 * code, which is the one that must never be sent.
 */
const onInvite = guard("invite", async () => {
  if (demoBlocked()) return;
  const { openInviteSheet } = await import("./ui/invitesheet.js");
  const { identity } = await import("./store.js");
  const { code } = await identity();
  openInviteSheet(document.body, { groupCode: code, onClosed: () => refresh() });
});

/**
 * Draw a line under the standings.
 *
 * Starts on the next Monday rather than today, because a season that begins mid-week opens with a
 * week half of which was played under the old one — and the first thing anybody would ask about
 * the new table is why week one looks odd.
 *
 * Says plainly what survives. "Reset" is a word people have learned to read as "lose everything",
 * and the whole point of this is that it only clears the scoreboard.
 */
const onNewSeason = guard("season", async () => {
  if (demoBlocked()) return;
  const [{ confirmSheet }, { startNewSeason }, { periodStart, isoWeekKey, addDays }] =
    await Promise.all([
      import("./ui/confirmsheet.js"), import("./store.js"), import("./habits.js"),
    ]);

  const monday = addDays(periodStart(isoWeekKey(ctx.today), "week"), 7);
  const sure = await confirmSheet(document.body, {
    title: "Start a new season?",
    body: "Crowns, points and weeks won go back to zero for everybody, from Monday " + monday + ". "
      + "Nothing else changes — every habit, target, taper, logged number and streak stays exactly "
      + "as it is. It only clears the scoreboard.",
    confirmLabel: "Start it",
    cancelLabel: "Keep the season",
  });
  if (!sure) return;

  await startNewSeason(monday);
  await refresh();
});

/** Which slice of the board is showing. Kept in `ui` so it survives a sync repaint. */
function onBoardCategory(category) {
  ui.boardCategory = category;
  paint();
}

/** This week, or the whole season. Kept in `ui` so a sync repaint does not bounce you back. */
function onBoardSeason(on) {
  ui.boardSeason = !!on;
  paint();
}

function onTab(tab) {
  ui.tab = tab;
  const url = new URL(location.href);
  url.searchParams.set("tab", tab);
  history.replaceState(null, "", url); // survives a reload without stacking history entries
  paint();
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
  showProblem(
    who + " phone hasn't reported this week. "
    + "On that phone, in Goal Buddy: open the group settings and read what the delivery card says. "
    + "It is usually battery optimisation putting the app to sleep \u2014 on Samsung, check "
    + "Settings \u2192 Battery \u2192 Background usage limits and make sure Goal Buddy is not sleeping.",
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
    name: h.name || "", days: h.days || [], remindAt: h.remindAt ?? null,
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
