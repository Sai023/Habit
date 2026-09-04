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
// ---- Two codes, and the difference is the whole point ----
//
//   HS1.  a SETUP code. Carries YOUR member id: it says "this phone is me". Never share it —
//         whoever pastes it becomes you, posts as you, and your leaderboard row becomes two
//         people's numbers added together.
//
//   HI1.  an INVITE. Carries where the group lives and nothing about who you are, so whoever
//         pastes it joins as THEMSELVES. This is the one you send.
//
// They were not always both here, and the missing one cost exactly what you would expect: with no
// invite that Pause could read, the only pasteable string in existence was a setup code, so the
// natural thing to send a friend was the one string guaranteed to turn them into you. A second
// phone joined the group and appeared as its owner.
//
// Same shape, different prefix, because these have opposite security properties and a person
// holding two lookalike blobs will eventually forward the wrong one. A prefix is something the
// screen, the parser and the error message can all name out loud.

const PREFIX = "HS1.";
const INVITE_PREFIX = "HI1.";

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

/**
 * Pack where the group lives, and deliberately nothing about who you are.
 *
 * No member id, and that absence is the feature: Pause mints a fresh one for whoever pastes this,
 * so the same invite can go to the whole group chat and every phone that uses it arrives as its
 * own person. Nothing here is a secret — the key is the publishable one that ships in the browser,
 * and the room code is a capability the invite is explicitly granting.
 */
export function encodeInvite({ url, key, code, web }) {
  if (!url || !key || !code) return "";
  return INVITE_PREFIX + toBase64Url(JSON.stringify({
    u: url, k: key, c: code, w: web || "",
  }));
}

/** Unpack one. Returns null for anything malformed — a typo must not throw. */
export function decodeInvite(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(trimmed.slice(INVITE_PREFIX.length)));
    if (!parsed.u || !parsed.k || !parsed.c) return null;
    return {
      url: String(parsed.u),
      key: String(parsed.k),
      code: String(parsed.c),
      web: String(parsed.w || ""),
    };
  } catch {
    return null;
  }
}

/** Which of the two this is, for a screen that has to say why it will not take one. */
export function codeKind(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith(INVITE_PREFIX)) return "invite";
  if (trimmed.startsWith(PREFIX)) return "setup";
  return null;
}
