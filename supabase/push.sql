-- Mirrored copy — see schema.sql in this same directory for provenance and the pentest note.
-- CANONICAL SOURCE: github.com/Sai023/Passport, supabase/push.sql.
--
-- Habit does not currently use web push (no service registers through save_push_sub), but this
-- table lives in the same project Habit's events ride in, so it is mirrored here for a complete
-- picture of what the shared publishable key can reach. Last confirmed matching Passport: 2026-09-25.
--
-- Passport — Web Push subscriptions for group notifications.
-- Run ONCE in the Supabase SQL Editor (after schema.sql). Safe to re-run (idempotent).
--
-- Model: like the events table, the trip_code is the capability. Devices register their push
-- subscription per trip via the anon RPC below (no direct table access). The SENDER of a push is
-- the Vercel /api/notify function using the service_role key (which bypasses RLS) — the anon key
-- can NEVER read subscriptions, so a leaked trip code can't be used to spam the group's devices.

create table if not exists public.push_subs (
  endpoint    text not null,           -- unique per browser/device (from PushSubscription)
  trip_code   text not null,           -- the room this device wants notifications for
  p256dh      text not null,           -- subscription public key (for payload encryption)
  auth        text not null,           -- subscription auth secret
  author      text,                    -- who they are on the trip (for personalized bodies)
  updated_at  timestamptz not null default now(),
  primary key (endpoint, trip_code)    -- one device can subscribe to many trips
);
create index if not exists push_subs_code_idx on public.push_subs (trip_code);

alter table public.push_subs enable row level security;
-- (Intentionally NO policies for role `anon` → direct REST access is denied. Use the RPCs;
--  reading subscriptions is service_role-only, done server-side by /api/notify.)

-- Register / refresh a device's subscription for a trip (idempotent on endpoint+trip_code).
create or replace function public.save_push_sub(p_code text, p_endpoint text, p_p256dh text, p_auth text, p_author text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.push_subs (endpoint, trip_code, p256dh, auth, author)
  values (p_endpoint, p_code, p_p256dh, p_auth, p_author)
  on conflict (endpoint, trip_code) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, author = excluded.author, updated_at = now();
end; $$;

-- Unsubscribe this device from ALL trips (called when the user turns notifications off).
create or replace function public.delete_push_sub(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin delete from public.push_subs where endpoint = p_endpoint; end; $$;

revoke all on function public.save_push_sub(text, text, text, text, text) from public;
revoke all on function public.delete_push_sub(text) from public;
grant execute on function public.save_push_sub(text, text, text, text, text) to anon;
grant execute on function public.delete_push_sub(text) to anon;
