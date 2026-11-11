// ui/cardorder.js — keeping the order, and dragging a card to a new place in it.
//
// ---- Why a mode, and not a long-press ----
//
// The obvious design is to hold a card and drag it. It is also the one that does not work on this
// page: a long press on a touch screen is cancelled by the browser the moment it decides the finger
// is scrolling, and Today already answers a pull-down at the top with a sync (pulltorefresh.js). A
// gesture that has to win against both of those is a gesture that sometimes does nothing.
//
// So reordering is something you switch on. In that mode every card wears a grip with
// `touch-action: none`, which is the one declaration that tells the browser to leave a finger on it
// alone, and a drag from the grip is ours from the first pixel. Two small arrows do the same job
// without dragging, for a long list and for anybody who would rather tap than drag.
//
// ---- What it does while you drag ----
//
// Nothing moves in the DOM. The card follows the finger by transform, the card under it is
// outlined, and the order changes once, on release. Re-parenting the dragged element mid-gesture
// drops the pointer capture on some browsers, which is a drag that dies a third of the way across.

import { cleanSaved, dropIndex } from "../cardorder.js";

const KEY = (memberId) => "card-order:" + memberId;

/** The saved order for this person — ids only, and an empty list when there is none or it is unreadable. */
export function loadOrder(memberId) {
  try {
    const raw = localStorage.getItem(KEY(memberId));
    return raw ? cleanSaved(JSON.parse(raw)) : [];
  } catch { return []; }
}

export function saveOrder(memberId, ids) {
  try { localStorage.setItem(KEY(memberId), JSON.stringify(ids)); } catch { /* full or unavailable: the order lasts this session */ }
}

const EDGE = 70;      // px from the top or bottom of the screen where dragging scrolls the page
const SCROLL_STEP = 14;

/**
 * Begin dragging [card] from its grip.
 *
 * @param e        the pointerdown on the grip
 * @param card     the card being moved
 * @param cards    every card, in their current order
 * @param onDrop   called once on release with the index to move the card to, only if it changed
 */
export function startDrag(e, card, cards, onDrop) {
  if (e.button != null && e.button !== 0) return;
  e.preventDefault();
  const grip = e.currentTarget;
  const from = cards.indexOf(card);
  if (from < 0) return;

  // Page coordinates, so a page that scrolls under the drag does not move the targets.
  const scroll0 = window.scrollY;
  const rects = cards.map((c) => {
    const r = c.getBoundingClientRect();
    return { left: r.left + window.scrollX, right: r.right + window.scrollX, top: r.top + scroll0, bottom: r.bottom + scroll0 };
  });
  const x0 = e.clientX;
  const y0 = e.clientY;
  let x = x0;
  let y = y0;
  let over = from;
  let frame = 0;

  try { grip.setPointerCapture(e.pointerId); } catch { /* not capturable: window listeners still work */ }
  card.classList.add("is-dragging");
  document.body.classList.add("is-reordering-now");

  function follow() {
    card.style.transform = "translate(" + (x - x0) + "px, " + (y - y0 + (window.scrollY - scroll0)) + "px)";
    const next = dropIndex(rects, x + window.scrollX, y + window.scrollY, from);
    if (next !== over) {
      if (cards[over]) cards[over].classList.remove("is-drop");
      over = next;
      if (over !== from) cards[over].classList.add("is-drop");
    }
  }

  // Edge scrolling, so a card can be taken further than the screen is tall. Driven by a frame loop
  // rather than by pointermove, because a finger held still at the edge sends no moves.
  function tick() {
    if (y < EDGE) window.scrollBy(0, -SCROLL_STEP);
    else if (y > window.innerHeight - EDGE) window.scrollBy(0, SCROLL_STEP);
    follow();
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);

  function move(ev) {
    if (ev.pointerId !== e.pointerId) return;
    x = ev.clientX;
    y = ev.clientY;
    ev.preventDefault();
    follow();
  }

  function finish(commit) {
    cancelAnimationFrame(frame);
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", cancel);
    try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    document.body.classList.remove("is-reordering-now");
    card.classList.remove("is-dragging");
    card.style.transform = "";
    if (cards[over]) cards[over].classList.remove("is-drop");
    if (commit && over !== from) onDrop(over);
  }
  const up = (ev) => { if (ev.pointerId === e.pointerId) finish(true); };
  const cancel = (ev) => { if (ev.pointerId === e.pointerId) finish(false); };

  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", cancel);
  follow();
}
