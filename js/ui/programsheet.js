// programsheet.js — which program to follow.
//
// Two of them, written for two specific people, so this is a choice rather than a search. It is
// one event, and the latest wins, so changing your mind is the same tap again. "None" is a real
// option: somebody can compete on Workouts from a watch without following a plan at all.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { chooseProgram } from "../store.js";
import { PROGRAM_LIST } from "../programs.js";
import { programFor } from "../workout.js";

export function openProgramSheet(host, { state, me, onDone }) {
  const sheet = openSheet(host, { onClose: () => onDone && onDone() });
  const current = programFor(state, me);
  let busy = false;

  async function pick(id) {
    if (busy) return;
    busy = true; paint();
    try {
      await chooseProgram(id);
      sheet.close();
    } catch (err) {
      busy = false; paint();
      const { showProblem } = await import("./problem.js");
      showProblem("Couldn't save that: " + (err && err.message ? err.message : err));
    }
  }

  /** "Mon Push + Core · Tue Legs + Pull · …" — the week in one line, so the choice is informed. */
  function week(program) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return names.map((n, i) => {
      const slot = program.schedule[i + 1];
      const label = slot == null ? "Rest"
        : typeof slot === "object" ? slot.rest
        : (program.sessions[slot] || {}).name || slot;
      return n + " " + label;
    }).join(" · ");
  }

  function paint() {
    sheet.paint(
      el("div.form",
        el("div.sheet-head", el("span.sheet-title", "Your program")),
        el("p.sheet-now",
          "Today's session shows on the Workouts card, and every set you bank is kept. Finishing a "
          + "session counts as a workout on the board."),

        el("div.prog-list", PROGRAM_LIST.map((p) => el(
          "button.prog" + (current && current.id === p.id ? ".is-on" : ""),
          { onclick: () => pick(p.id), disabled: busy },
          el("span.prog-name", p.name, current && current.id === p.id ? el("span.prog-tag", "following") : null),
          el("span.prog-tagline", p.tagline),
          el("span.prog-week", week(p)),
        ))),

        current
          ? el("button.link.danger", { onclick: () => pick(null), disabled: busy }, "Stop following a program")
          : null,
        el("button.ghost", { onclick: () => sheet.close() }, "Cancel"),
      ),
    );
  }

  paint();
}
