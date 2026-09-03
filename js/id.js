// id.js — one id generator for the whole app.
//
// It has to produce a REAL RFC-4122 UUID, because the events table types its primary key as
// `uuid` and Postgres rejects anything else. A fallback that emits some other shape means: every
// push 400s, the circuit breaker trips, the app quietly reports "Local", and the group's sync is
// dead with nothing but a console warning to say so. That failure never shows up in testing,
// because randomUUID exists on the machine you develop on.
//
// It is missing more often than you would think. randomUUID requires a SECURE CONTEXT, so any
// plain-http origin (a LAN address during development) loses it even in a current browser — and
// an Android WebView served over http would too. crypto.getRandomValues is ancient and available
// in non-secure contexts, so the fallback below is always reachable.

/** Format 16 random bytes as an RFC-4122 v4 UUID. Pure, so the fallback is testable. */
export function uuidFromBytes(bytes) {
  const b = Uint8Array.from(bytes);
  if (b.length !== 16) throw new Error("uuidFromBytes needs exactly 16 bytes");
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-"
    + hex.slice(16, 20) + "-" + hex.slice(20);
}

/** A new UUID. Native where available, otherwise built from getRandomValues — never a fake. */
export function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)));
}

// Unambiguous alphabet: no I/O/0/1, so a code read aloud or typed from a screenshot survives.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A human-shareable group code, e.g. "HABIT-7Q2XK9".
 *
 * This IS the cloud-room key, so it doubles as the shared secret — six random characters from a
 * 32-letter alphabet is ~30 bits, which is plenty to keep a friends-group room un-guessable.
 * There is no account system: knowing the code lets you read and append to this one room and
 * nothing else, and not knowing it reveals nothing at all.
 *
 * The HABIT- prefix also keeps habit rooms visibly distinct from Passport's trip rooms, which
 * share the same table.
 */
export function groupCode() {
  const rand = Array.from({ length: 6 }, () => {
    const i = crypto.getRandomValues(new Uint32Array(1))[0] % ALPHABET.length;
    return ALPHABET[i];
  }).join("");
  return "HABIT-" + rand;
}

/** Is this a plausibly-shaped group code? Cheap guard before we go near the network. */
export function isGroupCode(code) {
  return /^HABIT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(String(code || "").trim().toUpperCase());
}
