// setup-code.js — the string you paste into Pause to set up this phone.
//
// ---- Why this exists ----
//
// The web app and the Pause shell each mint their own member id. Left alone, joining a group in
// the browser and then joining again in Pause makes the same person TWO members: the leaderboard
// lists you twice, your Health Connect steps land on one row and anything you tap lands on the
// other. Carrying the id across in one string is what stops that.
//
// It doubles as better setup. The alternative was typing a project URL, a forty-character key, a
// room code and a name into a phone keyboard, four fields, without a typo.
//
// ---- What it is NOT ----
//
// This is NOT the invite. It carries YOUR member id, so sending it to a friend would make them
// post as you. Friends get the group code on its own; each person generates their own setup code
// after joining. The screen says so, and so does this comment, because it is the kind of thing
// somebody helpfully forwards to the group chat.

const PREFIX = "HS1.";

/** UTF-8 safe base64url, so a name with an accent in it survives the round trip. */
function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded) {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Pack this device's identity and connection details into one pasteable string.
 *
 * Keys are single letters because the result is read off one screen and typed or pasted into
 * another, and every character is one more chance to lose the end of it.
 */
export function encodeSetup({ url, key, code, memberId, name, web }) {
  if (!url || !key || !code || !memberId) return "";
  return PREFIX + toBase64Url(JSON.stringify({
    u: url, k: key, c: code, m: memberId, n: name || "", w: web || "",
  }));
}

/** Unpack one. Returns null for anything malformed — a typo must not throw. */
export function decodeSetup(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length)));
    if (!parsed.u || !parsed.k || !parsed.c || !parsed.m) return null;
    return {
      url: String(parsed.u),
      key: String(parsed.k),
      code: String(parsed.c),
      memberId: String(parsed.m),
      name: String(parsed.n || ""),
      // Where this app lives, so a reminder fired by Pause has somewhere to send you.
      web: String(parsed.w || ""),
    };
  } catch {
    return null;
  }
}
