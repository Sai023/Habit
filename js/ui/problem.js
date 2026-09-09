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
    act.onclick = () => { bar.remove(); action.onClick(); };
    // Before the ✕, which banner() has already appended and which stays last.
    bar.insertBefore(act, bar.lastChild);
    // No timer. Seven seconds is right for something to read and wrong for something to press —
    // a control that disappears while you reach for it is worse than one that was never offered.
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
  bar.textContent = message;

  const close = document.createElement("button");
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => bar.remove();
  bar.append(close);

  document.body.append(bar);
  return bar;
}
