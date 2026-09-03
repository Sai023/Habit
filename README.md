# Habit

Group habit tracking for a close-knit group of friends — the web layer of the [Pause](https://github.com/Sai023) Android app.

Pause is the shell: it owns the AccessibilityService, Health Connect, exact local alarms and the
breathe-screen intervention, because none of those exist on the web. This repo is everything
above that line — the dashboard, the leaderboard, the habit settings, and the engine that decides
what a streak is. It loads in a WebView inside Pause, so the UI ships from Vercel in seconds
instead of through a signed release on three phones.

Status: **Phase 1.** The engine and its test suite are done. No UI yet.

## Architecture

```
Pause APK (Kotlin) ── AccessibilityService · Health Connect · AlarmManager · widget
        │
   HabitBridge ── 7 methods, versioned. Native emits OBSERVATIONS, never verdicts.
        │
   WebView → this repo ── dashboard · leaderboard · settings · streak engine · sync
        │
   Supabase public.events ── the same append-only table Passport uses
```

Habit events ride in Passport's existing `events` table under a `HABIT-` room code, so
`push_events` / `pull_events`, the RLS model, the per-room cursors and the daily keepalive all
work here with no new SQL. Every type is prefixed `habit_`; every payload carries a version.

## The engine

`js/habits.js` is pure — no storage, no network, no DOM. Given the event log it derives every
number the UI shows, and every device derives the same ones.

That is deliberate, and it is the single most important decision in the project. Events arrive
**out of order**: the offline queue drains days late, a watch backfills last night's sleep this
morning. A database trigger fires in *insert* order, so it would burn a grace token on a Tuesday
that turns out to have been completed. Walking days in *calendar* order on read is correct under
any arrival order.

### Four states, not two

| State | Meaning |
| --- | --- |
| `HIT` | the day's value met the target, direction-aware |
| `MISS` | it did not, and we could tell |
| `NO_DATA` | an automatic source reported nothing — never breaks a streak, never counts as a hit |
| `EXEMPT` | a rest day, Travel Mode, or a grace token spent |

`NO_DATA` carries the design. An automatic source that says nothing means the *pipeline* was
silent, which is not the same as the user failing; a manual habit with no entry is a real miss,
because logging it was the whole task. Without that distinction the friend with the older phone
and the harder sync path loses their streak — and the leaderboard's clown tag — to a watch
outage rather than to anything they did.

### Rules worth knowing

- **Day keys, not dates.** `dayKey(ts, tz, dayStartHour)` uses a *pinned* timezone so travel
  cannot stretch a day, and a 04:00 default start so a 01:00 log belongs to yesterday.
- **Grace tokens** are earned by clean running (1 per 7 days), capped (2), and spent
  *automatically*. Uncapped you would bank 52 a year and the streak would stop meaning anything.
- **Travel Mode** exempts a range outright rather than draining the bank.
- **Today is never judged a miss** while it is still running; it counts the moment it is won.
- **Backfill is capped at 2 days**, keyed off when the observation was made rather than when it
  synced — so a week offline still backfills, but last week's crown is not winnable on Tuesday.
- **Reduce habits opt out of scoring** by default. Being bottom of a quitting metric produces
  hidden and falsified logs, not quitting.
- **The clown is suppressed, never promoted.** If the bottom row had a silent pipeline, the week
  has no clown at all — moving the tag to the person above them would punish a better week.

## Develop

```bash
npm test
```

No dependencies and no test runner: the engine is pure, so node built-ins are enough and CI needs
no install step. The tests in `test/habits.test.mjs` are the specification — each case is a
decision argued for during design review. If one fails, a rule changed; change it on purpose.

## Layout

```
js/schema.js    event vocabulary, versioning, defaults
js/habits.js    the pure engine — day status, streaks, grace, leaderboard
test/           the rules, as executable specification
```
