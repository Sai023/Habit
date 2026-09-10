// problem.js — the one place a failure is allowed to end up.
//
// Its own module because everything needs it and nothing should have to import the app to get it.
// On a phone there is no console to open, so an error nobody surfaces is an error nobody can even
// describe: "it does nothing" was the entire bug report available for two separate defects that
// each spent a release invisible.

/** A dismissible banner. Deliberately ugly — it is meant to be reported, not lived with. */
export function showProblem(message) {
  return banner(message, "problem", "alert");
}

/**
 * The same banner, saying something that went right.
 *
 * Separate from showProblem because it is drawn in the danger colour, and answering "I synced, and
 * this is what I read" in red teaches somebody that a successful action looks like a failure.
 * Dismisses itself, because unlike a fault there is nothing here to act on.
 */
export function showNote(message, action = null) {
  const bar = banner(message, "problem is-note", "status");
  if (!bar) return bar;
  if (action && action.label) {
    const act = document.createElement("button");
    act.className = "note-act";
    act.textContent = action.label;
    act.onclick = (e) => { e.stopPropagation(); bar.remove(); action.onClick(); };
    // Before the ✕, which banner() has already appended and which stays last.
    bar.insertBefore(act, bar.lastChild);
    // Longer than a plain note, not permanent.
    //
    // It was permanent, on the reasoning that a control which vanishes while you reach for it is
    // worse than one never offered. That is true and it was still the wrong call: the FIRST thing
    // this shipped with was a message wide enough to push its own ✕ off the side of the phone, so
    // "you can always dismiss it" turned out to rest on a layout assumption rather than on
    // anything guaranteed. A banner with no timer is one bad string away from being modal.
    setTimeout(() => bar.remove(), 20000);
    return bar;
  }
  setTimeout(() => bar.remove(), 7000);
  return bar;
}

function banner(message, className, role) {
  if (typeof document === "undefined") return null;
  const existing = document.querySelector(".problem");
  if (existing) existing.remove();

  const bar = document.createElement("div");
  bar.className = className;
  bar.setAttribute("role", role);

  // The message in an element of its own rather than as a bare text node on the flex row.
  //
  // A text node cannot be given `min-width: 0`, so it refuses to shrink below the width of its
  // longest unbreakable run — and one of the things this banner reports is an Android package
  // name. "com.android.healthconnect.phone.jaf4ef36c12443855…" pushed both buttons past the right
  // edge of the screen, which left a banner that could not be read OR closed.
  const text = document.createElement("span");
  text.className = "problem-text";
  text.textContent = message;
  bar.append(text);

  const close = document.createElement("button");
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => bar.remove();
  bar.append(close);

  // Anywhere on it, not only the ✕. Forgiving on purpose: this is the last thing standing
  // between somebody and their screen, and a 24px target for getting rid of it is mean.
  bar.onclick = () => bar.remove();

  document.body.append(bar);
  return bar;
}
