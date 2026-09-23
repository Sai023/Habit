// habitsheet.js — what the group is tracking, and the way into changing it.
//
// This was a root tab. It did not earn one: it is a list you consult when setting something up and
// then leave alone for weeks, sitting permanently beside the two screens people actually open
// every day. Worse, once the app became native tabs inside Pause it was a third bar item competing
// with a bar the shell already draws.
//
// So it is a sheet now, reached from the header, and the two things it exists for — your own
// targets, and adding or editing a habit — open from inside it.
//
// ---- Two segments, not one long scroll ----
//
// This used to be a single scroll: the habit list, then Retired (every habit this group has ever
// deleted, unsorted, unbounded), then Who's in (the full roster, always shown), then Invite,
// Travel and the settings door — in that order. The group deletes and recreates habits often
// enough that Retired only ever grew, which meant the things worth reaching quickly (Invite, the
// settings door) got pushed further down every time the group used the app.
//
// Retired is gone from here entirely rather than collapsed: retiring a habit already removes it
// from state.habits, the map every scoring function reads, so browsing it back into view changed
// nothing about anyone's season — it was pure UI, no data behind it. Re-adding a habit under the
// same name already offers to bring the old one back (editor.js's matchRetired), so the recovery
// path still exists; this screen just isn't where you browse for it.
//
// "Who's in" is gone entirely, roster and Remove both — the board already answers who's in the
// group, so repeating names here was the clutter, and that goes for a collapsed copy of it too.
// The merge-repair hint stays visible unconditionally: it isn't a roster, it's a self-hiding
// prompt that only appears when a name actually sits split across two ids — an active repair, not
// standing content, so it doesn't carry the same redundancy.
//
// Travel mode moved to the board, next to the season strip it's actually about — see dashboard.js.

import { el } from "../dom.js";
import { openSheet } from "./sheet.js";
import { targetOn, sourceFor, periodKey, periodEnd, visibilityFor } from "../habits.js";
import { AT_MOST, VISIBILITY, PERIOD } from "../schema.js";
import { countMemberLogs, duplicateGroups, mergeTarget } from "../roster.js";
import * as fmt from "./format.js";

const CADENCE = { [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };

export function openHabitsSheet(
  host,
  {
    state, me, today, onEditHabit, onEditGoals, onOpenSettings, onInvite,
    onMergeMember, embedded = false, onClosed,
  },
) {
  const sheet = openSheet(host, { onClose: () => { if (onClosed) onClosed(); } });
  const habits = [...state.habits.values()];
  const members = [...state.members.values()].map((m) => ({
    ...m,
    // What this id has ever put into the log. The number that tells two identical names apart.
    logged: countMemberLogs(state, m.memberId),
  }));

  let segment = "habits"; // "habits" | "group"

  /** Hand off to another sheet: close this one first so they never stack. */
  const handOffTo = (open) => { sheet.close(); open(); };

  function paint() {
    sheet.paint(
      el("div.sheet-head", el("span.sheet-title", "Habits")),
      el("div.board-tabs",
        el("button.chip" + (segment === "habits" ? ".on" : ""), {
          onclick: () => { segment = "habits"; paint(); },
        }, "Habits"),
        el("button.chip" + (segment === "group" ? ".on" : ""), {
          onclick: () => { segment = "group"; paint(); },
        }, "Group"),
      ),
      segment === "habits" ? habitsSegment() : groupSegment(),
    );
  }

  function habitsSegment() {
    return [
      el("p.sheet-now",
        habits.length
          ? "What the group is tracking. Tap one to set your goal or opt out."
          : "Nothing tracked yet. Add the first one and the group can start showing up for it.",
      ),
      habits.length
        ? el("div.board", habits.map((habit) => habitRow(habit, state, me, today, handOffTo, onEditGoals)))
        : null,
      el("div.sheet-actions",
        // "Your goals", matching the destination's own H1 — not "All my goals", which reads like
        // it might mean the GROUP's full list. The group agrees on what's tracked; this is only
        // ever the personal half of that, and the sheet it opens already says so in its lede.
        el("button.ghost", { onclick: () => handOffTo(() => onEditGoals()) }, "Your goals"),
        el("button.tap", { onclick: () => handOffTo(() => onEditHabit(null)) }, "＋ New habit"),
      ),
    ];
  }

  function groupSegment() {
    return [
      // Same person on more than one id, from a rejoin or a reinstall. Unconditional — this is a
      // repair prompt, not standing content, and it hides itself the moment nothing needs fixing.
      onMergeMember ? duplicateGroups(members).map((g) => mergeRow(g, handOffTo, onMergeMember, sheet)) : null,

      // Reachable every time, not once at the end of onboarding. Somebody joins the group months
      // after it was made, and the code to hand them has to be findable on that day.
      onInvite
        ? el("button.tap", { onclick: () => handOffTo(() => onInvite()) }, "Invite someone")
        : null,

      // One destination for everything that is about the person rather than about a habit: their
      // name, their group, what this phone shares, the reminders, the permissions and the backup.
      // Only when there IS a shell, because in a browser there is nothing to open and a dead row is
      // worse than a missing one.
      embedded && onOpenSettings
        ? el("button.link", { onclick: () => handOffTo(() => onOpenSettings()) },
            "You — name, group, reminders, backup →")
        : null,
    ];
  }

  paint();
  return sheet;
}

function habitRow(habit, state, me, today, handOffTo, onEditGoals) {
  const seen = visibilityFor(state, habit, me);
  const src = fmt.source(sourceFor(state, habit, me));
  const target = targetOn(habit, periodEnd(periodKey(today, habit.period, habit.monthStart), habit.period, habit.monthStart));

  // A tap opens YOUR panel for this habit — your goal, opting in or out — not the shared editor.
  // Editing the group's definition is a link inside that panel now (see goals.js focus mode).
  const open = () => handOffTo(() => onEditGoals(habit.habitId));
  return el("article.row.tappable", {
    style: "grid-template-columns: 26px minmax(0,1fr)",
    role: "button",
    tabindex: "0",
    onclick: open,
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
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
        // YOUR setting, not the habit's. This list is what you are tracking, so a lock here has
        // to describe what the group sees of you — reading the habit's would have shown somebody
        // else's choice on your own row.
        seen === VISIBILITY.PROGRESS ? " · 🔒 count hidden" : "",
        seen === VISIBILITY.PRIVATE ? " · 🔒 private" : "",
        habit.scored ? "" : " · not scored",
      ),
    ),
  );
}

/** The offer to merge a duplicate-name group into its most-logged id. */
function mergeRow(group, handOffTo, onMergeMember, sheet) {
  const primary = mergeTarget(group);
  const others = group.filter((m) => m.memberId !== primary.memberId);
  const name = primary.name || "them";
  return el("div.merge-hint",
    el("span.merge-hint-text", group.length + " rows named “" + name + "” — the same person on more than one id."),
    el("button.link", {
      onclick: async () => {
        const { confirmSheet } = await import("./confirmsheet.js");
        sheet.close();
        const sure = await confirmSheet(document.body, {
          title: "Merge into one " + name + "?",
          body: "Their logs, streaks and board history combine under a single person. The extra "
            + (others.length === 1 ? "id folds" : others.length + " ids fold") + " into the one that has logged the most. "
            + "Nothing is deleted — it is one more event on the log — but it is not undone from inside the app.",
          confirmLabel: "Merge",
          cancelLabel: "Leave separate",
        });
        if (sure) for (const m of others) await onMergeMember(m.memberId, primary.memberId);
      },
    }, "Merge into one →"),
  );
}

