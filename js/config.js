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

export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";

export const cloudConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
