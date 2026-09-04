// dashboard.js — the whole UI. Rebuilt from derived state whenever anything changes.
//
// Every number on this screen comes from habits.js. Nothing is computed here except presentation,
// which is what keeps one answer to "what is my streak" across the web app, the tests, and the
// Android shell.

import { el, render } from "../dom.js";
import {
  valueOn, valueForPeriod, targetOn, targetFor, isTracking, rawDayStatus, rawPeriodStatus, walk, sourceFor, periodKey, periodEnd, periodStart, addDays, daysBetween, isoDayOfWeek, compareDays, HIT, MISS, NO_DATA, EXEMPT,
} from "../habits.js";
import {
  leaderboard, categoryOver, dayScore, expectedBy, categoryFor as categoryOf,
  CATEGORY, CATEGORY_LABEL, CATEGORY_ICON, CATEGORY_ORDER,
} from "../score.js";
import { seasonTally, categoryBreakdown } from "../season.js";
import {
  AT_MOST, AGGREGATE, T, VISIBILITY, PERIOD, SOURCE, PAUSE_METRICS, AUTOMATIC_SOURCES,
  isInterventionHabit,
} from "../schema.js";

/** "this week" / "this month" — and nothing at all for a daily habit, where it would be noise. */
const CADENCE = { [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };
const STREAK_UNIT = {
  [PERIOD.DAY]: ["day", "days"],
  [PERIOD.WEEK]: ["week", "weeks"],
  [PERIOD.MONTH]: ["month", "months"],
};
import * as fmt from "./format.js";

// Two destinations. Habits used to be a third, showing a list people consult while setting
// something up and then leave alone for weeks — a permanent slot for an occasional errand. It
// opens from the header now, as a sheet.
const TABS = [
  { id: "today", label: "Today", glyph: "◉" },
  { id: "board", label: "Board", glyph: "♛" },
];

export function renderApp(root, ctx) {
  render(root,
    header(ctx),
    el("main.main", ctx.tab === "board" ? boardTab(ctx) : todayTab(ctx)),
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
      // One button, not two. There used to be a ☰ for the habit list and a ⚙ for the shell's
      // settings, which asked the reader to know which of two apps a given setting belonged to —
      // a distinction that is an implementation detail here and the whole point of merging them
      // was that it should stop being visible. Everything you might go looking for is behind this.
      el("button.icon-btn", { onclick: () => ctx.onOpenHabits(), "aria-label": "Menu" }, "☰"),
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
    correlationSection(habits, ctx),
    activitySection(ctx),
  ];
}

// ---------------------------------------------------------------------------
// What the two halves of the app say together
// ---------------------------------------------------------------------------

const COMPARE_WINDOW_DAYS = 30;

/**
 * The one thing neither app could say on its own.
 *
 * Pause always knew how much you were on your phone and the tracker always knew how much you
 * moved; they were two apps, so nobody ever put the two numbers in the same sentence. Now that
 * screen time is a habit in the shared log, this is a pure derivation over events that are
 * already here — no bridge call, no native computation, nothing that could disagree with the
 * board about what a good day was.
 *
 * It appears on its own terms or not at all. `compareDays` returns null unless both sides clear
 * the minimum, so a fortnight in there is simply no card, rather than a confident claim built on
 * three days.
 */
function correlationSection(habits, ctx) {
  const daily = habits.filter((h) => h.period === PERIOD.DAY);
  // The gate is a screen habit, because that is the half of the story the person controls in the
  // moment: "the days I stayed off my phone" is an action, where "the days I walked a lot" is
  // mostly an outcome. Reading it the other way round would be true and useless.
  const gate = daily.find((h) => PAUSE_METRICS.has(h.metric));
  if (!gate) return null;

  const from = addDays(ctx.today, -(COMPARE_WINDOW_DAYS - 1));
  let best = null;
  for (const subject of daily) {
    if (subject.habitId === gate.habitId) continue;
    const r = compareDays(ctx.state, gate.habitId, subject.habitId, ctx.me, from, ctx.today);
    if (!r) continue;
    // Most evidence wins, so the card does not flip between habits every time one day lands.
    const weight = r.met.days + r.missed.days;
    if (!best || weight > best.weight) best = { subject, r, weight };
  }
  if (!best) return null;

  const { subject, r } = best;
  const better = r.delta > 0;
  const gap = fmt.value(subject.metric, Math.abs(r.met.average - r.missed.average));
  const on = fmt.value(subject.metric, r.met.average);

  return el("section.sec",
    el("div.sec-hd",
      el("h2.sec-title", "Worth noticing"),
      el("span.sec-note", "last " + COMPARE_WINDOW_DAYS + " days"),
    ),
    el("div.card.insight",
      el("p.insight-line",
        el("strong", "On the " + r.met.days + " days you kept " + (gate.name || "screen time") + " under, "),
        "you averaged " + on + " " + (subject.name || "").toLowerCase() + ".",
      ),
      // The comparison, stated as a difference rather than a cause. Three friends over a month is
      // not evidence that one thing produced the other, and the sentence should not imply it did.
      el("p.insight-note", better
        ? "That's " + gap + " " + (subject.direction === AT_MOST ? "fewer" : "more")
          + " than the " + r.missed.days + " days you didn't."
        : r.met.average === r.missed.average
          ? "Which is the same as the " + r.missed.days + " days you didn't — no difference either way."
          : "The " + r.missed.days + " days you didn't were actually better, by " + gap + "."),
    ),
  );
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
  // Tapered to the end of the period, but read against the goal in force at its START — the
  // same pair the engine scores with, so the card can never show a target the verdict disagrees
  // with.
  const target = targetFor(
    ctx.state, habit, ctx.me, periodEnd(key, habit.period), periodStart(key, habit.period),
  );
  const status = rawPeriodStatus(ctx.state, habit, ctx.me, key);
  const cadence = CADENCE[habit.period] || "";
  const source = sourceFor(ctx.state, habit, ctx.me);
  const src = fmt.source(source);
  const reduce = habit.direction === AT_MOST;
  // An urge is a discrete thing that happens and can be talked out of; screen time is a running
  // total nobody interrupts. Only the first kind gets the intervention button.
  //
  // Keyed off what the habit IS, not off who feeds it. It used to require a Pause-sourced habit,
  // and nothing can read vape puffs, so every habit created through the editor bound to manual and
  // the intervention was unreachable for all of them — the flow only worked in the demo, where the
  // binding was written by hand.
  const intervention = isInterventionHabit(habit);
  // Something fills this in already, so the button is an override rather than the way in.
  const auto = AUTOMATIC_SOURCES.has(source) && !intervention;

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
        ? fmt.value(habit.metric, Math.max(0, target - (value || 0)))
        : fmt.value(habit.metric, value)),
      // A paced habit says where the line is TONIGHT, not just where the week ends. "1 of 3" is a
      // number you can answer; "you are 0.43 behind" is not, and a pace nobody can picture is a
      // pace nobody runs.
      habit.period !== PERIOD.DAY && !reduce
        ? el("div.card-of",
            (value || 0) + " of " + fmt.value(habit.metric, target) + " " + cadence
            + " · " + expectedBy(habit, ctx.today) + " by tonight")
        : null,
      // The paced line above already said the target and the cadence, so this one would repeat it.
      habit.period !== PERIOD.DAY && !reduce ? null : el("div.card-of", reduce
        ? "left of " + fmt.value(habit.metric, target) + " " + (cadence || "today")
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
    //
    // BOTH, for an intervention habit. It had only the first, which meant the one habit in the app
    // whose number comes off a device you read yourself was the only one with nowhere to type it —
    // you could ask to be talked out of vaping and had no way to say what actually happened.
    intervention ? el("button.tap", { onclick: () => ctx.onUrge(habit) }, "I want to vape 💨") : null,
    el("button.logbtn", { onclick: () => ctx.onLog(habit) },
      intervention ? "Enter today's count"
        : auto ? "Enter it manually"
        : "＋ Log"),
  );
}

function progressBar(value, target) {
  const pct = target > 0 ? Math.min(100, Math.round(((value || 0) / target) * 100)) : 0;
  return el("div.bar", { role: "presentation" }, el("i", { style: "width:" + pct + "%" }));
}

/**
 * A reduce habit's budget, draining as it is used. Capped so a very bad day still renders.
 *
 * The dots are a PROPORTION, not a tally. That distinction did not exist while every reduce habit
 * had a target you could count on your fingers — with a target of 8, one dot was one urge. A
 * ninety-minute screen budget broke it: 46 minutes used to subtract 46 from twelve dots and drain
 * every one of them, so the best day of the week rendered identically to the worst.
 */
function budgetDots(value, target) {
  // Ten, not twelve: at 8px plus a 4px gap, twelve will not fit across a half-width card and
  // wraps a single orphan dot onto its own line, which reads as a rendering fault rather than
  // as a budget.
  const shown = Math.max(1, Math.min(target, 10));
  const used = target > 0
    ? Math.min(shown, Math.round(((value || 0) / target) * shown))
    : shown;
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
  const filter = ctx.boardCategory || null;

  // Only the categories somebody in the group is actually running. A filter for a category nobody
  // tracks is a tab that leads to an empty screen and a question about whether it is broken.
  const live = CATEGORY_ORDER.filter((c) => [...ctx.state.habits.values()].some(
    (h) => h.scored && categoryOf(h) === c,
  ));

  const ranked = filter
    ? rows
        .map((r) => ({ ...r, pct: categoryOver(ctx.state, r.memberId, from, ctx.today, filter, addDays).pct }))
        .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
        .map((r, i) => ({ ...r, rank: i + 1, crown: false, clown: false }))
    : rows;

  if (ctx.boardSeason) return seasonSection(ctx, members);

  return el("section.sec",
    el("div.sec-hd",
      el("h2.sec-title", "The board"),
      el("button.link.sec-note", { onclick: () => ctx.onBoardSeason(true) }, "All time →"),
    ),
    live.length > 1 ? el("div.chips.chips-tight",
      el("button.chip" + (!filter ? ".on" : ""), {
        onclick: () => ctx.onBoardCategory(null),
      }, "Overall"),
      live.map((c) => el("button.chip" + (filter === c ? ".on" : ""), {
        onclick: () => ctx.onBoardCategory(c),
      }, CATEGORY_ICON[c] + " " + CATEGORY_LABEL[c])),
    ) : null,
    filter ? el("p.sec-note", { style: "padding:0 2px" },
      CATEGORY_LABEL[filter] + " only — scored on its own terms, not as a share of the day.") : null,
    el("div.board", ranked.map((r) => boardRow(r, ctx))),
    el("p.sec-note", { style: "padding:0 2px" },
      "Rest days and days with no data are left out of the score — you're measured on the days you were actually asked to show up."),
  );
}

/**
 * The long game: every completed week has a winner, and the crowns stack up.
 *
 * A weekly board resets every Monday, which is fair and forgettable — nothing carries, so a
 * brilliant February is worth exactly as much as last week. Points are the number that makes it a
 * season: they only ever go up, one bad week cannot dent them, and they reward whoever kept
 * showing up over whoever had a single enormous fortnight.
 */
function seasonSection(ctx, members) {
  const { weeks, rows } = seasonTally(ctx.state, members, ctx.today);

  return el("section.sec",
    el("div.sec-hd",
      el("h2.sec-title", "All time"),
      el("button.link.sec-note", { onclick: () => ctx.onBoardSeason(false) }, "← This week"),
    ),
    weeks === 0
      ? el("p.sec-note", { style: "padding:0 2px" },
          "Nothing to tally yet — the first week has to finish. This week's board is still live.")
      : el("div.board", rows.map((r) => el("article.row" + (r.memberId === ctx.me ? ".is-me" : "")
          + (r.rank === 1 && r.crowns > 0 ? ".is-crown" : ""),
          el("div.row-rank", r.rank === 1 && r.crowns > 0 ? "👑" : String(r.rank)),
          el("div.row-main",
            el("div.row-name", r.memberId === ctx.me ? "You" : r.name),
            el("div.row-meta",
              r.crowns + (r.crowns === 1 ? " week won" : " weeks won"),
              r.weeks ? " of " + r.weeks : "",
              r.bestCrownStreak > 1 ? " · best run " + r.bestCrownStreak : "",
              r.crownStreak > 1 ? " · 🔥 " + r.crownStreak + " in a row" : "",
            ),
            el("div.row-meta",
              r.avg === null ? "nothing scored yet" : "averaging " + r.avg + "%",
              r.best ? " · best week " + r.best.pct + "%" : "",
            ),
          ),
          el("div.row-pct", String(r.points)),
        ))),
    weeks > 0 ? el("p.sec-note", { style: "padding:0 2px" },
      "Points are every week you have played, added up — they only go up, so one bad week costs "
      + "you the crown and not the season. " + weeks + (weeks === 1 ? " week" : " weeks")
      + " counted so far.") : null,
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
        // Days nothing was reported. They cost nothing on purpose — a watch that stopped is not a
        // failure — but nothing was the same as saying so, which made silence the cheapest way to
        // avoid a bad week. Shown rather than scored: the group can see it, and the number is the
        // person's own to explain.
        row.noData ? el("span.row-quiet", " · " + row.noData + " not reported") : null,
      ),
    ),
    el("div.row-pct", row.pct == null ? "—" : row.pct + "%"),

    // Which category carried the week and which sank it. The percentage says where somebody came;
    // this says what to do about it on Monday, which is the only part anybody can act on.
    row.pct != null ? el("div.row-parts", categoryBreakdown(
      ctx.state, row.memberId, addDays(ctx.today, -(isoDayOfWeek(ctx.today) - 1)), ctx.today,
    ).map((part) => el("span.part" + (part.pct >= 100 ? ".is-full" : part.pct < 50 ? ".is-low" : ""),
      CATEGORY_ICON[part.category] + " " + part.pct + "%"))) : null,
    // The fairness rule, made visible. If the bottom row had a silent pipeline there is no clown
    // at all this week — and the person is told why, and offered the fix, rather than left to
    // wonder why their numbers look bad.
    row.clownSuppressed
      ? el("div.note",
          el("div",
            el("b", row.memberId === ctx.me ? "Nothing came through from your phone"
              : "Nothing came through from " + (row.name || "them")),
            " — nothing to score, so nobody is the clown this week.",
          ),
          el("button", { onclick: () => ctx.onFixSync(row) },
            row.memberId === ctx.me ? "Why? →" : "What they should check →"),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

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
    // Goal changes belong in the feed. They are the one thing a person can do that moves their own
    // score without doing anything, and they were completely invisible: the number simply became
    // easier and the board reflected it. They cannot rewrite the past any more, but "quietly" was
    // half of what made it worth doing.
    if (e.type === T.GOAL) {
      const g = e.payload || {};
      const habit = ctx.state.habits.get(g.habitId);
      if (!habit) continue;
      const key = "goal|" + g.habitId + "|" + g.memberId + "|" + e.eventId;
      if (seen.has(key)) continue;
      seen.add(key);
      const who = g.memberId === ctx.me ? "You" : (ctx.state.members.get(g.memberId)?.name || "Someone");
      out.push(el("div.ev",
        el("span", "🎯"),
        el("span.ev-when", fmt.whenLabel(e.ts, ctx.now)),
        el("span.ev-what", el("b", who), " ", goalPhrase(habit, g)),
      ));
      continue;
    }
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
        el("b", who), " ", verbFor(habit, shown, p.source),
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

/** A goal change, in the fewest words that still say what happened. */
function goalPhrase(habit, payload) {
  const name = (habit.name || "a habit").toLowerCase();
  if (payload.active === false) return "stopped tracking " + name;
  if (payload.target == null) return "changed their " + name + " goal";
  return "set their " + name + " goal to " + fmt.value(habit.metric, Number(payload.target));
}

function verbFor(habit, value, source) {
  if (habit.aggregate === AGGREGATE.SUM) {
    return value === 0 ? "resisted an urge" : "logged " + (habit.name || "a habit").toLowerCase();
  }
  const name = (habit.name || "").toLowerCase();
  if (value == null) return "updated " + (name || "a habit");
  // Nobody logged their screen time; the phone counted it while they were not thinking about it,
  // and saying "logged" credits them with an act of discipline they did not perform.
  const verb = source === SOURCE.PAUSE ? "spent" : "logged";
  return verb + " " + fmt.value(habit.metric, value) + " " + name;
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
