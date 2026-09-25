-- Mirrored copy — Habit rides the same Supabase project and `events` table as Passport.
--
-- CANONICAL SOURCE: github.com/Sai023/Passport, supabase/schema.sql. That repo is where this
-- table and these two RPCs were designed and where changes should be made first. This copy exists
-- so a security review of the Habit repo alone doesn't have to go find a second repo to see the
-- server-side enforcement its own security model depends on (see js/config.js, js/sync-adapter.js).
--
-- If you change the live schema, update BOTH copies in the same sitting — there is no automation
-- keeping them in sync. Last confirmed matching the Passport copy: 2026-09-25.
--
-- Passport — Supabase schema for Trip-Code sync.
-- Run this once in your Supabase project: Dashboard → SQL Editor → paste → Run.
--
-- Security model (no user accounts): the trip_code is the capability. The events table
-- has RLS enabled with NO anon policies, so the table itself is NOT directly readable or
-- writable by the public anon key. All access goes through two SECURITY DEFINER functions:
--   • pull_events(code, since) — returns rows ONLY for a code you already know (no enumeration)
--   • push_events(events)      — inserts rows; idempotent on uuid (safe to resend)
-- This means: without a trip's code you cannot read that trip. Knowing a code lets you read
-- and append to that one room — exactly the "share a link + code" trust model we want.
--
-- ⚠️ SECURITY NOTE (Habit pentest, Sept 2026) — push_events performs NO check that the caller
-- has ever pulled, joined, or otherwise proven membership in `trip_code` before inserting; the
-- code is read straight out of each row's own JSON. Symmetric with pull_events (which likewise
-- just filters by whatever p_code string it's given), this is the INTENDED capability model, not
-- a bug: "knowing the string" is the whole authorization scheme by design. Two consequences worth
-- being explicit about because they are easy to forget once the model feels natural:
--   1. Nothing ties `author` to any real identity — any device holding a room's code can write an
--      event claiming to be any other member of that room, including destructive types
--      (habit_def_delete, habit_log_clear, habit_member_merge). A compromised or leaked code is a
--      full-room compromise, not a single-member one.
--   2. There is no rate limit on either RPC at the database layer, so guessing is bounded only by
--      Supabase's own platform-level throttling (if any) plus the ~30 bits of code entropy.
-- See security/pentest-write-side.mjs in this repo for a runnable demonstration against a
-- throwaway sandbox project (never against this live project).

-- ---- Table --------------------------------------------------------------------
create table if not exists public.events (
  seq         bigint generated always as identity primary key,  -- server order = pull cursor
  uuid        uuid not null unique,                             -- client-generated event id (idempotent)
  trip_code   text not null,
  type        text not null,
  author      text,
  ts          bigint not null,                                  -- client event time (ms since epoch)
  payload     jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now()
);

create index if not exists events_code_seq_idx on public.events (trip_code, seq);
-- Extra indexes so future analytics queries (by kind / over time) stay fast.
create index if not exists events_code_type_idx  on public.events (trip_code, type);
create index if not exists events_inserted_at_idx on public.events (inserted_at);

alter table public.events enable row level security;
-- (Intentionally no policies for role `anon` → direct REST access is denied. Use the RPCs.)

-- ---- Push: idempotent bulk insert ---------------------------------------------
create or replace function public.push_events(p_events jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  with rows as (
    select
      (e->>'uuid')::uuid       as uuid,
      e->>'trip_code'          as trip_code,
      e->>'type'               as type,
      e->>'author'             as author,
      (e->>'ts')::bigint       as ts,
      coalesce(e->'payload', '{}'::jsonb) as payload
    from jsonb_array_elements(p_events) as e
  ),
  ins as (
    insert into public.events (uuid, trip_code, type, author, ts, payload)
    select uuid, trip_code, type, author, ts, payload from rows
    on conflict (uuid) do nothing        -- resending the same event is a no-op
    returning 1
  )
  select count(*)::int into inserted from ins;
  return inserted;
end;
$$;

-- ---- Pull: everything in a room newer than the caller's cursor -----------------
create or replace function public.pull_events(p_code text, p_since bigint)
returns setof public.events
language sql
security definer
set search_path = public
as $$
  select *
  from public.events
  where trip_code = p_code
    and seq > coalesce(p_since, 0)
  order by seq asc
  limit 1000;
$$;

-- ---- Grants: anon may ONLY call the two functions -----------------------------
revoke all on function public.push_events(jsonb) from public;
revoke all on function public.pull_events(text, bigint) from public;
grant execute on function public.push_events(jsonb) to anon;
grant execute on function public.pull_events(text, bigint) to anon;

-- ============================================================================
-- Analytics (optional, forward-looking) — OWNER-ONLY.
-- These read-only views flatten the append-only event log for reporting (spend
-- per trip / per person / over time, category via description, activity/audit).
-- They are intentionally NOT granted to `anon`, so the public key can never use
-- them to bypass the trip-code model. Query them from the SQL Editor or with the
-- service_role key (both bypass RLS). Nothing here changes app behaviour.
--
-- These two views are Passport's own (expense/activity shape) and are irrelevant to Habit's
-- data, but are included here unmodified so this file stays an exact mirror of the live DDL.
-- ============================================================================

create or replace view public.v_expenses with (security_invoker = on) as
with latest as (
  select distinct on (e.payload->>'expenseId')
    e.payload->>'expenseId'                                as expense_id,
    e.trip_code,
    (e.payload->>'amount')::numeric                        as amount_local,   -- trip's local currency (e.g. THB)
    e.payload->>'enteredCurrency'                          as entered_currency,
    e.payload->>'note'                                     as description,
    e.payload->>'paidBy'                                   as paid_by,
    e.payload->>'splitMode'                               as split_mode,
    e.payload->'shares'                                    as shares,
    e.payload->'splitAmong'                                as split_among,
    to_timestamp((e.payload->>'spentAt')::bigint / 1000.0) as spent_at,
    e.author                                               as last_edited_by,
    e.inserted_at                                          as last_change_at
  from public.events e
  where e.type in ('add_expense', 'edit_expense')
  order by e.payload->>'expenseId', e.seq desc
)
select l.*
from latest l
where not exists (
  select 1 from public.events d
  where d.type = 'delete_expense' and d.payload->>'expenseId' = l.expense_id
);

create or replace view public.v_activity with (security_invoker = on) as
select
  trip_code,
  type,
  author,
  to_timestamp(ts / 1000.0)         as at,
  payload->>'expenseId'             as expense_id,
  payload->>'note'                  as description,
  (payload->>'amount')::numeric     as amount_local,
  inserted_at
from public.events
where type in ('add_expense', 'edit_expense', 'delete_expense', 'record_payment', 'delete_payment')
order by seq desc;

revoke all on public.v_expenses from anon, authenticated;
revoke all on public.v_activity from anon, authenticated;
