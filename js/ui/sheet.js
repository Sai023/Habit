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
 * How tall the window really is, as opposed to how tall it says it is.
 *
 * Inside Pause the page is hosted in a WebView that Compose measures with WRAP_CONTENT, so the
 * view grows to the height of its own CONTENT and is then clipped to the box it is given. The page
 * has no idea: window.innerHeight reports that oversized height, `position: fixed; inset: 0`
 * faithfully spans it, and anything anchored to the bottom — every sheet in this app — lands below
 * the visible edge. Only the top forty pixels of it ever showed, which reads as "the button does
 * nothing" and dims the screen for good measure.
 *
 * The screen is the check, because the layout viewport cannot be larger than the display and still
 * be honest. When it is, the excess is the part being clipped away.
 */
/**
 * What the shell measured, when there is a shell.
 *
 * Read off the window rather than imported from bridge.js, deliberately. This module is loaded by
 * dynamic import, and a dynamic import can be served from a DIFFERENT service-worker generation
 * than the page that asked for it — so a static import of a newly added symbol is not a missing
 * feature, it is a hard module error that takes the whole screen down. It did exactly that: a page
 * running yesterday's bridge, asked for today's sheet, and every sheet in the app died on
 * "does not provide an export named 'shellViewportHeight'".
 *
 * A global is simply absent on an old build, which is what degrading gracefully looks like.
 */
function toldHeight() {
  const h = typeof window !== "undefined" ? Number(window.__shellViewport) : 0;
  return Number.isFinite(h) && h > 0 ? h : 0;
}

export function visibleHeight() {
  const told = toldHeight();
  if (told > 0) return told;

  // Otherwise: a layout viewport cannot be taller than the display and still be honest. This is a
  // guess and it was not a good enough one on its own — the overshoot on a real phone turned out
  // to be roughly the height of the navigation bar rather than the whole page, which is well
  // inside any sensible threshold. It stays as a floor under the case where the shell is too old
  // to report, and the sheet anchors to the TOP whenever it fires, because the top of the viewport
  // is the one place guaranteed to be on screen no matter how much is being clipped off the
  // bottom.
  const inner = window.innerHeight || 0;
  const screenH = (window.screen && window.screen.height) || 0;
  if (!screenH || inner <= screenH) return inner;
  return screenH;
}

/**
 * Open a sheet. Returns a handle: `paint` replaces its contents, `close` dismisses it.
 *
 * `onClose` fires exactly once, however the sheet went away — dismissed or closed by its own
 * button — so callers can refresh on the way out without tracking which happened.
 */
export function openSheet(host = document.body, { onClose } = {}) {
  let closed = false;

  // Tapping the backdrop dismisses. DRAGGING across it does not — which is not the same thing,
  // and the difference is the whole of a real complaint: a sheet that does not fill the screen
  // leaves backdrop above it, a finger swiping down starts there, and the browser reports the
  // whole gesture as a click on the backdrop. Trying to scroll the page behind, or just moving
  // your thumb, closed the sheet.
  let downAt = null;
  const layer = el("div.sheet-layer", {
    onpointerdown: (e) => { downAt = { x: e.clientX, y: e.clientY }; },
    onclick: (e) => {
      if (e.target !== layer) return;
      const from = downAt;
      downAt = null;
      // A tap wanders a few pixels; a swipe does not stay inside ten.
      if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) return;
      close();
    },
  });

  // Pin the layer to the part of the window that can actually be seen. On a normal browser the two
  // agree and these lines change nothing.
  const visible = visibleHeight();
  const mismatch = visible > 0 && Math.abs(visible - (window.innerHeight || 0)) > 1;
  if (mismatch) {
    layer.style.height = visible + "px";
    layer.style.bottom = "auto";
    // Anchored from the top when the numbers disagree and nothing has told us the true height.
    // A bottom-anchored sheet is only as right as the height it is measured against; the top of
    // the viewport is where the view begins whatever it was sized to.
    if (toldHeight() <= 0) layer.classList.add("sheet-stuck");
  }

  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  host.append(layer);
  attachDrag(layer, close);

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
      // Measured against what is visible, not against what the window claims. Comparing with
      // innerHeight was why this check stayed quiet through the exact bug it was written for: the
      // sheet was inside the reported viewport and nowhere near the screen.
      const vh = visibleHeight();
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

// ---------------------------------------------------------------------------
// Drag down to dismiss
// ---------------------------------------------------------------------------

/** Far enough down to mean it, or a flick fast enough to mean it sooner. */
const DISMISS_PX = 96;
const FLICK_VELOCITY = 0.5;   // px per ms
const FLICK_MIN_PX = 28;

/**
 * Pull the sheet down to close it.
 *
 * ---- What this has to avoid ----
 *
 * The panel scrolls itself — `max-height: 88vh; overflow-y: auto` — so a downward drag is already
 * a meaningful gesture inside it. Stealing every one of them would make a long sheet, which is
 * most of them, impossible to read. So the drag only begins at the top of the scroll, which is the
 * one place a downward pull cannot mean "scroll up".
 *
 * It is delegated from the layer rather than bound to the panel, because `paint()` replaces the
 * panel wholesale on every repaint and a handler bound to the old one would go with it.
 *
 * The finger tracks 1:1 while dragging. Rubber-banding or easing the follow feels considered on a
 * page and wrong here: this is a physical object being moved, and anything other than "it is where
 * your thumb is" reads as lag.
 */
function attachDrag(layer, close) {
  let panel = null;
  let startY = 0;
  let startAt = 0;
  let dy = 0;
  let dragging = false;

  const panelAt = (target) => (target && target.closest ? target.closest(".sheet") : null);

  layer.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    const p = panelAt(e.target);
    // Not on the panel is the backdrop's business, and it has its own tap handling.
    if (!p) return;
    // Mid-scroll. A pull from here means "show me what is above", not "put this away".
    if (p.scrollTop > 0) return;
    // A control that is about to be used. Dragging off a stepper or a time field would fight it.
    if (e.target.closest("input, select, textarea")) return;
    panel = p;
    startY = e.clientY;
    startAt = e.timeStamp;
    dy = 0;
    dragging = false;
  });

  layer.addEventListener("pointermove", (e) => {
    if (!panel) return;
    const delta = e.clientY - startY;

    if (!dragging) {
      // Upward, or not yet decisive. Let it be a scroll until it is clearly not one.
      if (delta <= 6) { if (delta < -6) panel = null; return; }
      dragging = true;
      panel.style.transition = "none";
      // Capture so the drag survives the finger leaving the panel — which it does on any dismiss
      // that travels far enough to matter. Guarded because a pointer id that was never really
      // captured throws, and losing the capture is a worse gesture rather than a broken one.
      try { panel.setPointerCapture(e.pointerId); } catch { /* keep dragging without it */ }
    }

    dy = Math.max(0, delta);
    panel.style.transform = "translateY(" + dy + "px)";
    // The ground goes with it, so the sheet reads as lifting away rather than sliding off a
    // backdrop that stays put.
    layer.style.opacity = String(Math.max(0.35, 1 - dy / 520));
    e.preventDefault();
  }, { passive: false });

  function release(e) {
    if (!panel) return;
    const p = panel;
    const wasDragging = dragging;
    panel = null;
    dragging = false;
    if (!wasDragging) return;

    const velocity = dy / Math.max(1, e.timeStamp - startAt);
    const go = dy > DISMISS_PX || (velocity > FLICK_VELOCITY && dy > FLICK_MIN_PX);

    // A drag that ends on a button must not also press it.
    const swallow = (click) => { click.stopPropagation(); click.preventDefault(); };
    layer.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => layer.removeEventListener("click", swallow, { capture: true }), 0);

    p.style.transition = "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)";
    layer.style.transition = "opacity 200ms linear";

    if (go) {
      // Somebody who has asked for less motion gets the result, not the journey. The stylesheet
      // kills the transition for them anyway, which would leave the code below waiting on a
      // transitionend that never comes.
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        close();
        return;
      }
      // Out through the bottom, then gone. Closing on the spot leaves the sheet vanishing from
      // wherever the thumb happened to stop, which reads as a glitch rather than a dismissal.
      p.style.transform = "translateY(" + (p.offsetHeight + 40) + "px)";
      layer.style.opacity = "0";
      let done = false;
      const finish = () => { if (!done) { done = true; close(); } };
      p.addEventListener("transitionend", finish, { once: true });
      // A transition that never fires — an interrupted animation, a hidden tab — would otherwise
      // leave the sheet open and untouchable.
      setTimeout(finish, 320);
    } else {
      p.style.transform = "";
      layer.style.opacity = "";
    }
  }

  layer.addEventListener("pointerup", release);
  layer.addEventListener("pointercancel", release);
}
