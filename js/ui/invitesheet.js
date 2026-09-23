// invitesheet.js — the string you send somebody so they can join.
//
// ---- Why this screen exists ----
//
// The invite used to be shown exactly once, on the last screen of onboarding, and then never
// again. So the only pasteable code anybody could still find afterwards was their own SETUP code —
// which carries their member id and turns whoever uses it into them. That is not hypothetical: a
// second phone joined the group and appeared as its owner, because the only code left to send was
// the one guaranteed to do that.
//
// A thing you need every time somebody new joins cannot live on a screen you can only reach before
// anybody has.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { inviteCode } from "../store.js";
import { inviteLink } from "../setup-code.js";

export function openInviteSheet(host, { groupCode, onClosed } = {}) {
  const sheet = openSheet(host, { onClose: () => { if (onClosed) onClosed(); } });
  let code = "";
  let link = "";

  function copyButton(text, label, kind = "ghost") {
    const button = el("button." + kind, {
      onclick: async () => {
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = "Copied ✓";
          setTimeout(() => { button.textContent = label; }, 1600);
        } catch {
          // Clipboard access can be refused, and a button that silently does nothing reads as
          // broken. Say so, so they copy it by hand instead of tapping again.
          button.textContent = "Copy it from above";
        }
      },
    }, label);
    return button;
  }

  function paint() {
    sheet.paint(
      el("div.sheet-head", el("span.sheet-title", "Invite someone")),

      el("p.sheet-now",
        "Send them this. On a phone with Goal Buddy already installed, opening it goes straight " +
          "to joining — nothing to copy or paste."),

      el("div.codebox",
        el("div.codebox-label", "Invite link"),
        el("div.codebox-value", link || "…"),
      ),
      el("div.sheet-actions", copyButton(link, "Copy invite link", "tap")),

      // The distinction that has already gone wrong once, said at the moment somebody is about to
      // share something. Short, because a warning nobody finishes reading protects nobody.
      el("p.codebox-note",
        "Safe to forward — it says where the group lives and nothing about who you are. ",
        el("b", "Don't send your setup code"),
        " (the long one starting HS1). That one means “this phone is me”, and whoever "
        + "pastes it will post as you.",
      ),

      // The link is the same invite underneath, just wrapped in a URL — this is the fallback for a
      // phone where tapping it opens a browser instead of Goal Buddy directly (nothing installed
      // yet, or the app link hasn't been confirmed on that phone).
      el("div.codebox",
        el("div.codebox-label", "Or paste this in Goal Buddy"),
        el("div.codebox-value small", code || "…"),
        el("div.codebox-note", "Habits → Set up habits → paste it in."),
      ),
      el("div.sheet-actions", copyButton(code, "Copy invite code", "ghost")),

      // The short one still matters: it is what somebody joining from a plain browser types, and
      // it is what the room is called in every settings screen and diagnostic.
      groupCode
        ? el("div.codebox",
            el("div.codebox-label", "Group code"),
            el("div.codebox-value", groupCode),
            el("div.codebox-note", "For joining in a browser, and what the group is called in settings."),
          )
        : null,
    );
  }

  paint();
  inviteCode().then((value) => {
    code = value;
    link = inviteLink(typeof location !== "undefined" ? location.origin : "", value);
    paint();
  }).catch(() => { paint(); });

  return sheet;
}
