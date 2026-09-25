# Security testing

Notes and tooling from the pentest of the shared Supabase backend behind Habit (this app) and
Passport, started Sept 2026.

## Status

| Side | Status | Result |
|---|---|---|
| Read (`pull_events`, direct table/view access) | Done, run from Sahil's own machine against the live project (non-destructive) | Solid — zero vulns. RLS-filtered to empty, views grant-locked (401), `p_code` not injectable, REST root locked. Two low-severity hardening notes: one anon key reads both apps' rooms; no rate limit on `pull_events`. |
| Write (`push_events`) | Tooling ready — run it yourself against a throwaway sandbox project | See `pentest-write-side.mjs` |

## Running the write-side probe

**Never run this against the real project.** It writes deliberately forged and malformed events —
exactly what you don't want landing in a room five real friends sync to. The script itself refuses
to run against the real project ref as a second guard, but the sandbox project is the actual safety
boundary, not the guard.

```bash
# 1. supabase.com -> New project (free tier, throwaway)
# 2. SQL Editor -> paste and run ../supabase/schema.sql (skip push.sql, unused by these scenarios)
# 3. Project Settings -> API -> copy the Project URL and the anon/publishable key

SUPABASE_URL="https://xxxx.supabase.co" \
SUPABASE_ANON_KEY="sb_publishable_xxx" \
CONFIRM_SANDBOX=yes \
node security/pentest-write-side.mjs

# 4. Read the output, then delete the sandbox project on supabase.com.
```

Each scenario prints one of:
- **FINDING** — behaves as an attacker would want; either an accepted, documented limit of the
  capability model (see `supabase/schema.sql`'s security note) or something to actually fix.
- **safe** — a defense held (e.g. the client survives a malformed row without a server-side check
  to catch it first).
- **info** — observational, no verdict either way (e.g. the rate-limit probe).

Nothing in the script mutates or reads the real project — every room code it uses is freshly
generated per run and only ever touches whatever sandbox project the env vars point at.

## What's covered

1. **forged-author-destructive-write** — an event claiming to be a different member than the one
   who created a habit can retire it. Confirms `author` is not authenticated; anyone holding a
   room's code can act as anyone in that room.
2. **uninvited-blind-write** — a write succeeds against a room code that was never pulled or shared
   first. Confirms there's no join/handshake step — the code string alone is sufficient, both ways.
3. **poison-event-survives-insert** — a payload that the app's own `validate()` would refuse to
   write locally is still accepted by the database (no server-side schema check) and, once pulled
   back, must not break `replay()` for the rest of the room. This is the regression test for the
   poison-event defence described in `docs/DATA-ARCHITECTURE.md`.
4. **uuid-collision-silent-suppression** — a second push reusing an existing `uuid` is silently
   dropped (`on conflict do nothing`), and confirms the app's own sync layer doesn't check the
   RPC's return value to notice.
5. **rate-limit-probe** — informational only, capped at 20 requests. Not a brute-force attempt;
   just checks whether any platform-level throttling is visible at that volume.

## Why this lives here, not in `npm test`

This suite performs real writes against a real (if disposable) network endpoint and is meant to be
run deliberately, by hand, against infrastructure set up for exactly this purpose. It must never run
in CI or on every `npm test` — there is no default target for it to be safe against.

## Backend DDL

`../supabase/schema.sql` and `../supabase/push.sql` are mirrored copies of the live schema; the
canonical source is `github.com/Sai023/Passport`'s `supabase/` directory, which is where this table
and its RPCs were designed (Habit's events ride in the same project). See the note at the top of
`schema.sql` for why `push_events` behaves the way scenarios 1 and 2 show.
