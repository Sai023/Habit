# Data architecture — quality, hygiene, and the analytics read-model

*How Goal Buddy's data is shaped, why, and how to keep it clean enough to mine for real
behavioural patterns. Written after a live data-repair episode (Sept 2026) that exposed exactly
where the gaps are — every recommendation here is designed against a failure we actually hit.*

---

## 1. The foundation (and why it's the right one)

Goal Buddy is **event-sourced**. The system of record is one append-only `events` table (shared
with Passport, partitioned by a room `trip_code`). Nothing is ever updated in place; every change
is a new immutable event, and a pure engine (`js/habits.js` `replay()`) folds the log into the
state every screen reads. This is already the correct base for behavioural analytics:

- **Immutable history.** You can ask "what was true on any past day" because the facts were never
  overwritten — only appended to.
- **Event-time vs ingest-time are separated.** Each event carries the author's `ts` (when it
  happened) *and* the server's `inserted_at`/`seq` (when it arrived). Analytics that cares about
  *when a thing occurred* uses event-time; ordering uses the server sequence.
- **Everything is derived.** Streaks, scores, the board — all recomputed from the log, so a fixed
  rule fixes history everywhere at once.
- **Payloads are versioned** (`v`), so the shape can evolve without breaking old events.

The gaps are not in the foundation. They are in four areas: **provenance**, **identity**,
**explicit change-modelling**, and — the biggest for insights — a **separation of raw facts from
an analytical read-model**.

---

## 2. What went wrong, and the principle each failure teaches

| What happened | Root cause | Principle |
|---|---|---|
| A vape number meant "puffs" one week and "meter reading" the next | **Semantic drift** — the meaning of `value` changed with nothing recording it | Every event must be self-describing (unit, source, method) |
| One person (Anj) split across three member ids | **Unstable identity** | A person's history must be reconstructable under one identity |
| Delete + re-add forked a new habit id, stranding history | **Identity churn on lifecycle** | Identity must survive the whole lifecycle |
| A correction re-ran and doubled days; a raw `sum` read 400 vs the app's 100 | **Non-idempotent writes** + **querying raw events** | Writes need idempotency keys; analytics needs a replay-correct read-model |
| A clear and its re-log shared a timestamp and replayed in random order | **Non-deterministic ordering** | Order is a correctness property, not a detail |
| Test spikes (3174), a "Wire test" fixture, and streak-gaming entries sat in production | **No quality signalling** | Bad data is flagged and excluded, not deleted |

---

## 3. The analytics read-model (shipped — `js/dailyfacts.js`)

**The headline fix.** Never mine the raw log directly: a `sum(value)` over `habit_log` rows
ignores `habit_log_clear` withdrawals and counts duplicates, so it can read 400 where the app
shows 100. Only replay knows the net. So we project the replayed state into a flat, correct table
of **daily facts** — one row per `(habit, member, day)` — built **once** from the engine's own
`valueOn` / `rawDayStatus` / `targetOn`, and reduce over it.

### The row

```
{ day, habitId, habitName, metric, unit, direction, memberId,
  value,     // net, replay-correct (null if nothing reported)
  target,    // the goal in force that day (after taper/goal changes)
  status,    // HIT | MISS | NO_DATA | EXEMPT
  met, reported,
  source,    // "manual" (typed) | "sensor" (measured) | null  — coarse provenance
  dow, weekday, isoWeek,
  exempt }
```

### The rules it keeps

- **The engine is the single source of truth.** The read-model computes no value of its own; a
  fact can never disagree with what the app shows.
- **Nothing is claimed below a floor.** Correlations need `MIN_PER_SIDE` (5) days each side;
  weekday patterns need `MIN_PER_WEEKDAY` (3) samples. Below the floor the answer is `null`, never
  a guess.
- **Exempt days are not misses.** Travel and booked rest are excluded from met-rates and
  correlations, so a holiday never reads as a collapse.
- **A habit is absent before its birthday** — added last week ≠ a month of silence.

### The patterns it unlocks (all pure reductions over the table)

- `dailyFacts(state, { me, to, from?, habitIds? })` — the table.
- `byWeekday(facts, habitId)` — met-rate and average per weekday; strongest / weakest day.
- `correlate(facts, gateHabitId, subjectHabitId)` — "on the days I held X, was Y better?" Signed
  by the subject's own direction (+ always means better), with an absolute `effect` and a
  scale-free `relative` so links across different metrics compare fairly.
- `topCorrelations(facts, { limit })` — the strongest behavioural links across every pair, best
  first. The surface for a "what actually moves the needle for me" insight.
- `consistency(facts, habitId)` — met-rate, current/longest run, longest gap. Deliberately the
  *raw* view (no grace tokens) — distinct from the board's scored streak.

Tested in `test/dailyfacts.test.mjs`.

### How to use it

```js
import { dailyFacts, topCorrelations, byWeekday } from "./dailyfacts.js";
const facts = dailyFacts(state, { me, to: today });   // build once
const links = topCorrelations(facts);                 // rank behavioural links
const week  = byWeekday(facts, "steps");              // "you're weakest on Fridays"
```

Build the table once per analysis pass and reduce many times — do **not** call the reducers in a
loop that rebuilds `facts` each time.

### Performance note

`dailyFacts` is `habits × days` engine calls (cheap at friend-group scale). Meter/odometer values
scan the member's logs, so at much larger scale the projection should be memoised or materialised
(a nightly job / Postgres view). Time it at real scale before assuming it's free — see the repo's
perf-probe note. The point of the model is that the *expensive* walk happens once and every
pattern after it is a cheap in-memory reduction.

---

## 4. The rest of the roadmap

Done: read-model (§3); soft-delete + restore keeps history; re-add routes to restore.

**Next wave — provenance (make every event self-describing).** Add `unit` and `entryMethod`
(typed / sensor / corrected / backfilled) to log payloads, and formalise `v` into a validated
schema per event type at the write boundary (this is also the poison-event defence). Then the
read-model's `unit`/`source` fields become exact rather than inferred, and analytics can weight by
confidence (sensor > typed > backfilled).

**Next wave — identity.** Member alias/merge events so `person → [ids]` is reconstructable — the
single biggest unlock for per-person longitudinal analysis. Never reuse a habit across a unit
change; model the change explicitly.

**Second wave — change events.** Extend the effective-dated pattern the goal `targets` already use
to unit changes, renames, and exclusions, so "what was true on day D" is always reconstructable.

**Second wave — a materialised read-model.** When the log grows, persist the daily-fact table
(nightly rebuild or a Postgres view) so insight queries are O(rows) and never re-walk replay.

---

## 5. Data hygiene standards

- **Idempotent writes.** A logical entry has a deterministic id (e.g. a hash of
  `habit|member|day|source`), so a re-sync or a re-run is a no-op. Corrections use the app's own
  guarded actions (meter mode, the log sheet) — never raw `push_events` with reused timestamps.
- **Deterministic ordering.** Replay orders on server `seq`; two events must never rely on a
  random tie-break. When correcting by hand, stagger timestamps so intent is unambiguous.
- **Flag, don't delete.** Test rooms, fixtures, and gaming data get an `excludeFromAnalysis`
  marker; a server-side `DELETE` does not propagate to devices that already synced the rows, and
  destroying facts loses the ability to audit. Range validation flags fat-fingers as *suspect*
  rather than trusting or deleting them.
- **Verify by replay-net, never raw rows.** Any check over the raw log must account for
  `habit_log_clear`. The read-model already does; ad-hoc SQL must too.
- **Always back up before a manual repair**, and verify the backup by count, not by eyeballing it
  in a tool that truncates (Excel silently truncates cells over 32,767 characters).

See also `RULES.md` (the invariants) and the in-code memory notes on event repair.
