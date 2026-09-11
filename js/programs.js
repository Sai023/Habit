// programs.js — the two personal workout programs, as data.
//
// ---- Where these came from ----
//
// Two documents, one each: "Match Fit" and "Rope Protocol". Each is a weekly schedule of sessions,
// each session an ordered list of exercises with a prescription, a cue and a thing to watch for.
// This file is that structure with the prose stripped out, so the app can put today's session on
// screen and take reps against it. When a plan changes, this file changes — programs are not
// edited in the app, by decision, because neither person has asked to edit mid-plan and a program
// editor would be a second feature the size of this one.
//
// ---- The shapes ----
//
// A session is one of three kinds, and the kind decides what gets logged:
//
//   sets       ordinary strength work. Each exercise is `sets` sets of a rep range or a hold in
//              seconds. Logged as the number done in each set.
//   circuit    the same movements run back to back for a number of rounds, with rest only between
//              rounds. Logged exactly like sets — one entry per round per exercise — because that is
//              what it is; the difference is pacing, and the timer knows.
//   intervals  Ivan's rope days: work/rest/rounds that step up by week from the program's start
//              date. Logged as rounds completed at that week's work and rest. Followed by a core
//              finisher, which is a small `sets` session appended to the same day.
//
// A prescription is a RANGE, `[low, high]`, even when the two are the same. "3 x 10" is `[10, 10]`;
// "3 x 8-15" is `[8, 15]`. The low end is what a first set is prefilled with; after that, last
// time's number. `perSide` marks "10/side", which the card shows and the log does not double.
//
// Rest days carry a label so the schedule is visible on the day — "Rest", "Tennis", "Mobility" —
// and nothing to log. Tennis in particular is deliberately untracked: the document's own words are
// "nothing to add here, that's the point".

/** ISO weekdays, so a schedule reads Monday-first the way the documents do. */
const MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6, SUN = 7;

/** Shorthand for an exercise line. reps OR seconds, never both. */
const ex = (id, name, sets, spec, notes = {}) => ({ id, name, sets, ...spec, ...notes });
const reps = (lo, hi = lo) => ({ reps: [lo, hi] });
const secs = (lo, hi = lo) => ({ seconds: [lo, hi] });

// ---------------------------------------------------------------------------
// Shared exercises. Two programs, one author, and the same movement is written the same way in
// both — so it is defined once and the cue is the cue.
// ---------------------------------------------------------------------------

const SUPERMAN = {
  cue: "Reach long through your fingers and toes rather than yanking upward.",
  watch: "Shrugging your shoulders up to your ears — keep your neck long, eyes down.",
};
const PLANK = {
  cue: "Imagine bracing for a light tap to the stomach.",
  watch: "Hips riding up high — that avoids the work rather than easing it.",
};
const GLUTE_BRIDGE = {
  cue: "Squeeze a coin between your glutes at the top.",
  watch: "Pushing through your toes instead of your heels.",
};
const TABLE_ROW = {
  cue: "Bend your knees and bring your feet in closer to make it easier; straighter legs make it harder.",
  watch: "Hips sagging — keep that straight line. No sturdy table? Loop a towel under your feet and row the ends to your ribs, seated.",
};
const DEAD_BUG = {
  cue: "Move only as far as you can without your back arching off the floor.",
  watch: "Lower back lifting off the floor — shorten the range if it does.",
};

// ---------------------------------------------------------------------------
// Match Fit
// ---------------------------------------------------------------------------

const MATCH_FIT = {
  id: "match-fit",
  name: "Match Fit",
  tagline: "Push and pull on consecutive days, tennis as the cardio engine, one circuit day for the heart rate.",
  schedule: {
    [MON]: "push-core",
    [TUE]: "legs-pull",
    [WED]: { rest: "Rest" },
    [THU]: { rest: "Tennis", note: "Nothing to add here — that's the point." },
    [FRI]: "circuit",
    [SAT]: { rest: "Rest" },
    [SUN]: { rest: "Rest" },
  },
  sessions: {
    "push-core": {
      id: "push-core", name: "Push + Core", kind: "sets", restSeconds: 60,
      exercises: [
        ex("pushup", "Push-up", 3, reps(8, 15), {
          cue: "Not there yet? Drop to your knees, same straight line from knees to head.",
          watch: "Hips sagging low or piking up — both mean the core isn't holding the line.",
        }),
        ex("pike-pushup", "Incline pike push-up", 3, reps(6, 10), {
          cue: "Your shoulder-press substitute — the higher the surface, the easier. Lower it as it gets comfortable.",
          watch: "Elbows flaring straight out sideways — keep them tracking over your fingers.",
        }),
        ex("dip", "Tricep dip", 3, reps(8, 12), {
          cue: "Bent knees = easier. Straighten your legs further out to make it harder.",
          watch: "Shoulders creeping up toward your ears — keep them pulled down and back.",
        }),
        ex("superman", "Superman", 3, reps(10, 12), SUPERMAN),
        ex("plank", "Plank", 3, secs(30, 45), PLANK),
      ],
    },
    "legs-pull": {
      id: "legs-pull", name: "Legs + Pull", kind: "sets", restSeconds: 60,
      exercises: [
        ex("squat", "Squat", 3, reps(15, 20), {
          cue: "Reach your arms forward as you descend — a free counterbalance to sit back further.",
          watch: "Heels lifting off the floor or knees caving inward.",
        }),
        ex("reverse-lunge", "Reverse lunge", 3, reps(10), {
          perSide: true,
          cue: "Take a bigger step back than feels natural — it protects the front knee.",
          watch: "Front knee travelling out past your toes — lengthen your stance if it does.",
        }),
        ex("glute-bridge", "Glute bridge", 3, reps(15, 20), GLUTE_BRIDGE),
        ex("table-row", "Table row", 3, reps(10, 15), TABLE_ROW),
        ex("hollow-hold", "Hollow body hold", 3, secs(20, 30), {
          cue: "Reach long through your fingers and toes — the longer the lever, the harder it works.",
          watch: "Lower back lifting off the floor — shorten the range immediately if it does.",
        }),
      ],
    },
    "circuit": {
      id: "circuit", name: "Metabolic Circuit", kind: "circuit",
      rounds: [3, 4], restSeconds: 75,
      intro: "All five back to back with only enough rest to move to the next one, then 60–90 seconds at the end of a round.",
      exercises: [
        ex("pushup", "Push-up", 3, reps(10, 15), {
          cue: "Drop to knee push-ups the moment your form starts to break down mid-circuit.",
          watch: "Rushing reps — the circuit is about the heart rate, not the count.",
        }),
        ex("squat-jump", "Squat jump", 3, reps(12, 15), {
          cue: "A quiet landing means you're absorbing the impact properly.",
          watch: "Landing stiff-legged — that's where knees get cranky. Keep landings soft.",
        }),
        ex("table-row", "Table row", 3, reps(10, 15), TABLE_ROW),
        ex("mountain-climber", "Mountain climber", 3, secs(30, 40), {
          cue: "Imagine a glass of water balanced on your lower back — keep it steady.",
          watch: "Hips bouncing up and down instead of staying level.",
        }),
        ex("shoulder-tap", "Plank shoulder tap", 3, reps(16, 20), {
          unit: "taps",
          cue: "Slower is harder here — resist the urge to rush.",
          watch: "Hips rocking side to side with each tap — that's the anti-rotation challenge.",
        }),
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Rope Protocol
// ---------------------------------------------------------------------------

const ROPE_FINISHER = {
  name: "Core finisher", rounds: 3,
  exercises: [
    ex("plank", "Plank", 3, secs(20, 30), PLANK),
    ex("dead-bug", "Dead bug", 3, reps(8), { perSide: true, ...DEAD_BUG }),
    ex("side-plank", "Side plank", 3, secs(15, 20), {
      perSide: true,
      cue: "Lift your hips toward the ceiling, not just off the floor.",
      watch: "Hips sinking or rotating forward — keep them stacked.",
    }),
  ],
};

const ROPE_PROTOCOL = {
  id: "rope-protocol",
  name: "Rope Protocol",
  tagline: "Four working days, three recovery days. Strength never lands back to back; the rope days sit between them.",
  // The progression counts weeks from here. Week 1 is the week containing this day.
  startDay: "2026-09-02",
  schedule: {
    [MON]: "strength-a",
    [TUE]: "rope",
    [WED]: { rest: "Rest" },
    [THU]: "strength-b",
    [FRI]: "rope",
    [SAT]: { rest: "Mobility", note: "Rest, or gentle mobility. Nothing to log." },
    [SUN]: { rest: "Full rest" },
  },
  sessions: {
    "strength-a": {
      id: "strength-a", name: "Strength A", kind: "sets", restSeconds: 60,
      exercises: [
        ex("chair-squat", "Chair squat", 3, reps(8, 12), {
          cue: "Push the floor away, don't just “stand up.”",
          watch: "Knees caving inward — keep them tracking over your toes.",
        }),
        ex("incline-pushup", "Incline push-up", 3, reps(8, 12), {
          cue: "A higher surface is easier — lower it as reps get easy.",
          watch: "Hips sagging or piking up — keep that plank line straight.",
        }),
        ex("rdl", "Dumbbell Romanian deadlift", 3, reps(10), {
          cue: "Think “close a door with your hips,” not “bend over.”",
          watch: "Rounding the lower back — stop the descent before it curves.",
        }),
        ex("table-row", "Table row", 3, reps(8, 12), TABLE_ROW),
        ex("incline-plank", "Wall / incline plank", 3, secs(20, 30), {
          cue: "Squeeze your whole body — don't just hang from your shoulders.",
          watch: "Hips sagging down or piking up — keep that straight line.",
        }),
      ],
    },
    "strength-b": {
      id: "strength-b", name: "Strength B", kind: "sets", restSeconds: 60,
      exercises: [
        ex("step-up", "Step-up", 3, reps(8), {
          perSide: true,
          cue: "Push the step away from you, don't push off the back foot.",
          watch: "Wobbling knee — pick a lower step until it feels stable.",
        }),
        ex("floor-press", "Dumbbell floor press", 3, reps(10, 12), {
          cue: "The floor protects your shoulders — rest your upper arm on it each rep.",
          watch: "Flaring elbows out to 90° — keep them closer to a 45° angle.",
        }),
        ex("glute-bridge", "Glute bridge", 3, reps(12, 15), GLUTE_BRIDGE),
        ex("superman", "Superman", 3, reps(10, 12), SUPERMAN),
        ex("dead-bug", "Dead bug", 3, reps(8), { perSide: true, ...DEAD_BUG }),
      ],
    },
    "rope": {
      id: "rope", name: "Rope", kind: "intervals",
      basics: {
        cue: "Quiet feet — if you can hear yourself landing, you're jumping too high.",
        watch: "Landing flat-footed or stiff-legged — keep a soft bend in the knees and ankles.",
      },
      // Weeks are inclusive. `toWeek: null` is open-ended. Work and rest are ranges in seconds;
      // rounds a range. The card shows the range and the timer runs the LOW end until told
      // otherwise, because the document's own advice is to earn continuous skipping gradually.
      progression: [
        { fromWeek: 1, toWeek: 2, name: "Rope prep — no jumping", work: [30, 30], rest: [30, 30], rounds: [8, 8],
          note: "Boxer shuffle / low march, rope stays on the floor. Builds rhythm before impact." },
        { fromWeek: 3, toWeek: 4, name: "First skipping intervals", work: [20, 30], rest: [40, 60], rounds: [8, 10],
          note: "Basic bounce, small hops, land soft on the forefoot." },
        { fromWeek: 5, toWeek: 8, name: "Building intervals", work: [30, 45], rest: [30, 45], rounds: [8, 10],
          note: "Add alternate-foot step; rest shortens as it gets easier." },
        { fromWeek: 9, toWeek: 14, name: "Extended intervals", work: [45, 60], rest: [30, 30], rounds: [8, 8],
          note: "This is roughly where Goal 1 (95 kg) lands — reassess pace here." },
        { fromWeek: 15, toWeek: null, name: "Continuous blocks", work: [120, 180], rest: [60, 60], rounds: [4, 5],
          note: "Only progress here if joints feel clean through week 14." },
      ],
      finisher: ROPE_FINISHER,
    },
  },
};

export const PROGRAMS = {
  [MATCH_FIT.id]: MATCH_FIT,
  [ROPE_PROTOCOL.id]: ROPE_PROTOCOL,
};

/** The list, for a picker. */
export const PROGRAM_LIST = [MATCH_FIT, ROPE_PROTOCOL];
