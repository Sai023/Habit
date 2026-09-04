// confirmsheet.js — "are you sure", asked by the app rather than by the browser.
//
// ---- Why this is not window.confirm ----
//
// Because window.confirm does not exist here. An Android WebView with no WebChromeClient
// SUPPRESSES alert, confirm and prompt — confirm returns false immediately, without showing
// anything. So this guard:
//
//     if (!confirm("Delete this habit?")) return;
//
// read as "the user said no" on every phone in the group, every time, and deleting a habit
// silently did nothing. It worked perfectly in a desktop browser, which is why it survived.
//
// The shell now installs a WebChromeClient so the native dialogs work at all. This exists anyway,
// because a destructive action should not depend on one: a system alert in a dark themed app looks
// like it belongs to something else, it blocks the thread while it is open, and it cannot say
// which habit is about to go.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";

/**
 * Ask, and resolve true only if they actually chose the destructive option.
 *
 * Dismissing — the backdrop, the back gesture, anything that is not the button — resolves FALSE.
 * Silence is never consent for something that cannot be undone.
 */
export function confirmSheet(host, { title, body, confirmLabel = "Delete", cancelLabel = "Keep it" }) {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };

    const sheet = openSheet(host, { onClose: () => finish(false) });

    sheet.paint(
      el("div.sheet-head", el("span.sheet-title", title)),
      body ? el("p.sheet-now", body) : null,
      el("div.sheet-actions",
        el("button.ghost", { onclick: () => { finish(false); sheet.close(); } }, cancelLabel),
        el("button.tap.danger", { onclick: () => { finish(true); sheet.close(); } }, confirmLabel),
      ),
    );
  });
}
