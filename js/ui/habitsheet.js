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
import { targetOn, sourceFor, periodKey, periodEnd, visibilityFor } from "../habits.js";
import { AT_MOST, VISIBILITY, PERIOD } from "../schema.js";
import * as fmt from "./format.js";

const CADENCE = { [PERIOD.WEEK]: "this week", [PERIOD.MONTH]: "this month" };

export function openHabitsSheet(
  host,
  {
    state, me, today, onEditHabit, onEditGoals, onOpenSettings, onInvite,
    onRemoveMember, embedded = false, onClosed,
  },
) {
  const sheet = openSheet(host, { onClose: () => { if (onClosed) onClosed(); } });
  const habits = [...state.habits.values()];
  const members = [...state.members.values()].map((m) => ({
    ...m,
    // What this id has ever put into the log. The number that tells two identical names apart.
    logged: countLogs(state, m.memberId),
  }));

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

    // Who is actually in the room.
    //
    // Here because of one specific mess it exists to clean up: a person can end up with two member
    // ids — a rejoin, a reinstall, one wrong code pasted once — and the second sits on the board at
    // zero per cent for ever. Until now nothing could take it off, because members were
    // append-only, and a season started on top of that would carry the ghost the whole way.
    //
    // Each row says what that id has actually reported, because the only safe way to remove the
    // right one of two identical names is to be shown which of them is empty.
    onRemoveMember && members.length > 1
      ? el("div.sec",
          el("h2.sec-title", "Who's in"),
          el("div.board", members.map((m) => memberRow(m, me, onRemoveMember, sheet))),
        )
      : null,

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
  const seen = visibilityFor(state, habit, me);
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

/** How many readings this member has ever contributed. */
function countLogs(state, memberId) {
  let n = 0;
  for (const key of state.logs.keys()) {
    // Keys are habitId|memberId|day — see logKey in habits.js.
    if (key.split("|")[1] === memberId) n += 1;
  }
  return n;
}

function memberRow(member, me, onRemoveMember, sheet) {
  const isMe = member.memberId === me;
  return el("article.row.member-row",
    el("div.row-main",
      el("div.row-name", member.name || "Someone", isMe ? el("span.row-meta", " · you") : null),
      el("div.row-meta", member.logged
        ? member.logged + (member.logged === 1 ? " reading logged" : " readings logged")
        : "nothing logged yet"),
    ),
    // Never yourself: removing your own row would leave this phone posting as somebody the room no
    // longer lists, which reads to everybody else as a broken pipeline.
    isMe ? null : el("button.link.danger.row-remove", {
      onclick: async () => {
        const { confirmSheet } = await import("./confirmsheet.js");
        sheet.close();
        const sure = await confirmSheet(document.body, {
          title: "Remove " + (member.name || "them") + "?",
          body: member.logged
            ? "They have " + member.logged + " readings logged. Those stay in the group's history — "
              + "they just stop appearing on the board and in the season."
            : "This one has never logged anything, so nothing is lost. It stops appearing on the "
              + "board and in the season.",
          confirmLabel: "Remove",
          cancelLabel: "Keep them",
        });
        if (sure) await onRemoveMember(member.memberId);
      },
    }, "Remove"),
  );
}
