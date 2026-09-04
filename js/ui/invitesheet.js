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

export function openInviteSheet(host, { groupCode, onClosed } = {}) {
  const sheet = openSheet(host, { onClose: () => { if (onClosed) onClosed(); } });
  let code = "";

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
        "Send them this. They open Pause, tap Set up habits, paste it in and join as themselves."),

      el("div.codebox",
        el("div.codebox-label", "Invite"),
        el("div.codebox-value", code || "…"),
      ),
      el("div.sheet-actions", copyButton(code, "Copy invite", "tap")),

      // The distinction that has already gone wrong once, said at the moment somebody is about to
      // share something. Short, because a warning nobody finishes reading protects nobody.
      el("p.codebox-note",
        "Safe to forward — it says where the group lives and nothing about who you are. ",
        el("b", "Don't send your setup code"),
        " (the long one starting HS1). That one means “this phone is me”, and whoever "
        + "pastes it will post as you.",
      ),

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
  inviteCode().then((value) => { code = value; paint(); }).catch(() => { paint(); });

  return sheet;
}
