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
import { showProblem } from "./problem.js";

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
    verify();
  }

  /**
   * Did the sheet actually land somewhere a person can see?
   *
   * Because a backdrop with nothing visible on it is the worst failure this component has: the
   * screen dims, the app looks broken, and there is no error anywhere because nothing threw. That
   * is exactly what the menu did on a phone while rendering perfectly in a browser at the same
   * size — the DOM was right, the CSS was right, and it still could not be seen.
   *
   * So it measures itself. If the sheet has no height, or sits entirely below the fold, the layer
   * switches to a full-height layout that cannot be positioned off-screen, and says so with the
   * numbers in it. A fallback nobody is told about is a second bug hiding the first.
   */
  function verify() {
    // A timer rather than requestAnimationFrame. rAF does not fire while a page is hidden or
    // throttled, and a WebView the shell has moved off-screen is exactly that — so the one check
    // meant to catch an invisible sheet would itself have been skipped in the case it was written
    // for. A short timeout runs either way and layout has settled by then.
    setTimeout(() => {
      if (closed) return;
      const sheet = layer.querySelector(".sheet");
      if (!sheet) return;
      const r = sheet.getBoundingClientRect();
      const vh = window.innerHeight || 0;
      const offScreen = r.height < 24 || r.top >= vh - 8 || r.bottom <= 8;
      if (!offScreen) return;
      layer.classList.add("sheet-stuck");
      showProblem(
        "A panel opened where it can't be seen, so it's been moved. " +
        "Please send this: " + Math.round(r.width) + "×" + Math.round(r.height) +
        " at " + Math.round(r.top) + ", viewport " + vh + ".",
      );
    }, 60);
  }

  return { paint, close, layer };
}
