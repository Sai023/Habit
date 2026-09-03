// dashboard.js — the whole UI. Rebuilt from derived state whenever anything changes.
//
// Every number on this screen comes from habits.js. Nothing is computed here except presentation,
// which is what keeps one answer to "what is my streak" across the web app, the tests, and the
// Android shell.

import { el, render } from "../dom.js";
import {
  valueOn, valueForPeriod, targetOn, targetFor, isTracking, rawDayStatus, rawPeriodStatus,
  walk, leaderboard, sourceFor, periodKey, periodEnd, addDays, daysBetween, isoDayOfWeek,
  HIT, MISS, NO_DATA, EXEMPT,
} from "../habits.js";
import { AT_MOST, AGGREGATE, T, VISIBILITY, PERIOD, SOURCE } from "../schema.js";

/** "this week" / "this month" — and nothing at all for a daily habit, where it would be noise. */
const CADENCE = { [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };
const STREAK_UNIT = {
  [PERIOD.DAY]: ["day", "days"],
  [PERIOD.WEEK]: ["week", "weeks"],
  [PERIOD.MONTH]: ["month", "months"],
};
import * as fmt from "./format.js";

const TABS = [
  { id: "today", label: "Today", glyph: "◉" },
  { id: "board", label: "Board", glyph: "♛" },
  { id: "habits", label: "Habits", glyph: "☰" },
];

export function renderApp(root, ctx) {
  render(root,
    header(ctx),
    el("main.main",
      ctx.tab === "board" ? boardTab(ctx)
        : ctx.tab === "habits" ? habitsTab(ctx)
        : todayTab(ctx)),
    nav(ctx),
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const SYNC_TEXT = {
  SYNCED: ["is-synced", "Synced"],
  SYNCING: ["is-synced", "Syncing"],
  OFFLINE: ["is-offline", "Offline"],
  // Not "retrying": on the free tier this is most often a paused project, and no amount of
  // retrying wakes one. Saying so is what stops a dead sync looking like a slow one.
  DEGRADED: ["is-degraded", "Sync paused"],
  LOCAL_ONLY: ["is-local", "On this device"],
};

function header(ctx) {
  const [cls, text] = SYNC_TEXT[ctx.sync?.state] || SYNC_TEXT.LOCAL_ONLY;
  const queued = ctx.sync?.queued || 0;
  return el("header.hdr",
    el("div",
      el("div.hdr-title", ctx.state.meta?.name || "Habits"),
      el("div.hdr-sub", fmt.dayLabel(ctx.today), ctx.demo ? " · demo data" : ""),
    ),
    el("div.hdr-actions",
      el("span.pill." + cls, el("i.dot"), queued ? text + " · " + queued : text),
      // Embedded, this is the only route back to Health Connect, reminders and leaving the group,
      // because settings stopped being a tab. In a browser there is no shell to open, so it is
      // not drawn at all rather than drawn dead.
      ctx.embedded
        ? el("button.icon-btn", { onclick: () => ctx.onOpenSettings(), "aria-label": "Settings" }, "⚙")
        : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function todayTab(ctx) {
  const all = [...ctx.state.habits.values()];
  // Only what this person actually signed up for. A group can track five things without everyone
  // doing all five, and showing someone a card for a habit they opted out of is just clutter.
  const habits = all.filter((h) => isTracking(ctx.state, h, ctx.me));
  if (!all.length) return emptyState(ctx);
  if (!habits.length) {
    return el("div.empty",
      el("h1", "Nothing picked yet"),
      el("p", "The group is tracking " + all.length + " habit" + (all.length === 1 ? "" : "s") + ". Choose the ones you're in for and set your own targets."),
      el("button.tap", { onclick: () => ctx.onEditGoals() }, "Pick my habits"),
    );
  }

  return [
    el("section.sec",
      el("div.sec-hd",
        el("h2.sec-title", "Your day"),
        el("span.sec-note", timeLeft(ctx)),
      ),
      el("div.cards", habits.map((h) => habitCard(h, ctx))),
      streakLine(habits, ctx),
    ),
    activitySection(ctx),
  ];
}

function timeLeft(ctx) {
  const h = [...ctx.state.habits.values()][0];
  if (!h) return "";
  const now = new Date(ctx.now);
  const hoursGone = ((now.getHours() - h.dayStartHour) + 24) % 24;
  const left = 24 - hoursGone;
  return left <= 0 ? "" : left + "h left today";
}

/**
 * One habit's card for today.
 *
 * Build and reduce habits are drawn differently on purpose. A build habit fills a bar toward a
 * target; a reduce habit drains a budget of dots. A full bar means success in one and failure in
 * the other, so they must not look alike.
 */
function habitCard(habit, ctx) {
  // A weekly habit's card is about the WEEK. Showing today's number for "gym three times a week"
  // would read as though you had failed on every rest day.
  const key = periodKey(ctx.today, habit.period);
  const value = valueForPeriod(ctx.state, habit, ctx.me, key);
  const target = targetFor(ctx.state, habit, ctx.me, periodEnd(key, habit.period));
  const status = rawPeriodStatus(ctx.state, habit, ctx.me, key);
  const cadence = CADENCE[habit.period] || "";
  const source = sourceFor(ctx.state, habit, ctx.me);
  const src = fmt.source(source);
  const reduce = habit.direction === AT_MOST;
  // A watch normally fills this one in, so the button is the override rather than the main way in.
  const auto = source === SOURCE.HEALTH_CONNECT || source === SOURCE.STRAVA;
  const intervention = source === SOURCE.PAUSE && reduce;

  const classes = ["card"];
  // The card with the big action gets the full row: it is the one you tap, and a half-width button
  // stranded beside dead space reads as a layout accident rather than a choice.
  if (intervention) classes.push("has-action");
  if (status === HIT) classes.push("is-hit");
  if (status === NO_DATA) classes.push("is-nodata");
  if (reduce && value != null && value > target) classes.push("is-over");

  return el("article." + classes.join("."),
    el("div.card-top",
      el("span.card-icon", habit.icon || "◆"),
      el("span.card-name", habit.name || "Habit"),
    ),
    el("div",
      el("div.card-value", reduce
        // Nothing logged against a ceiling means nothing spent — the whole budget is still there.
        // A dash would read as "unknown" when the honest answer is "all of it".
        ? Math.max(0, target - (value || 0))
        : fmt.value(habit.metric, value)),
      el("div.card-of", reduce
        ? "left of " + target + " " + (cadence || "today")
        : status === NO_DATA ? "waiting for data"
        : fmt.goal(habit, target) + (cadence ? " " + cadence : "")),
    ),
    reduce ? budgetDots(value, target) : progressBar(value, target),
    el("div.card-foot",
      el("span.src", src.icon, " ", src.label),
      status === HIT ? el("span", "✓") : null,
    ),
    // The breathing screen is its own thing: it interrupts an urge rather than recording one, and
    // the recording is what happens afterwards. Everything else just needs a way in.
    intervention
      ? el("button.tap", { onclick: () => ctx.onUrge(habit) }, "I want to vape 💨")
      : el("button.logbtn", { onclick: () => ctx.onLog(habit) },
          auto ? "Enter it manually" : "＋ Log"),
  );
}

function progressBar(value, target) {
  const pct = target > 0 ? Math.min(100, Math.round(((value || 0) / target) * 100)) : 0;
  return el("div.bar", { role: "presentation" }, el("i", { style: "width:" + pct + "%" }));
}

/** A reduce habit's budget, draining as it is used. Capped so a very bad day still renders. */
function budgetDots(value, target) {
  const used = Math.min(value || 0, target);
  const shown = Math.min(target, 12);
  return el("div.dots", Array.from({ length: shown }, (_, i) =>
    el("i" + (i < shown - used ? "" : ".spent"))));
}

function streakLine(habits, ctx) {
  const best = habits
    .map((h) => walk(ctx.state, h.habitId, ctx.me, ctx.today))
    .filter(Boolean)
    .sort((a, b) => b.streak - a.streak)[0];
  if (!best) return null;

  const [one, many] = STREAK_UNIT[best.habit.period] || STREAK_UNIT[PERIOD.DAY];
  return el("div.streakline",
    el("span", "🔥 ", el("b", best.streak), " ", best.streak === 1 ? one : many),
    el("span", "🛡 ", el("b", best.tokens), best.tokens === 1 ? " grace token" : " grace tokens"),
    // Grace is never spent silently: a streak that survived because a token was burned, without
    // saying so, reads as a bug the first time someone notices the maths.
    best.spent.length ? el("span", "· spent " + best.spent.length + " this run") : null,
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

function boardTab(ctx) {
  const members = [...ctx.state.members.keys()];
  if (!members.length) return emptyState(ctx);

  const from = addDays(ctx.today, -(isoDayOfWeek(ctx.today) - 1)); // Monday of this week
  const rows = leaderboard(ctx.state, members, from, ctx.today, ctx.today);

  return el("section.sec",
    el("div.sec-hd",
      el("h2.sec-title", "The board"),
      el("span.sec-note", "This week"),
    ),
    el("div.board", rows.map((r) => boardRow(r, ctx))),
    el("p.sec-note", { style: "padding:0 2px" },
      "Rest days and days with no data are left out of the score — you're measured on the days you were actually asked to show up."),
  );
}

function boardRow(row, ctx) {
  const classes = ["row"];
  if (row.memberId === ctx.me) classes.push("is-me");
  if (row.crown) classes.push("is-crown");

  return el("article." + classes.join("."),
    el("div.row-rank", row.rank),
    el("div.row-main",
      el("div.row-name",
        row.crown ? el("span.tagemoji", { title: "Top of the board" }, "👑") : null,
        row.clown ? el("span.tagemoji", { title: "Bottom of the board" }, "🤡") : null,
        row.memberId === ctx.me ? "You" : row.name,
      ),
      el("div.row-bar", el("i", { style: "width:" + (row.pct == null ? 0 : row.pct) + "%" })),
      el("div.row-meta",
        row.eligible ? row.hits + "/" + row.eligible + " days" : "nothing scored yet",
        row.streak ? " · 🔥 " + row.streak : "",
        row.spentTokens ? " · 🛡 spent " + row.spentTokens : "",
      ),
    ),
    el("div.row-pct", row.pct == null ? "—" : row.pct + "%"),
    // The fairness rule, made visible. If the bottom row had a silent pipeline there is no clown
    // at all this week — and the person is told why, and offered the fix, rather than left to
    // wonder why their numbers look bad.
    row.clownSuppressed
      ? el("div.note",
          el("div", el("b", "No data from their watch"), " — nothing to score, so nobody is the clown this week."),
          el("button", { onclick: () => ctx.onFixSync(row) }, "Check sync setup →"),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

function habitsTab(ctx) {
  const habits = [...ctx.state.habits.values()];

  return el("section.sec",
    el("div.sec-hd",
      el("h2.sec-title", "Habits"),
      el("span", { style: "display:flex;gap:14px" },
        el("button.link", { onclick: () => ctx.onEditGoals() }, "My goals"),
        el("button.link", { onclick: () => ctx.onEditHabit(null) }, "+ New"),
      ),
    ),
    !habits.length
      ? el("p.sec-note", { style: "padding:0 2px" },
          "Nothing tracked yet. Add the first one and the group can start showing up for it.")
      : el("div.board", habits.map((h) => {
      const src = fmt.source(sourceFor(ctx.state, h, ctx.me));
      const target = targetOn(h, periodEnd(periodKey(ctx.today, h.period), h.period));
      return el("article.row.tappable", {
        style: "grid-template-columns: 26px minmax(0,1fr)",
        role: "button",
        tabindex: "0",
        onclick: () => ctx.onEditHabit(h.habitId),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ctx.onEditHabit(h.habitId); } },
      },
        el("div.row-rank", h.icon || "◆"),
        el("div.row-main",
          el("div.row-name", h.name || "Habit"),
          el("div.row-meta",
            (h.direction === AT_MOST ? "At most " : "At least ") + fmt.value(h.metric, target),
            // Weekday scheduling only means something for a daily habit — "3 days a week" would
            // be a contradiction printed next to a weekly target.
            h.period === PERIOD.DAY
              ? (h.days.length === 7 ? " · every day" : " · " + h.days.length + " days a week")
              : " · " + CADENCE[h.period],
            h.taper ? " · tapering" : "",
            h.weight !== 1 ? " · counts " + h.weight + "×" : "",
          ),
          el("div.row-meta",
            src.icon + " " + src.label,
            h.visibility === VISIBILITY.PROGRESS ? " · 🔒 count hidden" : "",
            h.visibility === VISIBILITY.PRIVATE ? " · 🔒 private" : "",
            h.scored ? "" : " · not scored",
          ),
        ),
      );
    })),
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function activitySection(ctx) {
  const items = recentActivity(ctx, 8);
  if (!items.length) return null;
  return el("section.sec",
    el("div.sec-hd", el("h2.sec-title", "Activity")),
    el("div.feed", items),
  );
}

function recentActivity(ctx, limit) {
  const out = [];
  const seen = new Set();
  // Newest first, and only one line per habit-day-person: a running total that ticked three times
  // is one thing that happened, not three.
  for (let i = ctx.events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = ctx.events[i];
    if (e.type !== T.LOG) continue;
    const p = e.payload || {};
    const habit = ctx.state.habits.get(p.habitId);
    if (!habit) continue;
    const key = p.habitId + "|" + p.memberId + "|" + p.day;
    if (seen.has(key)) continue;
    seen.add(key);

    const who = p.memberId === ctx.me ? "You" : (ctx.state.members.get(p.memberId)?.name || "Someone");
    const src = fmt.source(p.source);
    const status = rawDayStatus(ctx.state, habit, p.memberId, p.day);
    const shown = publicNumber(habit, p, ctx);

    out.push(el("div.ev",
      el("span", src.icon),
      el("span.ev-when", fmt.whenLabel(e.ts, ctx.now)),
      el("span.ev-what",
        el("b", who), " ", verbFor(habit, shown),
        status === HIT ? " ✓" : "",
      ),
    ));
  }
  return out;
}

/** Respect the habit's visibility before putting anyone's number in a shared feed. */
function publicNumber(habit, payload, ctx) {
  if (payload.memberId === ctx.me) return payload.value;
  if (habit.visibility === VISIBILITY.FULL) return payload.value;
  return null;
}

function verbFor(habit, value) {
  if (habit.aggregate === AGGREGATE.SUM) {
    return value === 0 ? "resisted an urge" : "logged " + (habit.name || "a habit").toLowerCase();
  }
  if (value == null) return "updated " + (habit.name || "a habit").toLowerCase();
  return "logged " + fmt.value(habit.metric, value) + " " + (habit.name || "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function emptyState(ctx) {
  return el("div.empty",
    el("h1", "No habits yet"),
    el("p", ctx.state.members.size
      ? "Add the first habit and the group can start showing up for it."
      : "Start a group and share the code with your friends, or join one you were sent."),
    el("button.tap", { onclick: ctx.onStart }, "Get started"),
    el("button.ghost", { onclick: () => { location.search = "?demo=1"; } }, "See it with example data"),
  );
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function nav(ctx) {
  // Embedded, Today and Board are native destinations and the shell is already drawing a bar.
  // Drawing a second one under it is the nested-navigation trap this merge exists to remove.
  if (ctx.embedded) return null;
  return el("nav.nav", { "aria-label": "Sections" },
    TABS.map((t) => el("button.nav-btn", {
      "aria-current": ctx.tab === t.id ? "page" : null,
      onclick: () => ctx.onTab(t.id),
    }, el("span.g", t.glyph), t.label)),
  );
}
