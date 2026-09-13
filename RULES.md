# Where the rules live

A map, not a specification. Every line points at the code that **owns** a rule and the test that
**enforces** it — it does not restate what the rule does.

That restraint is the whole design. Every rule-shaped bug this project has had was a rule that
existed in two places and drifted, and in each case the rule was already written down correctly in
a comment next to the code:

- `remindDays` was written by the editor, parsed by the shell, and never put on the wire between them
- visibility was stored on the habit while behaving as though it were per-person
- `goals.js` carried a comment explaining precisely the bug introduced twenty lines away in `editor.js`
- `PauseSource` carried a comment explaining why reporting zero was safe, and it was wrong

None of those was caused by nobody knowing the rule. They were caused by prose not executing. A
document that described behaviour would be one more copy to drift, and unlike a test it cannot fail
to tell you so. So this file answers one question only: **where does this rule live, and is there
another copy of it?**

Two repos. `Habit/` is the engine and owns every verdict; `PauseApp/` is the Android shell and only
ever observes. Paths below are relative to each repo's root.

---

## The day

| Rule | Owned by | Enforced by |
|---|---|---|
| A day is worth exactly 100, split 40 / 30 / 15 / 15 | `js/score.js` — `CATEGORY_WEIGHT` | `test/score.test.mjs` |
| A category with nothing eligible is dropped, and the rest regrow to fill the hundred | `js/score.js` — `dayScore` | `test/optout.test.mjs` |
| Habits inside a category share it equally | `js/score.js` — `categoryScores` | `test/score.test.mjs` |
| Bonus is a separate currency, capped at 1.15, and never crosses categories | `js/score.js` — `BONUS_CAP` | `test/bonus.test.mjs` |
| Four states: HIT, MISS, NO_DATA, EXEMPT | `js/habits.js` — `rawDayStatus` | `test/habits.test.mjs` |
| A day starts at 04:00 in the habit's pinned zone, not the device's | `js/habits.js` — `dayKey` | `test/habits.test.mjs`, `app/src/test/.../HabitDayTest.kt` |

## Which habits count

| Rule | Owned by | Enforced by |
|---|---|---|
| Only six metrics score on the board | `js/schema.js` — `SCORED_METRICS` | `test/onboard.test.mjs` |
| A custom habit tracks and streaks but never scores | `js/habits.js` — `h.scored` | `test/onboard.test.mjs` |
| Declining a habit costs nothing, in points or on the board | `js/habits.js` — `isTracking` | `test/optout.test.mjs` |
| A habit is not judged before the day it was created | `js/score.js` — `habitScore` | `test/retroactive.test.mjs` |
| A retired metric becomes the one that replaced it | `js/schema.js` — `LEGACY_METRIC` | `test/legacy.test.mjs` |
| A retired preset name is renamed only where nobody typed over it | `js/schema.js` — `LEGACY_NAME` | `test/legacy.test.mjs` |

## Yours versus the group's

The line this app is built on: **the group agrees on WHAT is tracked; everything about how it
applies to one person is theirs.** Four things sit on the personal side, and three of them started
on the wrong one.

| Rule | Owned by | Enforced by |
|---|---|---|
| Your target is yours | `js/habits.js` — `targetFor` | `test/goals.test.mjs`, `test/personal.test.mjs` |
| Your reminder is yours | `js/schema.js` — `ev.goal` | `test/personal.test.mjs` |
| What the group sees of your number is yours | `js/habits.js` — `visibilityFor` | `test/personal.test.mjs` |
| Which source feeds your habit is yours | `js/habits.js` — `sourceFor` | `test/goals.test.mjs` |
| A habit's own target is a SEED, written only at birth | `js/edits.js` — `habitFields` | `test/edits.test.mjs` |
| An edit screen shows what you last SET, not what is in force | `js/edits.js` — `goalToShow` | `test/edits.test.mjs` |

## The past is closed

| Rule | Owned by | Enforced by |
|---|---|---|
| A goal change counts from tomorrow; a first goal counts from today | `js/habits.js` — `T.GOAL` replay | `test/retro.test.mjs` |
| A weekly goal is read at the START of its week, so a mid-week change lands on Monday | `js/habits.js` — `targetFor` (`goalDay`) | `test/edits.test.mjs` |
| A goal set but not yet counting is announced with the day it lands | `js/edits.js` — `pendingGoal` | `test/edits.test.mjs` |
| A log more than 2 days late is refused | `js/schema.js` — `MAX_BACKFILL_DAYS` | `test/retro.test.mjs` |
| …except steps kept by hand, which may be entered for an earlier day of the same week — never across a Monday, never over a sensor | `js/habits.js` — `withinBackfill`, `keptByHandAllWeek` | `test/retro.test.mjs` |
| Travel cannot be backdated at all — zero days, not two | `js/habits.js` — `T.EXEMPT` replay | `test/travel.test.mjs` |
| Ending travel may only bring the last day forward | `js/habits.js` — `T.EXEMPT` replay | `test/travel.test.mjs` |
| Nothing done today may re-score a finished week | `js/score.js` | `test/retroactive.test.mjs` |
| A guard reads `min(claim, server arrival)`, never the device clock alone | `js/habits.js` — `authoredAt` | `test/clock.test.mjs` |

## Streaks, taper, grace

| Rule | Owned by | Enforced by |
|---|---|---|
| EXEMPT preserves a streak; MISS breaks it | `js/habits.js` — `walk` | `test/habits.test.mjs`, `test/travel.test.mjs` |
| A ceiling comes down on its own, and holds when you stop | `js/habits.js` — `taperedTarget` | `test/taper.test.mjs` |
| Grace scales with the period | `js/schema.js` — `GRACE_BY_PERIOD` | `test/habits.test.mjs` |
| Badges count CROSSINGS, so one can be won twice | `js/awards.js` | `test/awards.test.mjs` |
| Four group tiers at 7 / 20 / 50 / 100 days | `js/milestones.js` — `TIERS` | `test/milestones.test.mjs` |
| Per-habit levels are counted in the habit's own period | `js/milestones.js` — `HABIT_TIERS` | `test/milestones.test.mjs` |
| A habit's history is its own periods, and the open one is never scored | `js/history.js` — `habitHistory` | `test/history.test.mjs` |
| Which direction counts as better is the habit's, never the arrow's | `js/history.js` — `trend` | `test/history.test.mjs` |
| A weekday pattern is named only when it is real | `js/history.js` — `worstWeekday` | `test/history.test.mjs` |
| A comparison shows only what each person chose to share | `js/history.js` — `groupHistory` | `test/history.test.mjs` |
| Progress is measured against THEIR target, not the seed | `js/habits.js` — `publicValue` | `test/history.test.mjs` |

## The season

| Rule | Owned by | Enforced by |
|---|---|---|
| A season is derived from one meta line, never a stored tally | `js/season.js` — `seasonStart` | `test/season-reset.test.mjs` |
| A partial first week is scored only on the days it ran | `js/season.js` — `weekStandings` | `test/season-lifecycle.test.mjs` |
| A finished season stops counting weeks | `js/season.js` — `seasonWeeks` | `test/season-lifecycle.test.mjs` |
| A week is the total of its days out of 700; the average is shown, never ranked | `js/score.js` — `scoreOver` | `test/habits.test.mjs` |
| Ranked on points; crowns break a tie | `js/season.js` — `seasonTally` | `test/season.test.mjs` |
| Scoring starts at the first WHOLE week; the stub before it is warm-up | `js/season.js` — `weeksIn` | `test/season-lifecycle.test.mjs` |
| A chosen length always delivers that many WHOLE weeks | `js/season.js` — `endFor` | `test/season-lifecycle.test.mjs` |
| A booked season does not erase the one it replaces | `js/season.js` — `seasonStart` | `test/season-lifecycle.test.mjs` |
| Every season run is readable afterwards, by its own window | `js/season.js` — `seasonHistory` | `test/season-lifecycle.test.mjs` |

## Workouts

| Rule | Owned by | Enforced by |
|---|---|---|
| The schedule suggests; any session can be started on any day and is logged on that day | `js/workout.js` — `planFor`, `sessionsOf` | `test/workout.test.mjs` |
| Finishing a session writes ONE workout for that day and session, so finishing twice corrects rather than doubles | `js/store.js` — `finishWorkout` | `test/workout.test.mjs` |
| A set prefills from the last time THAT session was done, whatever day that was | `js/workout.js` — `prefill`, `lastSession` | `test/workout.test.mjs` |
| A personal best is strictly greater than the record; matching is not beating | `js/workout.js` — `beatsBest` | `test/workout.test.mjs` |
| Favourites and patterns are claimed only after three sessions, and no least favourite is invented | `js/workout.js` — `MIN_INSIGHT_SESSIONS`, `workoutInsights` | `test/workout.test.mjs` |
| Sets banked in an unfinished session survive until Finish, and both screens say so | `js/ui/workoutdraft.js` | — (UI; verified by hand) |
| Rope intervals step up by the week of the program, counted from its start day | `js/workout.js` — `intervalsFor`, `progressionWeek` | `test/workout.test.mjs` |

## Levels

| Rule | Owned by | Enforced by |
|---|---|---|
| Lifetime XP is every closed day's score plus bonus, since the day you joined | `js/levels.js` — `lifetime` | `test/levels.test.mjs` |
| Today is shown but not banked; a level cannot be reached and lost in one day | `js/levels.js` — `lifetime` (`today`, `levelUpToday`) | `test/levels.test.mjs` |
| Each level asks 25 more than the last, from 300; Level 100 is the top | `js/levels.js` — `gapTo`, `thresholdFor`, `LEVEL_MAX` | `test/levels.test.mjs` |
| A level begins ON its threshold | `js/levels.js` — `levelFor` | `test/levels.test.mjs` |
| The join day is on the member and a rename does not move it | `js/habits.js` — `T.MEMBER` replay (`since`) | `test/levels.test.mjs` |
| A level-up is celebrated once, and never on the first sight of a level | `js/ui/levelsheet.js` — `levelUpDue` | — (UI; verified by hand) |
| Levels rank nobody; the board still orders on the week | `js/ui/dashboard.js` — `rowLevel` | `test/habits.test.mjs` (ranking) |
| The bar and ring draw THIS level and start again at every level; the total is its own number | `js/levels.js` — `levelFor` (`pct`) | `test/levels.test.mjs` |
| A fact about you has a floor below which it is absent, and is worded once, for you only | `js/facts.js` — `factsAbout` | `test/facts.test.mjs` |

## The log itself

| Rule | Owned by | Enforced by |
|---|---|---|
| Append-only; every device replays the same events to the same state | `js/habits.js` — `replay` | `test/convergence.test.mjs` |
| Order is `min(claim, arrival)`, then `seq`, then id | `js/habits.js` — `orderKey` | `test/sync.test.mjs`, `test/clock.test.mjs` |
| Duplicates are idempotent | `js/habits.js` — `replay` | `test/convergence.test.mjs` |
| An unknown event type is inert, never fatal | `js/schema.js` — `isKnown` | `test/legacy.test.mjs` |
| A reading is sent once and not again | `js/ingest.js` | `test/ingest.test.mjs`, `app/src/test/.../PushThrottleTest.kt` |

## The shell, which only observes

| Rule | Owned by | Enforced by |
|---|---|---|
| Native emits observations, never verdicts | `habit/PauseSource.kt` | `app/src/test/.../PauseMetricsTest.kt` |
| A day Pause did not witness reports nothing, not zero | `data/Prefs.kt` — `observedOn` | `.../UnwitnessedDayTest.kt` |
| A streak day must be witnessed before it can be won | `data/Streak.kt` | `.../StreakTest.kt` |
| Sleep is the longest quiet gap, ended by the first UNLOCK | `data/QuietGap.kt` | `.../QuietGapTest.kt` |
| A gap is a night only if it covers 03:00 and runs 3–14 hours | `data/SleepEstimate.kt` | `.../SleepEstimateTest.kt` |
| A window appearing is not an app being opened | `service/Arrival.kt` | `.../ArrivalTest.kt` |
| A split screen keeps the clock running | `service/ScreenShare.kt` | `.../VisitTest.kt` |
| A slider drag is one decision, not forty | `data/Deferred.kt` | `.../SliderCommitTest.kt`, `.../DeferredTest.kt` |
| `service/` may never import `habit/` — `ForegroundPulse` is the seam | `data/ForegroundPulse.kt` | `.../LayeringTest.kt` |

## Notifications

| Rule | Owned by | Enforced by |
|---|---|---|
| Everything daily is nudged together at 8pm, pinned | `habit/HabitReminder.kt` — `DEFAULT_MINUTE_OF_DAY` | `.../DailyNudgeTest.kt` |
| Weekly and monthly carry their own time and days | `js/ui/goals.js`, `habit/HabitReminder.kt` | `test/personal.test.mjs`, `.../DailyNudgeTest.kt` |
| A monthly reminder lands at month end | `habit/HabitReminder.kt` — `nextMonthEndAt` | `.../DailyNudgeTest.kt` |
| Travel silences reminders by MOVING them, never cancelling | `habit/HabitReminder.kt` — `notBefore` | `.../DailyNudgeTest.kt` |
| Minor streaks batch into one notice; only major badges get a solo | `js/notices.js` | `test/notices.test.mjs` |
| A notice is posted exactly once | `habit/HabitNotices.kt` | `.../HabitNoticesTest.kt` |

## The seam between the two halves

Both directions have a drift guard, and both exist because a field once crossed in one direction
only. These are the tests to add to when either side gains a field.

| Rule | Owned by | Enforced by |
|---|---|---|
| Every capability the shell announces is read by the page | `js/bridge.js` — `installBridge` | `test/bridge.test.mjs` |
| Every field the shell parses is one the page sends | `js/bridge.js` — `setSyncConfig` | `test/personal.test.mjs` |
| The summary the shell draws from carries everything it reads | `js/summary.js` | `test/summary.test.mjs` |
| The training record crosses already worded — "12 reps", "Tue, Sep 8" — never as a value and a unit | `js/summary.js` — `trainingSummary` | `test/summary.test.mjs`, `.../HabitSummaryTrainingTest.kt` |
| The week crosses as XP with the bonus beside it; an older summary falls back to the average | `js/summary.js` — `board` | `test/summary.test.mjs`, `.../HabitSummaryBonusTest.kt` |
| The level crosses as the sentence and the two bar numbers; the shell never learns the curve | `js/summary.js` — `lifetimeSummary` | `test/summary.test.mjs`, `.../HabitSummaryLifetimeTest.kt` |
| What the sync read is repeated back in lines a person can read | `habit/HabitSyncWorker.kt` — `syncReport`, `readValue` | `.../SyncReportTest.kt` |
| A row from the shell survives the web engine unchanged | `js/ingest.js` | `test/wire.test.mjs` |
| A setup code means the same thing in both languages | `js/setup-code.js` | `test/setup-code.test.mjs`, `.../SetupCodeTest.kt` |

---

## Decisions this file deliberately does not explain

Rationale belongs next to the code it justifies, in the header comment of the module that owns the
rule. If you want to know *why* rather than *where*, those comments are the source — they are long
on purpose and they sit where a person changing the rule will read them.

The four worth knowing before changing anything:

- **Why 40 / 30 / 15 / 15** — `js/score.js`
- **Why travel cannot be backdated when a log can** — `js/habits.js`, the `T.EXEMPT` case
- **Why an automatic source going quiet is NO_DATA and a manual one is a MISS** — `js/habits.js`
- **Why the shell may never decide anything** — `habit/PauseSource.kt`

## Adding a rule

1. Put it in a module that owns it, with the reasoning in the header.
2. Give it a test that drives the real thing, not a copy of the rule.
3. Add one line here.

If you find yourself writing a rule that already exists somewhere else, extract it instead — that
is what `js/edits.js`, `data/QuietGap.kt` and `service/Arrival.kt` all are. Two copies is how every
bug in the list at the top of this file happened.
