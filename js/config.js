// config.js — cloud sync configuration.
//
// These are the PUBLIC client values for the Supabase project (Dashboard → Settings → API):
//   SUPABASE_URL      → "Project URL"
//   SUPABASE_ANON_KEY → the "Publishable" key (sb_publishable_…)
//
// The publishable key is PUBLIC BY DESIGN and safe to commit and ship in the browser. The
// database is protected by Row Level Security plus SECURITY DEFINER functions: without a room's
// code this key can read nothing, because the tables are not directly queryable and pull_events
// requires the exact code.
//
// NEVER put the Supabase "Secret" key (sb_secret_…) here — it bypasses all security and must
// stay server-side only. This repo is public; treat anything you paste below as published.
//
// A GROUP CODE is not configuration. It is the capability that grants read and append access to
// one room, so it lives on the device (in IndexedDB) and must never be committed here.
//
// Leave both blank to run fully LOCAL_ONLY — every screen still works, nothing syncs.

// The SAME project Passport uses, deliberately. Habit events ride in its existing events table
// under a HABIT- room code, so push_events/pull_events, the RLS model and — the part that is easy
// to forget — the daily keepalive that stops a free-tier project being paused all cover this app
// for free. A second project would need its own keepalive or it would quietly sleep.

export const SUPABASE_URL = "https://yoydjgkvumxbaxzfbwvp.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_UZKTY0NhHnkuTSRAo7bcoQ_SGjoTcag";

export const cloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
