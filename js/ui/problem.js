// problem.js — the one place a failure is allowed to end up.
//
// Its own module because everything needs it and nothing should have to import the app to get it.
// On a phone there is no console to open, so an error nobody surfaces is an error nobody can even
// describe: "it does nothing" was the entire bug report available for two separate defects that
// each spent a release invisible.

/** A dismissible banner. Deliberately ugly — it is meant to be reported, not lived with. */
export function showProblem(message) {
  if (typeof document === "undefined") return;
  const existing = document.querySelector(".problem");
  if (existing) existing.remove();

  const bar = document.createElement("div");
  bar.className = "problem";
  bar.setAttribute("role", "alert");
  bar.textContent = message;

  const close = document.createElement("button");
  close.textContent = "✕";
  close.setAttribute("aria-label", "Dismiss");
  close.onclick = () => bar.remove();
  bar.append(close);

  document.body.append(bar);
}
