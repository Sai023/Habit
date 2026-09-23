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
import { dayKey, latestGoal, travelPeriod, addDays, groupDayHabit } from "./habits.js";
import { workoutLog } from "./workout.js";
import { windowsToRead } from "./vitals.js";
import { HABIT_DEFAULTS, PERIOD, MAX_BACKFILL_DAYS } from "./schema.js";
import { installBridge, caps, isNative, setSyncConfig, openSettings, onAppResume } from "./bridge.js";
import { showProblem, showNote } from "./ui/problem.js";
import { watchForUpdates } from "./update.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const root = document.getElementById("app");
const params = new URLSearchParams(location.search);
const isDemo = params.get("demo") === "1";

// An invite tapped as a link: /i/<code>?i=<code> after vercel.json's redirect, or still /i/<code>
// with no query at all when a service worker already controlling this origin answered the
// navigation from its own cache before the redirect was ever reached (see service-worker.js's
// navigate handler) — checked here too so that path isn't silently dropped for a returning visitor.
const inviteParam = params.get("i")
  || (location.pathname.startsWith("/i/") ? location.pathname.slice(3) : null);

const ui = {
  tab: params.get("tab") || "today",
  sync: { state: "LOCAL_ONLY", queued: 0 },
  boardView: "week",
  // A sync the person asked for, still running. Separate from sync.state, which describes the
  // page's own connection and knows nothing about the shell reading a sensor.
  syncing: false,
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

/**
 * Which habit day a moment falls in.
 *
 * The zone and the start hour come off the first habit, not off meta — habits carry a PINNED zone
 * so that travel cannot move the boundary, and the day the group is judged on is the one their
 * habits agree about.
 */
function dayKeyAt(state, at) {
  const first = groupDayHabit(state);
  const tz = first?.tz || HABIT_DEFAULTS.tz;
  const startHour = first?.dayStartHour ?? HABIT_DEFAULTS.dayStartHour;
  return dayKey(at, tz, startHour);
}

function todayKey(state) {
  return dayKeyAt(state, Date.now());
}

function paint() {
  if (!ctx || onboarding) return;
  renderApp(root, {
    ...ctx, ...ui, now: Date.now(), embedded: caps().embedded,
    focusSettings: caps().focusSettings,
    manualSync: caps().manualSync,
    onScoring, onWorkout, onChooseProgram, onLevel, onWeekRow,
    syncing: ui.syncing,
    onTab, onStart, onFixSync, onEditHabit, onEditGoals, onOpenHabits, onLog, onSchedule, onSeasons, onHabitDetail,
    onOpenSettings, onOpenFocus, onBoardCategory, onBoardView, onSyncNow,
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

/**
 * Hand off to the shell's screen-time controls.
 *
 * The control that calls this is only drawn when caps().focusSettings says the shell has somewhere
 * to send it, so reaching here and failing means the shell changed underneath a page that was
 * already open — which is exactly what a mid-session update does.
 */
const onOpenFocus = guard("focus", async () => {
  const { openFocus } = await import("./bridge.js");
  if (!openFocus()) {
    showProblem("Couldn't open screen-time settings from here.");
  }
});

/**
 * Read the sensors and push, now.
 *
 * Two halves, and both are needed. The shell re-reads Health Connect and pushes to the room; this
 * page then has to pull what was pushed, because a reading taken on this very device still travels
 * out to the server and back before the card can show it. Doing only the first leaves somebody
 * watching an unchanged number for the fifteen seconds until the next poll and concluding, fairly,
 * that the button does nothing.
 */
const onSyncNow = guard("sync", async () => {
  if (ui.syncing) return;
  ui.syncing = true;
  paint();
  try {
    const { requestSync, openHealthApp } = await import("./bridge.js");
    const message = await requestSync();
    const sync = await import("./sync.js");
    await sync.flush();
    await refresh();
    // The shell's own words, including the figure it just read off the sensor — which is the only
    // thing that can settle whether a stale number is this app's fault or the watch's.
    // Offered beside the reading rather than instead of it, and offered whether or not the data
    // looks stale, because there is no threshold worth inventing here: the note says how old the
    // provider's last write is, and how long is too long is the reader's call on the day. What the
    // app must not do is imply that syncing again would help — this button is the only thing that
    // makes Samsung Health hand over anything new, and the sync we just ran cannot.
    const provider = caps().healthApp;
    if (message) {
      showNote(message, provider ? { label: "Open " + provider, onClick: openHealthApp } : null);
    } else showProblem("Couldn't reach the app's sync from here.");
  } finally {
    ui.syncing = false;
    paint();
  }
});

/** Today's session from the program this member follows. */
const onWorkout = guard("workout", async () => {
  if (demoBlocked()) return;
  const { programFor } = await import("./workout.js");
  const program = programFor(ctx.state, ctx.me);
  if (!program) return onChooseProgram();
  const { openWorkoutSheet } = await import("./ui/workoutsheet.js");
  openWorkoutSheet(document.body, {
    state: ctx.state, program, me: ctx.me, today: ctx.today,
    onDone: () => refresh(),
    onChooseProgram,
    onHistory,
  });
});

/** Every workout, one by one — the log the hub's training block adds up, whole, from the hub. */
const onHistory = guard("history", async () => {
  const { openWorkoutHistory } = await import("./ui/workouthistory.js");
  openWorkoutHistory(document.body, {
    state: ctx.state, me: ctx.me, today: ctx.today,
    onExercise,
    onDone: () => {},
  });
});

/**
 * One workout, as its own sheet. The second step of the walk from the Workouts landing: the
 * list there opens this, back returns there, and an exercise in it opens the third step.
 */
const onOpenWorkout = guard("workout detail", async (day, sessionId) => {
  const { openWorkoutHistory } = await import("./ui/workouthistory.js");
  openWorkoutHistory(document.body, {
    state: ctx.state, me: ctx.me, today: ctx.today,
    openAt: { day, sessionId }, standalone: true,
    onExercise,
    onDone: () => {},
  });
});

/** One exercise over months — the third step. A row there opens the workout it came from. */
const onExercise = guard("exercise", async (exerciseId) => {
  const { openExerciseSheet } = await import("./ui/exercisesheet.js");
  openExerciseSheet(document.body, {
    state: ctx.state, me: ctx.me, today: ctx.today, exerciseId,
    onOpenWorkout,
    onDone: () => {},
  });
});

/** Pick which program to follow. Two to choose from, and the choice is one event. */
const onChooseProgram = guard("program", async () => {
  if (demoBlocked()) return;
  const { openProgramSheet } = await import("./ui/programsheet.js");
  openProgramSheet(document.body, {
    state: ctx.state, me: ctx.me,
    onDone: () => refresh(),
  });
});

/** The rules of the game, on one screen, with the reader's own day as the worked example. */
const onScoring = guard("scoring", async () => {
  const { openScoringSheet } = await import("./ui/scoringsheet.js");
  openScoringSheet(document.body, {
    state: ctx.state, me: ctx.me, today: ctx.today, onDone: () => {},
  });
});

/** One person's week, itemised: the days as bars and every habit as a count. */
const onWeekRow = guard("week", async (row) => {
  const { openWeekSheet } = await import("./ui/weeksheet.js");
  openWeekSheet(document.body, { row, ctx, onDone: () => {} });
});

/** Your level: where you stand, what the next one asks, and the titles. */
const onLevel = guard("level", async () => {
  const { openLevelSheet } = await import("./ui/levelsheet.js");
  openLevelSheet(document.body, { state: ctx.state, me: ctx.me, today: ctx.today, onDone: () => {} });
});

/**
 * A level reached overnight is celebrated on the first paint that sees it — once, and never over
 * another sheet, which would be a fanfare behind a form.
 *
 * Never headless. A background read of the engine shares this page's localStorage, so if it
 * marked the level as seen, the person would open the app to nothing — after a notification
 * that promised them a celebration.
 */
async function celebrateLevelUp() {
  if (!ctx || ctx.demo || onboarding || caps().headless || document.querySelector(".sheet-layer")) return;
  try {
    const [{ lifetime }, { levelUpDue, openLevelSheet }] = await Promise.all([
      import("./levels.js"), import("./ui/levelsheet.js"),
    ]);
    const life = lifetime(ctx.state, ctx.me, ctx.today);
    if (!levelUpDue(ctx.me, life.level)) return;
    openLevelSheet(document.body, { state: ctx.state, me: ctx.me, today: ctx.today, celebrate: true, onDone: () => {} });
  } catch (err) {
    console.warn("[level]", err);
  }
}

/**
 * The shell asked for the level celebration — somebody tapped the notification.
 *
 * The ask can arrive before the page has state (a cold start from the shade), so it is kept
 * until the first refresh, which calls back here. Shown even if the first paint already
 * celebrated it: the notification promised a celebration and a tap on it must produce one, not
 * a screen that already moved on. Idempotent while a level sheet is open.
 */
let levelAsked = false;
async function showLevelIfAsked() {
  if (!levelAsked || !ctx || onboarding || caps().headless) return;
  if (document.querySelector(".sheet-layer .lv")) { levelAsked = false; return; }
  if (document.querySelector(".sheet-layer")) return; // another sheet is up; try again next paint
  levelAsked = false;
  try {
    const { openLevelSheet } = await import("./ui/levelsheet.js");
    openLevelSheet(document.body, { state: ctx.state, me: ctx.me, today: ctx.today, celebrate: true, onDone: () => {} });
  } catch (err) {
    console.warn("[level]", err);
  }
}

/** Take a duplicate identity off the board. Confirmed by the sheet that offers it. */
const onRemoveMember = guard("member", async (memberId) => {
  const { removeMember } = await import("./store.js");
  if (await removeMember(memberId)) await refresh();
});

/** Fold one member id into another — the same person on two ids. See mergeMember. */
const onMergeMember = guard("merge member", async (fromId, intoId) => {
  if (demoBlocked()) return;
  const { mergeMember } = await import("./store.js");
  if (await mergeMember(fromId, intoId)) await refresh();
});

/** Bring a deleted habit back, with its history. See restoreHabit / the retired list. */
const onRestoreHabit = guard("restore habit", async (habitId, fields) => {
  if (demoBlocked()) return;
  const { restoreHabit } = await import("./store.js");
  await restoreHabit(habitId, fields);
  await refresh();
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
async function showGoals(firstRun = false, focus = null) {
  const [{ getState, identity }, { openGoalsSheet }] = await Promise.all([
    import("./store.js"), import("./ui/goals.js"),
  ]);
  const state = await getState();
  // Nothing to set targets for yet. The dashboard's own empty state offers the same thing, so a
  // slow first pull is not a dead end.
  if (!state.habits.size) return refresh();
  const { memberId } = await identity();
  openGoalsSheet(document.body, {
    state, me: memberId, firstRun, focus,
    // Given so the focused panel can offer "Edit the shared habit →" — the demoted, group-affecting
    // way in that a habit tap used to land on directly.
    onEditHabit,
    onDone: () => refresh(),
  });
}

// `focus` is a habitId when the person tapped one habit (its personal panel), or absent for the
// whole "your goals" list. Guarded because some callers wire it straight to an onclick.
function onEditGoals(focus = null) {
  if (demoBlocked()) return;
  showGoals(false, typeof focus === "string" ? focus : null);
}

async function onEditHabit(habitId) {
  if (demoBlocked()) return;
  const { openEditorSheet } = await import("./ui/editor.js");
  openEditorSheet(document.body, {
    state: ctx.state,
    me: ctx.me,
    today: ctx.today,
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
    onTravel,
    onRemoveMember,
    onRestoreHabit,
    onMergeMember,
    onClosed: () => refresh(),
  });
});

/** One habit, a layer deeper: the run, the window, and what happened in each period of it. */
const onHabitDetail = guard("habit detail", async (habitId) => {
  const habit = ctx.state.habits.get(habitId);
  if (!habit) return;
  const { openHabitDetail } = await import("./ui/habitdetail.js");
  openHabitDetail(document.body, {
    state: ctx.state, habit, me: ctx.me, today: ctx.today,
    onLog, onEdit: onEditHabit, onGoals: onEditGoals,
    // The Workouts habit's detail carries the program: today's session, and the log under a button.
    onWorkout: isDemo ? null : onWorkout, onChooseProgram: isDemo ? null : onChooseProgram,
    onOpenWorkout,
    onDone: () => refresh(),
  });
});

/** Days off. Booked ahead, never backwards — see travelsheet.js. */
const onTravel = guard("travel", async () => {
  if (demoBlocked()) return;
  const { openTravelSheet } = await import("./ui/travelsheet.js");
  openTravelSheet(document.body, {
    state: ctx.state, me: ctx.me, today: ctx.today,
    onDone: () => refresh(),
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
 * Every season the group has run, how they run, and the way to change that.
 *
 * Not demo-blocked: it writes nothing. The demo can read its own seasons, and the schedule
 * button inside it is refused on its own terms.
 */
const onSeasons = guard("seasons", async () => {
  const { openSeasonsSheet } = await import("./ui/seasonssheet.js");
  openSeasonsSheet(document.body, {
    state: ctx.state, me: ctx.me, today: ctx.today,
    onSchedule,
    onDone: () => refresh(),
  });
});

/**
 * Put seasons on a schedule: a new one on the same day every month, on its own.
 *
 * Offered first, because the alternative — remembering to press a button on the right morning —
 * is the thing that left the board on "Season over". The sheet still offers starting one by hand,
 * which falls through to the old form below.
 */
const onSchedule = guard("schedule", async () => {
  if (demoBlocked()) return;
  const [{ scheduleSheet }, { scheduleSeasons }, { seasonProgress, seasonSchedule }, { addDays }] =
    await Promise.all([
      import("./ui/schedulesheet.js"), import("./store.js"), import("./season.js"), import("./habits.js"),
    ]);

  const where = seasonProgress(ctx.state, ctx.today);
  const rule = seasonSchedule(ctx.state);
  // The day after the running season ends, when it has an end still ahead — the natural first day
  // for a group that wants to finish what it is playing.
  const running = !!(where && where.end && !where.ended);
  const after = running ? addDays(where.end, 1) : null;
  const chosen = await scheduleSheet(document.body, {
    today: ctx.today, after, every: rule ? rule.every : null, running,
  });
  if (!chosen) return;
  if (chosen.byHand) { await onNewSeason(); return; }

  await scheduleSeasons(chosen.from, chosen.day);
  await refresh();
});

/**
 * Draw a line under the standings, by hand.
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
  const [{ seasonSheet }, { startNewSeason }, { periodStart, isoWeekKey, addDays }, { seasonTally }] =
    await Promise.all([
      import("./ui/seasonsheet.js"), import("./store.js"), import("./habits.js"),
      import("./season.js"),
    ]);

  // The next week boundary — which is TODAY when today is already a Monday.
  //
  // This was `+ 7` unconditionally, so somebody starting a season on a Monday was offered the
  // Monday after it: the option that says "week one starts clean" meant "nothing happens for a
  // week". It is the default in the sheet, so it is the one most likely to be taken, and it is
  // exactly the day somebody sets up a season on.
  const thisMonday = periodStart(isoWeekKey(ctx.today), "week");
  const monday = thisMonday === ctx.today ? thisMonday : addDays(thisMonday, 7);
  const { weeks } = seasonTally(ctx.state, [...ctx.state.members.keys()], ctx.today);

  const chosen = await seasonSheet(document.body, { monday, today: ctx.today, weeks });
  if (!chosen) return;

  await startNewSeason(chosen.from, chosen.weeks);
  await refresh();
});

/** Which slice of the board is showing. Kept in `ui` so it survives a sync repaint. */
function onBoardCategory(category) {
  ui.boardCategory = category;
  paint();
}

/**
 * Which of the board's three views is showing: this week, all time, or the case.
 *
 * A string rather than the boolean it replaced, because there are three now — and a second boolean
 * is how a two-way switch quietly becomes a state machine nobody meant to write. Kept in `ui` so a
 * sync repaint does not bounce somebody back to the week.
 */
function onBoardView(view) {
  ui.boardView = view;
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
    + "It is usually battery optimisation putting the app to sleep — on Samsung, check "
    + "Settings \u2192 Battery \u2192 Background usage limits and make sure Goal Buddy is not sleeping.",
  );
}

/**
 * Keep what is on screen true, without being asked.
 *
 * ---- The two ways a screen goes stale ----
 *
 * `ctx.today` is worked out once, when the state is loaded. Leave the app open past the day
 * boundary — which people do, because the boundary is four in the morning and the last thing many
 * of them check is the vape count — and every card, the streak line and the time-left note all go
 * on describing yesterday. Nothing looks broken. It is just quietly wrong, which is worse.
 *
 * The other is arriving with numbers that were fetched hours ago: opening the app is exactly the
 * moment somebody looks at their step count, and it is the moment least likely to be covered by a
 * background job Android may not be running at all.
 *
 * So: re-derive on the way back in, and hold a timer to the next boundary while the app is open.
 * Both end in the same `refresh()`, which is cheap — a replay of the local log, no network.
 */
function watchTheClock() {
  let timer = null;

  function schedule() {
    clearTimeout(timer);
    if (!ctx) return;
    const ms = msUntilDayChange(ctx.state);
    // Recomputed after every fire rather than repeated, so a clock change, a flight or the end of
    // daylight saving is absorbed instead of accumulating.
    timer = setTimeout(tick, Math.min(ms, MAX_TIMER_MS));
  }

  // The wake is cheap on purpose. A long timer is not honoured reliably, so this one re-arms every
  // half hour — and a full replay of the log on each of those, for an app somebody left open, is a
  // cost with nothing to show for it. Comparing two day strings is not.
  function tick() {
    if (!ctx) return;
    // Not in the demo. Its state is generated, not stored, so refresh() finds no group and shows
    // onboarding over it — which is how "look around with example data" ended at midnight, and at
    // every foreground, on a screen asking you to start a group.
    if (isDemo) return;
    if (todayKey(ctx.state) !== ctx.today) refresh().catch(() => {});
    else schedule();
  }

  function catchUp() {
    // Cheap enough to run unconditionally: it is a replay of a log already in memory. Guarded only
    // against running before the first load has finished — and against the demo, for the reason
    // above; onData has carried the same guard all along.
    if (ctx && !isDemo) refresh().catch(() => {});
  }

  onAppResume(catchUp);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") catchUp();
  });

  return { schedule };
}

/** A setTimeout longer than this is not reliably honoured, so the timer wakes and re-arms. */
const MAX_TIMER_MS = 30 * 60 * 1000;

/** Milliseconds until the habit day rolls over, by the group's timezone and start hour. */
function msUntilDayChange(state) {
  const now = Date.now();
  const today = todayKey(state);
  // Walk forward in coarse steps and then refine, rather than doing timezone arithmetic by hand:
  // the boundary is a wall-clock hour in a named zone, and reconstructing that from an offset is
  // exactly the sum that breaks twice a year.
  let lo = 0;
  let hi = 26 * 60 * 60 * 1000;
  const changedBy = (ms) => dayKeyAt(state, now + ms) !== today;
  if (!changedBy(hi)) return hi;
  while (hi - lo > 30_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (changedBy(mid)) hi = mid; else lo = mid;
  }
  return Math.max(30_000, hi);
}

const clock = watchTheClock();

async function refresh() {
  const { getState, identity } = await import("./store.js");
  const { db } = await import("./db.js");
  const { memberId, code } = await identity();
  if (!code) { await showOnboard(); return; }
  if (onboarding) return; // the share screen is still being read; do not paint over it

  const state = await getState();
  ctx = { state, events: await db.allEvents(), me: memberId, today: todayKey(state), demo: false };
  paint();
  clock.schedule();
  tellShell(state, memberId, code);
  tellShellSummary(state, memberId);
  if (levelAsked) showLevelIfAsked();
  else celebrateLevelUp();
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
/**
 * When this phone should nudge ME about a habit.
 *
 * Reminders used to live on the habit itself, which every device replays — so the group shared one
 * alarm clock. Setting yours for six in the morning set everybody's, silently, and the last person
 * to open the editor won. They live on the per-member goal now.
 *
 * The habit is still read as a fallback, and has to be: every reminder set before this change is
 * sitting on a habit_def row in a log that is append-only and replayed by three phones. Dropping
 * to null would switch off every reminder anybody had, at once, on an upgrade. It resolves to the
 * personal one the moment that person touches the control.
 */
function reminderFor(state, memberId, habit) {
  // A daily habit never carries one. The shell already raises a single evening prompt covering
  // everything daily — "go and update your day" — and an alarm per habit on top of it is six
  // notifications a night for six habits, which is how somebody ends up silencing the channel.
  //
  // Suppressed here rather than only hidden in the UI, because reminders set on daily habits by
  // the old editor are sitting in the log and would otherwise keep firing beside the 8pm one.
  if (habit.period === PERIOD.DAY) return { remindAt: null, remindDays: [] };

  const goal = latestGoal(state, habit.habitId, memberId);
  // undefined, not null: nobody has answered yet. null is somebody answering "no reminder", and it
  // has to beat the fallback or switching one off would re-inherit the group's old time.
  if (goal && goal.remindAt !== undefined) {
    return { remindAt: goal.remindAt, remindDays: goal.remindDays || [] };
  }
  return { remindAt: habit.remindAt ?? null, remindDays: habit.remindDays || [] };
}

/**
 * The instant reminders should start again, or 0.
 *
 * Travel turns notifications off, and the shell must not be the thing that decides that — it would
 * need to know what an exemption is, and the whole seam between these two halves is that the web
 * owns verdicts. So this is a verdict, expressed as a time: the start of the first day that is not
 * exempt.
 *
 * Sent as an instant rather than a date because the shell's alarm arithmetic is in milliseconds,
 * and a date would make it re-derive a day boundary the engine has already worked out.
 */
function quietUntil(state, memberId, today) {
  const away = travelPeriod(state, memberId, today);
  if (!away) return 0;
  const habit = groupDayHabit(state);
  const tz = (habit && habit.tz) || HABIT_DEFAULTS.tz;
  const startHour = habit ? habit.dayStartHour : HABIT_DEFAULTS.dayStartHour;
  // The morning after the last day away. dayStartHour is the app's midnight, so a 4am day start
  // means reminders resume at 4am rather than at a calendar midnight nothing else uses.
  return Date.parse(addDays(away.to, 1) + "T00:00:00Z") + startHour * 3600_000
    - tzOffsetMs(tz, away.to);
}

/** How far the pinned zone is ahead of UTC on a given day, so a day key can become an instant. */
function tzOffsetMs(tz, day) {
  const probe = new Date(day + "T12:00:00Z");
  const local = new Date(probe.toLocaleString("en-US", { timeZone: tz }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}

function tellShell(state, memberId, code) {
  if (!isNative()) return;
  const habits = [...state.habits.values()].map((h) => ({
    habitId: h.habitId, metric: h.metric, tz: h.tz, dayStartHour: h.dayStartHour,
    name: h.name || "", days: h.days || [], period: h.period,
    ...reminderFor(state, memberId, h),
  }));
  const quiet = quietUntil(state, memberId, ctx.today);
  // The timed workouts the phone should read the watch for — see vitals.js.
  const workouts = windowsToRead(workoutLog(state, memberId, ctx.today), ctx.today, addDays, MAX_BACKFILL_DAYS);
  const signature = code + "|" + memberId + "|" + quiet + "|" + JSON.stringify(habits) + "|" + JSON.stringify(workouts);
  if (signature === lastShellConfig) return;
  lastShellConfig = signature;
  setSyncConfig({
    groupCode: code, memberId, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_ANON_KEY, habits,
    quietUntil: quiet, workouts,
  });
}

async function showOnboard() {
  const { renderOnboard } = await import("./ui/onboard.js");
  const { decodeInvite } = await import("./setup-code.js");
  onboarding = true;
  // decodeInvite returns null for anything malformed — a stale, truncated or tampered link falls
  // back to the ordinary welcome screen rather than throwing.
  const invite = inviteParam ? decodeInvite(inviteParam) : null;
  renderOnboard(root, {
    initialJoinCode: invite ? invite.code : undefined,
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
    onNavigate: (tab) => {
      // Not a tab: the shell is handing over a notification tap. See showLevelIfAsked.
      if (tab === "level") { levelAsked = true; showLevelIfAsked(); return; }
      ui.tab = tab;
      paint();
    },
  });

  // Pull down on Today to sync.
  //
  // Installed once, for the life of the page, rather than per paint — the listeners are on the
  // document and re-registering them on every render is how you end up with four syncs per swipe.
  // Whether the gesture is live right now is answered by canPull instead, at the start of each
  // drag, which is also the only moment it is a fair question to ask.
  const { installPullToRefresh } = await import("./ui/pulltorefresh.js");
  installPullToRefresh({
    onRefresh: () => onSyncNow(),
    canPull: () => (
      ui.tab === "today"
      && caps().manualSync
      && !ui.syncing
      && !isDemo
      // Sheets do their own dragging, and a sheet open over Today is not Today.
      && !document.querySelector(".sheet-layer")
    ),
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

// Before boot, and outside it. If a bad build is what stopped the app starting, the machinery
// that can replace that build has to be running regardless of whether boot got anywhere.
watchForUpdates();

boot().catch((err) => {
  console.error("[app] boot failed:", err);
  root.textContent = "Something went wrong starting up. Reload to try again.";
});
