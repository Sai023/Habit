// sync-adapter.js — the cloud transport the sync engine talks to.
//
// Plain fetch against Supabase's RPC endpoint (PostgREST) — NO SDK, so the app stays
// dependency-free and offline-safe. These two functions are the only things the publishable key
// is permitted to call; the tables themselves have RLS on with no anon policies, so without a
// room's code this key can read nothing.
//
// Adapter contract (see sync.js):
//   push(rows)         -> Promise<void>        rows: {uuid,trip_code,type,author,ts,payload}[]
//   pull(code, since)  -> Promise<serverRow[]> serverRow: {seq,uuid,type,author,ts,payload,inserted_at}
//
// The `trip_code` column name is Passport's, and it is kept verbatim rather than aliased: habit
// events ride in the same table, and renaming the field on the way out would mean forking the
// server-side functions for no gain. Here it carries a HABIT- room code.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export function makeSupabaseAdapter() {
  const base = SUPABASE_URL.replace(/\/+$/, "");
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: "Bearer " + SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  };

  async function rpc(fn, body) {
    const res = await fetch(base + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Attach the status so the engine can tell "the cloud said no" (4xx/5xx → DEGRADED) from
      // "the network vanished" (fetch rejects with TypeError → OFFLINE). They look identical to
      // a user and need completely different messages.
      const err = new Error("Supabase " + fn + " failed: " + res.status);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  return {
    async push(rows) {
      if (!rows.length) return;
      await rpc("push_events", { p_events: rows });
    },
    async pull(code, since) {
      const data = await rpc("pull_events", { p_code: code, p_since: since | 0 });
      return Array.isArray(data) ? data : [];
    },
  };
}
