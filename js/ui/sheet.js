// sheet.js — the one bottom sheet, shared by everything that opens one.
//
// Extracted from logsheet.js, which had it inline and got two things right that are easy to get
// wrong the second and third time:
//
//   • It mounts on <body>, NOT on the app root. A sync landing mid-edit repaints the root, and
//     anything living inside it vanishes with the form half filled in. That was a real bug, found
//     by opening the thing rather than reading it.
//   • It dismisses on the backdrop, not only on a button, because a sheet you cannot get out of by
//     tapping beside it feels broken on a phone.
//
// Escape is new here — free on a desktop browser, and the app is still used in one.

import { el, render } from "../dom.js";

/**
 * Open a sheet. Returns a handle: `paint` replaces its contents, `close` dismisses it.
 *
 * `onClose` fires exactly once, however the sheet went away — dismissed or closed by its own
 * button — so callers can refresh on the way out without tracking which happened.
 */
export function openSheet(host = document.body, { onClose } = {}) {
  let closed = false;

  const layer = el("div.sheet-layer", {
    onclick: (e) => { if (e.target === layer) close(); },
  });

  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  host.append(layer);

  function close() {
    if (closed) return; // dismissing twice must not fire onClose twice
    closed = true;
    document.removeEventListener("keydown", onKey);
    layer.remove();
    if (onClose) onClose();
  }

  function paint(...children) {
    render(layer, el("div.sheet", el("div.sheet-grip"), ...children));
  }

  return { paint, close, layer };
}
