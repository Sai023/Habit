// habitsheet.js — what the group is tracking, and the way into changing it.
//
// This was a root tab. It did not earn one: it is a list you consult when setting something up and
// then leave alone for weeks, sitting permanently beside the two screens people actually open
// every day. Worse, once the app became native tabs inside Pause it was a third bar item competing
// with a bar the shell already draws.
//
// So it is a sheet now, reached from the header, and the two things it exists for — your own
// targets, and adding or editing a habit — open from inside it.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { targetOn, sourceFor, periodKey, periodEnd } from "../habits.js";
import { AT_MOST, VISIBILITY, PERIOD } from "../schema.js";
import * as fmt from "./format.js";

const CADENCE = { [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };

export function openHabitsSheet(
  host,
  { state, me, today, onEditHabit, onEditGoals, onOpenSettings, onInvite, embedded = false, onClosed },
) {
  const sheet = openSheet(host, { onClose: () => { if (onClosed) onClosed(); } });
  const habits = [...state.habits.values()];

  /** Hand off to another sheet: close this one first so they never stack. */
  const handOffTo = (open) => { sheet.close(); open(); };

  sheet.paint(
    el("div.sheet-head",
      el("span.sheet-title", "Habits"),
    ),
    el("p.sheet-now",
      habits.length
        ? "What the group is tracking. Tap one to change it."
        : "Nothing tracked yet. Add the first one and the group can start showing up for it.",
    ),

    habits.length
      ? el("div.board", habits.map((habit) => habitRow(habit, state, me, today, handOffTo, onEditHabit)))
      : null,

    el("div.sheet-actions",
      el("button.ghost", { onclick: () => handOffTo(() => onEditGoals()) }, "My goals"),
      el("button.tap", { onclick: () => handOffTo(() => onEditHabit(null)) }, "＋ New habit"),
    ),

    // Reachable every time, not once at the end of onboarding. Somebody joins the group months
    // after it was made, and the code to hand them has to be findable on that day.
    onInvite
      ? el("button.link", { onclick: () => handOffTo(() => onInvite()) }, "Invite someone →")
      : null,

    // One destination for everything that is about the person rather than about a habit: their
    // name, their group, what this phone shares, the reminders, the permissions and the backup.
    // Those used to be spread over two screens with different names, and the backup in particular
    // sat under the screen-time limits, which it has nothing to do with.
    //
    // Only when there IS a shell, because in a browser there is nothing to open and a dead row is
    // worse than a missing one.
    embedded && onOpenSettings
      ? el("button.link", { onclick: () => handOffTo(() => onOpenSettings()) },
          "You — name, group, reminders, backup →")
      : null,
  );

  return sheet;
}

function habitRow(habit, state, me, today, handOffTo, onEditHabit) {
  const src = fmt.source(sourceFor(state, habit, me));
  const target = targetOn(habit, periodEnd(periodKey(today, habit.period), habit.period));

  return el("article.row.tappable", {
    style: "grid-template-columns: 26px minmax(0,1fr)",
    role: "button",
    tabindex: "0",
    onclick: () => handOffTo(() => onEditHabit(habit.habitId)),
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handOffTo(() => onEditHabit(habit.habitId)); }
    },
  },
    el("div.row-rank", habit.icon || "◆"),
    el("div.row-main",
      el("div.row-name", habit.name || "Habit"),
      el("div.row-meta",
        (habit.direction === AT_MOST ? "At most " : "At least ") + fmt.value(habit.metric, target),
        // Weekday scheduling only means something for a daily habit — "3 days a week" would be a
        // contradiction printed next to a weekly target.
        habit.period === PERIOD.DAY
          ? (habit.days.length === 7 ? " · every day" : " · " + habit.days.length + " days a week")
          : " · " + CADENCE[habit.period],
        habit.taper ? " · tapering" : "",
        habit.weight !== 1 ? " · counts " + habit.weight + "×" : "",
      ),
      el("div.row-meta",
        src.icon + " " + src.label,
        habit.visibility === VISIBILITY.PROGRESS ? " · 🔒 count hidden" : "",
        habit.visibility === VISIBILITY.PRIVATE ? " · 🔒 private" : "",
        habit.scored ? "" : " · not scored",
      ),
    ),
  );
}
