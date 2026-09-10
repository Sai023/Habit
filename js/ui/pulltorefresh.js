// pulltorefresh.js — drag down at the top of Today to sync.
//
// ---- Why, when there is already a button ----
//
// There are two now, and the second one only exists because the first was invisible: the status
// pill in the header has always been tappable and read as a status, so the source badge under each
// automatic card became a control as well. Asked for as "swiping down would be more intuitive",
// which is the same observation a third time — the gesture needs no discovering, because every
// list on the phone already answers to it.
//
// So this is not a third control so much as the one people were always going to try first.
//
// ---- Who owns the gesture ----
//
// The hard part, and there is a precedent in the CSS for the sheets: a drag down at scroll zero is
// also the browser's own overscroll, and if the browser claims it, our pointer stream is cancelled
// a few pixels in and nothing we do afterwards runs. It looks like a gesture that does not work;
// it is a gesture that never happened.
//
// Two things stop that. `overscroll-behavior-y: contain` on the page tells the browser there is no
// rubber-band here, and the touchmove listener is registered non-passive so it can actually take
// the gesture — a passive listener may not call preventDefault, and the browser assumes passive on
// touchmove unless told otherwise, so the flag is not optional padding.
//
// ---- What it deliberately does not do ----
//
// It does not arm while a sheet is open, on any tab but Today, or while a sync is already running.
// A pull that fires a second sync mid-flight would produce two answers to one question, and the
// note that reports them would show whichever finished last.

import { pullDistance, pullProgress, armed } from "../pull.js";

/**
 * Install the gesture. Returns an unsubscribe.
 *
 * @param onRefresh  what a completed pull runs. Awaited, so the spinner lasts as long as the work.
 * @param canPull    asked at the START of every gesture, never mid-drag: a drag that becomes
 *                   ineligible halfway — the tab changed, a sheet opened — should finish and spring
 *                   back rather than freeze under the finger.
 */
export function installPullToRefresh({ onRefresh, canPull }) {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};

  let startY = 0;
  let startX = 0;
  let dy = 0;
  let tracking = false;   // a touch began somewhere this gesture could start from
  let pulling = false;    // and has since committed to being a pull rather than a scroll
  let busy = false;
  let host = null;

  function indicator() {
    if (host) return host;
    host = document.createElement("div");
    host.className = "ptr";
    host.setAttribute("aria-hidden", "true");
    const ring = document.createElement("div");
    ring.className = "ptr-ring";
    host.append(ring);
    document.body.append(host);
    return host;
  }

  function draw(distance, progress) {
    const node = indicator();
    node.style.transform = "translate(-50%, " + distance + "px)";
    node.style.opacity = String(Math.min(1, progress * 1.4));
    node.classList.toggle("is-armed", progress >= 1);
  }

  function release() {
    if (host) {
      host.classList.add("is-settling");
      host.style.transform = "translate(-50%, 0px)";
      host.style.opacity = "0";
      // Long enough for the transition below to finish. Removing the class early would cut the
      // spring short and snap it, which reads as the app losing interest halfway.
      setTimeout(() => host && host.classList.remove("is-settling"), 260);
    }
    tracking = false;
    pulling = false;
    dy = 0;
  }

  function onStart(e) {
    if (busy || e.touches.length !== 1) return;
    // Both conditions at the start and neither again: the page must be AT the top, and the caller
    // must agree this is a moment for it.
    if (window.scrollY > 0) return;
    if (canPull && !canPull()) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    dy = 0;
    tracking = true;
    pulling = false;
  }

  function onMove(e) {
    if (!tracking || e.touches.length !== 1) return;
    dy = e.touches[0].clientY - startY;
    const dx = Math.abs(e.touches[0].clientX - startX);

    if (!pulling) {
      // Give up on anything that is plainly a scroll or a sideways swipe. Deciding once, early,
      // rather than every frame is what stops a horizontal swipe between tabs feeling sticky.
      if (dy < 0 || dx > Math.abs(dy)) { tracking = false; return; }
      if (pullDistance(dy) <= 0) return;
      pulling = true;
    }

    // Only once committed, so an ordinary scroll is never blocked by this listener.
    if (e.cancelable) e.preventDefault();
    draw(pullDistance(dy), pullProgress(dy));
  }

  async function onEnd() {
    if (!pulling) { tracking = false; return; }
    const fire = armed(dy);
    if (!fire) { release(); return; }

    busy = true;
    const node = indicator();
    node.classList.add("is-busy");
    tracking = false;
    pulling = false;
    try {
      if (onRefresh) await onRefresh();
    } finally {
      busy = false;
      node.classList.remove("is-busy");
      release();
    }
  }

  // Passive on the two that never call preventDefault, explicitly non-passive on the one that
  // does — a touchmove listener is assumed passive otherwise, and preventDefault inside it is
  // ignored with a console warning nobody on a phone will ever see.
  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: false });
  document.addEventListener("touchend", onEnd, { passive: true });
  document.addEventListener("touchcancel", release, { passive: true });

  return () => {
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", release);
    if (host) host.remove();
    host = null;
  };
}
