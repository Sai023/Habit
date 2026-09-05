// onboard.js — starting a group, joining one, and getting a phone connected to it.
//
// Three moments, in the order they actually happen: pick create or join, fill in the one form,
// then get the two codes out — the invite for your friends and the setup code for your own phone.
// Those two are deliberately far apart on the screen and labelled differently, because handing a
// friend the wrong one makes them post as you.

import { el, render } from "../dom.js";
import { createGroup, joinGroup, setupCode, ensureBindings } from "../store.js";
import { normalizeGroupCode } from "../id.js";
import { METRIC, AT_LEAST, AT_MOST, AGGREGATE, VISIBILITY } from "../schema.js";

/**
 * The habits a new group starts with.
 *
 * Two that a watch can fill in on its own, and one that it cannot. The third is the reason the
 * reduce direction exists: it counts DOWN from a ceiling, and the ceiling drops a tenth of its
 * starting value every week until it reaches zero — a quit plan with a date on it rather than an
 * open-ended diary.
 *
 * It IS scored, and no longer by anyone's choice — scoring is decided by the metric now, and puffs
 * are one of the six. Keeping reduce habits off the board was meant to stop "bottom of a quitting
 * metric" producing hidden logs, but Discipline is thirty per cent of the day and is made of
 * reduce habits, so excusing them deleted the category rather than protecting anybody. The
 * protection lives where it belongs: the clown is suppressed on a silent pipeline, and a ceiling
 * cannot be failed by a sensor going quiet.
 */
const STARTERS = [
  {
    key: "steps", icon: "👟", name: "Steps",
    blurb: "Read from your watch automatically.",
    unit: "steps a day", step: 500, toInput: (v) => v, fromInput: (v) => Math.round(v),
    fields: {
      metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
      aggregate: AGGREGATE.LAST, visibility: VISIBILITY.FULL,
    },
  },
  {
    key: "sleep", icon: "😴", name: "Sleep",
    blurb: "Read from your watch automatically.",
    unit: "hours a night", step: 0.25,
    toInput: (v) => Math.round((v / 60) * 100) / 100, fromInput: (v) => Math.round(v * 60),
    fields: {
      metric: METRIC.SLEEP, direction: AT_LEAST, target: 420,
      aggregate: AGGREGATE.LAST, visibility: VISIBILITY.FULL,
    },
  },
  {
    key: "puffs", icon: "💨", name: "Puffs",
    blurb: "Count them as you go. The ceiling drops a tenth every week, until it reaches zero.",
    unit: "puffs a day, at most", step: 5, toInput: (v) => v, fromInput: (v) => Math.round(v),
    fields: {
      metric: METRIC.PUFFS, direction: AT_MOST, target: 80,
      aggregate: AGGREGATE.SUM, visibility: VISIBILITY.PROGRESS,
      taper: { percent: 10, everyDays: 7, floor: 0 },
    },
  },
];

export function renderOnboard(root, { onComplete }) {
  // The creator's current zone, pinned from here on. Reading it live would let a trip stretch a
  // day and hand somebody two chances at the same streak.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const state = {
    screen: "welcome",
    groupName: "",
    myName: "",
    joinCode: "",
    picked: new Set(STARTERS.map((s) => s.key)),
    targets: Object.fromEntries(STARTERS.map((s) => [s.key, s.toInput(s.fields.target)])),
    busy: false,
    error: "",
    code: "",
    setup: "",
  };

  const go = (screen) => { state.screen = screen; state.error = ""; paint(); };

  function paint() {
    render(root, el("main.main.onboard",
      state.screen === "welcome" ? welcome()
        : state.screen === "create" ? create()
        : state.screen === "join" ? join()
        : share()));
  }

  // -------------------------------------------------------------------------

  function welcome() {
    return el("div.empty",
      el("h1", "Show up together"),
      el("p", "A habit tracker for one small group of friends. No accounts — the group code is the key."),
      el("div.stack-btn",
        el("button.tap", { onclick: () => go("create") }, "Start a group"),
        el("button.ghost", { onclick: () => go("join") }, "Join with a code"),
      ),
      el("button.link", { onclick: () => { location.search = "?demo=1"; } }, "Look around with example data first"),
    );
  }

  function field(label, value, onInput, opts = {}) {
    return el("label.field",
      el("span.field-label", label),
      el("input", {
        type: opts.type || "text",
        value,
        inputmode: opts.inputmode,
        placeholder: opts.placeholder || "",
        autocapitalize: opts.autocapitalize || "sentences",
        spellcheck: "false",
        oninput: (e) => onInput(e.target.value),
      }),
    );
  }

  function create() {
    return el("div.form",
      el("button.link.back", { onclick: () => go("welcome") }, "← Back"),
      el("h1", "Start a group"),
      el("p.lede", "You'll get a code to send your friends."),

      field("What's the group called?", state.groupName, (v) => { state.groupName = v; },
        { placeholder: "The Accountability Club" }),
      field("Your name", state.myName, (v) => { state.myName = v; }, { placeholder: "Sahil" }),

      el("h2.sec-title", { style: "margin-top:8px" }, "What are you tracking?"),
      el("div.starters", STARTERS.map(starter)),

      el("p.note-inline",
        "Your day starts at 4am and runs on ",
        el("b", tz),
        ". A 1am log counts as the night before, and travelling won't move the line."),

      state.error ? el("p.err", state.error) : null,
      el("button.tap", { onclick: submitCreate, disabled: state.busy },
        state.busy ? "Creating…" : "Create the group"),
    );
  }

  function starter(s) {
    const on = state.picked.has(s.key);
    return el("div.starter" + (on ? ".on" : ""),
      el("button.starter-head", {
        onclick: () => { if (on) state.picked.delete(s.key); else state.picked.add(s.key); paint(); },
        "aria-pressed": on ? "true" : "false",
      },
        el("span.card-icon", s.icon),
        el("span.starter-name", s.name),
        el("span.starter-check", on ? "✓" : ""),
      ),
      on ? el("div.starter-body",
        el("p.starter-blurb", s.blurb),
        el("label.inline-field",
          el("input", {
            type: "number", step: s.step, min: "0",
            value: state.targets[s.key],
            inputmode: "decimal",
            oninput: (e) => { state.targets[s.key] = e.target.value; },
          }),
          el("span", s.unit),
        ),
      ) : null,
    );
  }

  async function submitCreate() {
    if (state.busy) return;
    if (!state.myName.trim()) { state.error = "Add your name so the group knows who you are."; return paint(); }
    if (!state.picked.size) { state.error = "Pick at least one habit — a group with none has nothing to show up for."; return paint(); }

    state.busy = true; state.error = ""; paint();
    try {
      const starters = STARTERS.filter((s) => state.picked.has(s.key)).map((s) => {
        const raw = Number(state.targets[s.key]);
        const target = Number.isFinite(raw) && raw > 0 ? s.fromInput(raw) : s.fields.target;
        return { habitId: s.key, name: s.name, icon: s.icon, ...s.fields, target, tz, dayStartHour: 4 };
      });
      state.code = await createGroup(state.groupName.trim(), state.myName.trim(), starters);
      state.setup = await setupCode();
      go("share");
      onComplete();
    } catch (err) {
      state.error = "Couldn't create the group: " + (err && err.message ? err.message : err);
      state.busy = false;
      paint();
    }
  }

  function join() {
    return el("div.form",
      el("button.link.back", { onclick: () => go("welcome") }, "← Back"),
      el("h1", "Join a group"),
      el("p.lede", "Paste the code a friend sent you."),

      field("Group code", state.joinCode, (v) => { state.joinCode = v.toUpperCase(); },
        { placeholder: "HABIT-7Q2XK9", autocapitalize: "characters" }),
      field("Your name", state.myName, (v) => { state.myName = v; }, { placeholder: "Sahil" }),

      state.error ? el("p.err", state.error) : null,
      el("button.tap", { onclick: submitJoin, disabled: state.busy },
        state.busy ? "Joining…" : "Join"),
    );
  }

  async function submitJoin() {
    if (state.busy) return;
    const raw = state.joinCode.trim();

    // Somebody will eventually forward the wrong one of the two codes. Say which is which rather
    // than reporting a shape error about a string that is perfectly valid for something else.
    if (raw.toUpperCase().startsWith("HS1.")) {
      state.error = "That's a setup code — it connects Goal Buddy to a phone. The invite is the short one starting with HABIT-.";
      return paint();
    }

    // Normalised, not just checked: a code typed from another screen arrives with stray spaces or
    // an autocorrected dash, and all of those are unmistakably the same code.
    const code = normalizeGroupCode(raw);
    if (!code) {
      state.error = "That doesn't look like a group code. It's six characters after HABIT- , like HABIT-7Q2XK9.";
      return paint();
    }
    if (!state.myName.trim()) { state.error = "Add your name so the group knows who you are."; return paint(); }

    state.busy = true; state.error = ""; paint();
    try {
      state.code = await joinGroup(code, state.myName.trim());
      state.setup = await setupCode();
      go("share");
      // The room's habits arrive on the first pull, and only then is there anything to bind to.
      onComplete({ bindAfterSync: true });
    } catch (err) {
      state.error = "Couldn't join: " + (err && err.message ? err.message : err);
      state.busy = false;
      paint();
    }
  }

  /**
   * Two codes, and people reach for the wrong one.
   *
   * The invite is short and readable; the setup code is a wall of base64. Given both at once, a
   * hand goes for the one that looks like a code — and it was listed first, with a button of equal
   * weight, which made that the obvious thing to grab. So they are numbered now, the one that is
   * actually blocking you comes first, and only it gets the primary button. Sending the invite can
   * happen any time; nothing works until this phone is connected.
   */
  function share() {
    return el("div.form",
      el("h1", "You're in"),
      el("p.lede", "Two codes, and they do different jobs."),

      el("div.codebox.private",
        el("div.codebox-label", "① Set up Goal Buddy on this phone"),
        el("div.codebox-value small", state.setup || "—"),
        el("p.codebox-note",
          el("b", "Keep this one to yourself. "),
          "It carries your identity, so anyone who pastes it would post as you. Open Goal Buddy → Habits → paste it in."),
        copyButton(state.setup, "Copy setup code", "tap"),
      ),

      el("div.codebox",
        el("div.codebox-label", "② Send this to your friends"),
        el("div.codebox-value", state.code),
        el("p.codebox-note",
          "The invite. Anyone with it can join and see the group. ",
          el("b", "This is not the one Goal Buddy wants.")),
        copyButton(state.code, "Copy invite code", "ghost"),
      ),

      el("button.tap", { onclick: () => onComplete({ done: true }) }, "Go to my habits"),
    );
  }

  function copyButton(text, label, kind = "ghost") {
    return el("button." + kind + ".copy", {
      onclick: async (e) => {
        const button = e.currentTarget;
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = "Copied ✓";
        } catch {
          // Clipboard access is denied often enough — in an insecure context, or a locked-down
          // WebView — that failing silently would look like a dead button. Select it instead.
          selectText(button.closest(".codebox").querySelector(".codebox-value"));
          button.textContent = "Selected — long-press to copy";
        }
        setTimeout(() => { button.textContent = label; }, 2500);
      },
    }, label);
  }

  function selectText(node) {
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  paint();
}

export { STARTERS };
