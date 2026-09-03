# Habit

Group habit tracking for a close-knit group of friends — the web layer of the [Pause](https://github.com/Sai023) Android app.

Pause is the shell: it owns the AccessibilityService, Health Connect, exact local alarms and the
breathe-screen intervention, because none of those exist on the web. This repo is everything
above that line — the dashboard, the leaderboard, the habit settings, and the engine that decides
what a streak is. It loads in a WebView inside Pause, so the UI ships from Vercel in seconds
instead of through a signed release on three phones.

Status: **Phase 1.** Engine, sync layer and dashboard are in. Group setup is the next screen.

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
npm test    # 42 tests, no install step
npm run dev # http://localhost:5174
```

No dependencies and no test runner: the engine is pure, so node built-ins are enough and CI needs
no install step. The tests are the specification — each case is a decision argued for during
design review. If one fails, a rule changed; change it on purpose.

`?demo=1` replays a generated three weeks through the real engine, so the states that take weeks
to occur naturally — a spent grace token, a watch that went quiet — can be looked at now. Nothing
is faked and nothing is stored: if the leaderboard is wrong there, it is wrong in production.

The UI is hand-written CSS rather than Tailwind, unlike Passport. Passport has dozens of screens
and earns a utility framework; this has three, and zero dependencies is worth more. The palette is
Pause's to the hex, because this renders in a WebView inside that app and "close but different"
reads as a bug.

## Data sources

The metric a habit measures is group-wide; the **source that supplies it is per member**. The same
"Steps" habit is fed by Health Connect on two phones and typed in on a third, and that difference
decides whether a silent day reads as `NO_DATA` or as a real miss. See `T.BINDING`.

There is no separate Samsung Health integration and there does not need to be: Samsung Health
writes into Health Connect on One UI 6+, so reading Health Connect covers it.

`ingest.js` decides what a sensor poll is allowed to write, and it is deliberately stingy. Health
Connect re-reports the day's running total on every read, so appending each one would put roughly
300k rows a year into a log that every device replays on open. **The log records the day's
outcome, not the day's telemetry** — a reading is written only when it is the first of the day,
flips the verdict, backfills a closed day, or the throttle has expired. Live numbers on today's
card come from the sensor, not the log.

## Layout

```
js/schema.js         event vocabulary, versioning, defaults
js/habits.js         the pure engine — day status, streaks, grace, leaderboard
js/ingest.js         pure: sensor readings -> the events worth writing
js/id.js             UUIDs (real ones — the events PK is typed uuid) and group codes
js/db.js             IndexedDB: events, queue, meta
js/store.js          command layer + memoised derived state
js/sync.js           local-first sync engine with a circuit breaker
js/sync-adapter.js   Supabase RPC transport (no SDK)
js/bridge.js         the web half of the HabitBridge contract with Pause
js/dom.js            a 30-line element helper; no framework
js/app.js            bootstrap: demo state or the device's own log
js/ui/dashboard.js   Today, Board and Habits
js/ui/format.js      how a number is spoken (7h 05m, not 425)
js/ui/demo.js        a believable three weeks, for review without a backend
test/                the rules, as executable specification
```

`config.js` is blank on purpose — fill in the Supabase URL and **publishable** key to enable sync.
A group code is not configuration: it is the capability that grants access to one room, so it
lives on the device and must never be committed.
