// programs.js — the two personal workout programs, as data.
//
// ---- Where these came from ----
//
// Two documents, one each: "Match Fit" and "Rope Protocol". Each is a weekly schedule of sessions,
// each session an ordered list of exercises with a prescription, a step-by-step description, a
// cue and a thing to watch for. This file is that structure, so the app can put a session on
// screen and take reps against it. When a plan changes, this file changes — programs are not
// edited in the app, by decision, because neither person has asked to edit mid-plan and a program
// editor would be a second feature the size of this one.
//
// ---- Why the descriptions are all here ----
//
// The first cut kept the cue and the watch-for and dropped the four lines that say how to do the
// movement. That was wrong for the one thing this feature is for: reps counted against bad form
// are not progress, and a person who has never done a hollow body hold needs to be told what one
// is before being asked how many seconds they held it. So every exercise carries its steps, the
// program carries its before-you-start notes, and the session screen shows them where they are
// needed — on the exercise you are about to do, the first time you do it that day.
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
// The schedule is a SUGGESTION. It says which session the document puts on which day, and the
// app suggests that one; it never refuses another. People shift days, and the job here is to keep
// the record of what was done, not to police when.

/** ISO weekdays, so a schedule reads Monday-first the way the documents do. */
const MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6, SUN = 7;

/** Shorthand for an exercise line. reps OR seconds, never both. */
const ex = (id, name, sets, spec, notes = {}) => ({ id, name, sets, ...spec, ...notes });
const reps = (lo, hi = lo) => ({ reps: [lo, hi] });
const secs = (lo, hi = lo) => ({ seconds: [lo, hi] });

// ---------------------------------------------------------------------------
// Movements both programs share. One author wrote both, and the same exercise is described the
// same way in each — so it is defined once and the description is the description.
// ---------------------------------------------------------------------------

const SUPERMAN = {
  steps: [
    "Lie face down, arms extended out in front of you, legs extended straight behind you.",
    "Brace your stomach gently, then lift your arms, chest, and legs a few inches off the floor together.",
    "Hold for a one-second squeeze at the top, focusing on your lower back and glutes.",
    "Lower everything back down under control and repeat.",
  ],
  cue: "Reach long through your fingers and toes rather than yanking upward.",
  watch: "Shrugging your shoulders up to your ears — keep your neck long, eyes down.",
};
const PLANK = {
  steps: [
    "Forearms on the floor, elbows under your shoulders, legs extended behind you.",
    "Squeeze your glutes and brace your stomach, forming one straight line head to heels.",
    "Hold, breathing normally, for the target time.",
  ],
  cue: "Imagine bracing for a light tap to the stomach.",
  watch: "Hips riding up high — that avoids the work rather than easing it.",
};
const GLUTE_BRIDGE = {
  steps: [
    "Lie on your back, knees bent, feet flat, heels close to your glutes.",
    "Squeeze your glutes and push through your heels to lift your hips up.",
    "Pause at the top for a one-second squeeze — a straight line from knees to shoulders.",
    "Lower under control and repeat.",
  ],
  cue: "Squeeze a coin between your glutes at the top.",
  watch: "Pushing through your toes instead of your heels.",
};
const TABLE_ROW = {
  steps: [
    "Find a sturdy table or a low, stable desk. Lie on your back underneath it and grip the edge with both hands, arms extended.",
    "Keep your body straight from shoulders to heels, heels planted on the floor.",
    "Pull your chest up toward the table edge, squeezing your shoulder blades together.",
    "Lower back down under control until your arms are straight again.",
  ],
  cue: "Bend your knees and bring your feet in closer to make it easier; straighter legs make it harder.",
  watch: "Hips sagging — keep that straight line. No sturdy table? Loop a towel under your feet and row the ends to your ribs, seated.",
};
const DEAD_BUG = {
  steps: [
    "Lie on your back, arms reaching straight up, knees bent 90° over your hips.",
    "Press your lower back flat into the floor and keep it there the whole set.",
    "Slowly extend one arm overhead and the opposite leg out straight, hovering just above the floor.",
    "Return to the start and switch sides.",
  ],
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
  warmup: "Start every session with 5 minutes of light movement — arm circles, leg swings, a slow jog on the spot — before the first rep.",
  before: {
    title: "Before you start",
    points: [
      "Zero structured strength training until now means the biggest risk this month isn't under-training — it's overdoing week one and being too sore to enjoy Thursday's tennis.",
      "Start every session with 5 minutes of light movement — arm circles, leg swings, a slow jog on the spot — before the first rep.",
      "Sharp joint pain (not the dull muscle burn of a hard set) means stop and swap to an easier version: a knee push-up, a shallower squat, a shorter hold.",
      "If a week gets away from you, two sessions done beats four sessions planned. Consistency beats any single brutal week.",
      "This is a general training structure, not a substitute for individualised medical advice. Progress at whatever pace your joints, recovery and tennis schedule actually allow.",
    ],
  },
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
          steps: [
            "Hands slightly wider than your shoulders, body in a straight line from head to heels.",
            "Brace your stomach and squeeze your glutes before you move.",
            "Lower your chest to just above the floor, elbows at about 45° from your body.",
            "Press back up to straight arms without letting your hips sag or pike.",
          ],
          cue: "Not there yet? Drop to your knees, same straight line from knees to head.",
          watch: "Hips sagging low or piking up — both mean the core isn't holding the line.",
        }),
        ex("pike-pushup", "Incline pike push-up", 3, reps(6, 10), {
          steps: [
            "Place your hands on a sturdy chair seat, low step, or couch edge, feet on the floor behind you.",
            "Walk your feet in toward your hands until your hips are high, forming a bent-over V shape.",
            "Bend your elbows to lower the top of your head toward your hands.",
            "Press back up through your palms to the starting position.",
          ],
          cue: "Your shoulder-press substitute — the higher the surface, the easier. Lower it as it gets comfortable, and work toward hands-on-floor down the line.",
          watch: "Elbows flaring straight out sideways — keep them tracking over your fingers.",
        }),
        ex("dip", "Tricep dip", 3, reps(8, 12), {
          steps: [
            "Sit on the edge of a sturdy chair or low couch, hands gripping the edge beside your hips.",
            "Walk your feet out, straighten your legs a little, and slide your hips off the front of the seat.",
            "Bend your elbows to lower your hips straight down, staying close to the chair.",
            "Press through your palms to straighten your arms back up.",
          ],
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
          steps: [
            "Stand with feet shoulder-width apart, toes turned slightly out.",
            "Push your hips back and bend your knees to lower down, chest up, heels planted.",
            "Go as low as you comfortably can with good form — ideally thighs parallel to the floor.",
            "Drive through your heels to stand back up to full height.",
          ],
          cue: "Reach your arms forward as you descend — a free counterbalance to sit back further.",
          watch: "Heels lifting off the floor or knees caving inward.",
        }),
        ex("reverse-lunge", "Reverse lunge", 3, reps(10), {
          perSide: true,
          steps: [
            "Stand tall, feet hip-width apart.",
            "Step one foot back and lower your back knee straight down toward the floor.",
            "Both knees land at roughly 90° — front shin vertical, back heel lifted.",
            "Push through your front heel to stand back up, then repeat on the other side.",
          ],
          cue: "Take a bigger step back than feels natural — it protects the front knee.",
          watch: "Front knee travelling out past your toes — lengthen your stance if it does.",
        }),
        ex("glute-bridge", "Glute bridge", 3, reps(15, 20), GLUTE_BRIDGE),
        ex("table-row", "Table row", 3, reps(10, 15), TABLE_ROW),
        ex("hollow-hold", "Hollow body hold", 3, secs(20, 30), {
          steps: [
            "Lie on your back, arms extended overhead, legs extended long.",
            "Press your lower back flat into the floor and lift your shoulders and legs a few inches up.",
            "Hold that \"banana\" shape, arms and legs hovering, lower back glued to the floor.",
            "If your back arches, bring your legs up higher or bend your knees until it doesn't.",
          ],
          cue: "Reach long through your fingers and toes — the longer the lever, the harder it works.",
          watch: "Lower back lifting off the floor — shorten the range immediately if it does.",
        }),
      ],
    },
    "circuit": {
      id: "circuit", name: "Metabolic Circuit", kind: "circuit",
      rounds: [3, 4], restSeconds: 75,
      intro: "All five back to back with only enough rest to move to the next one, then 60–90 seconds at the end of a round. Three to four rounds. This is the one day built for a raised heart rate over raw strength.",
      exercises: [
        ex("pushup", "Push-up", 3, reps(10, 15), {
          steps: [
            "Same push-up as Monday — hands slightly wider than shoulders, straight line head to heels.",
            "Lower your chest to just above the floor, elbows at about 45°.",
            "Press back up without letting your hips sag or pike.",
          ],
          cue: "Drop to knee push-ups the moment your form starts to break down mid-circuit.",
          watch: "Rushing reps — the circuit is about the heart rate, not the count.",
        }),
        ex("squat-jump", "Squat jump", 3, reps(12, 15), {
          steps: [
            "Start standing, then drop into a quarter-to-half squat.",
            "Swing your arms back, then explode upward, driving through your feet until they leave the floor.",
            "Land softly, bending your knees to absorb the impact.",
            "Reset for a beat, then go straight into the next rep.",
          ],
          cue: "A quiet landing means you're absorbing the impact properly.",
          watch: "Landing stiff-legged — that's where knees get cranky. Keep landings soft.",
        }),
        ex("table-row", "Table row", 3, reps(10, 15), TABLE_ROW),
        ex("mountain-climber", "Mountain climber", 3, secs(30, 40), {
          steps: [
            "Start in a high plank, hands under your shoulders, body straight.",
            "Drive one knee up toward your chest, then quickly switch — like running in place horizontally.",
            "Keep your hips low and stable; the movement comes from your hips and knees, not a bouncing back.",
            "Keep the pace controlled at first — speed comes once the form holds.",
          ],
          cue: "Imagine a glass of water balanced on your lower back — keep it steady.",
          watch: "Hips bouncing up and down instead of staying level.",
        }),
        ex("shoulder-tap", "Plank shoulder tap", 3, reps(16, 20), {
          unit: "taps",
          steps: [
            "Start in a high plank, feet a little wider than usual for stability.",
            "Without rotating your hips, lift one hand and tap the opposite shoulder.",
            "Place it back down and repeat with the other hand.",
            "Keep your hips as still and square to the floor as possible throughout.",
          ],
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
      steps: [
        "Lie on your side, propped on one forearm, elbow under your shoulder.",
        "Stack your feet (or stagger them for more stability) and lift your hips off the floor.",
        "Reach your free arm straight up — a straight line from ankles to shoulders.",
        "Hold, then switch sides. Too hard on day one? Drop your bottom knee to the floor for support and hold from there.",
      ],
      cue: "Lift your hips toward the ceiling, not just off the floor.",
      watch: "Hips sinking or rotating forward — keep them stacked.",
    }),
  ],
};

const ROPE_PROTOCOL = {
  id: "rope-protocol",
  name: "Rope Protocol",
  tagline: "Four working days, three recovery days. Strength never lands back to back; the rope days sit between them.",
  warmup: "Five minutes of easy movement before the first rep or the first skip — a slow march, arm circles, ankle rolls.",
  // The document's specifics — a BMI, a weight, a waist ratio — are left out on purpose. This
  // file ships in the app bundle every phone loads, and the advice stands without the numbers.
  before: {
    title: "Safety first",
    points: [
      "A GP check-up — blood pressure, heart, joints — before starting is a genuinely good idea, not box-ticking, and especially before adding jump-rope impact.",
      "Stop a session and seek medical advice for chest pain or tightness, unusual shortness of breath, dizziness, or joint pain that doesn't ease within a day.",
      "Supportive, cushioned shoes for every rope and step-up session. Skip on a sprung or grass surface, never concrete, and stop the moment either shin hurts.",
      "Weight loss is driven mainly by a sustained food deficit. This plan builds the fitness and muscle side; pairing it with dietary guidance is what gets the number moving.",
      "This is a general training structure, not a substitute for individualised medical advice. Progress at the pace your joints and recovery actually allow.",
    ],
  },
  restNote: "Three days a week with no structured training isn't wasted — it's where the adaptation happens, and at this stage it protects against the overuse injuries that end a lot of new routines by week six. Wednesday and Sunday genuinely off; Saturday optional stretching or a slow walk. Sleep and protein on rest days matter as much as the sessions.",
  // The progression counts weeks from here. Week 1 is the week containing this day.
  startDay: "2026-09-02",
  schedule: {
    [MON]: "strength-a",
    [TUE]: "rope",
    [WED]: { rest: "Rest" },
    [THU]: "strength-b",
    [FRI]: "rope",
    [SAT]: { rest: "Mobility", note: "Optional 10 minutes of stretching or a slow walk. Nothing to log." },
    [SUN]: { rest: "Full rest" },
  },
  sessions: {
    "strength-a": {
      id: "strength-a", name: "Strength A", kind: "sets", restSeconds: 60,
      exercises: [
        ex("chair-squat", "Chair squat", 3, reps(8, 12), {
          steps: [
            "Sit toward the front edge of a sturdy chair, feet flat, shoulder-width apart.",
            "Lean your chest slightly forward and push through your heels to stand all the way up.",
            "Reverse slowly — hips back, knees bending — until you tap the seat.",
            "Don't plop down — control the last few inches every time.",
          ],
          cue: "Push the floor away, don't just “stand up.”",
          watch: "Knees caving inward — keep them tracking over your toes.",
        }),
        ex("incline-pushup", "Incline push-up", 3, reps(8, 12), {
          steps: [
            "Place both hands on a sturdy counter or table edge, slightly wider than your shoulders.",
            "Walk your feet back until your body forms a straight line from head to heels.",
            "Bend your elbows to lower your chest toward the counter, elbows near 45° from your body.",
            "Press back up to straight arms without letting your hips sag.",
          ],
          cue: "A higher surface is easier — lower it as reps get easy.",
          watch: "Hips sagging or piking up — keep that plank line straight.",
        }),
        ex("rdl", "Dumbbell Romanian deadlift", 3, reps(10), {
          steps: [
            "Stand tall holding a light dumbbell (3 kg is plenty to start) in each hand, in front of your thighs.",
            "Soften your knees slightly and keep them still for the whole movement.",
            "Push your hips straight back, letting the weight slide down your shins, chest staying open.",
            "Stop at a hamstring stretch, then drive your hips forward to stand tall again.",
          ],
          cue: "Think “close a door with your hips,” not “bend over.”",
          watch: "Rounding the lower back — stop the descent before it curves.",
        }),
        ex("table-row", "Table row", 3, reps(8, 12), TABLE_ROW),
        ex("incline-plank", "Wall / incline plank", 3, secs(20, 30), {
          steps: [
            "Place your forearms on a wall, countertop, or bench, feet walked back to your incline.",
            "Squeeze your glutes and brace your stomach so your body forms one straight line.",
            "Hold, breathing normally, for the target time.",
            "Lower the surface height over the weeks to make it harder.",
          ],
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
          steps: [
            "Place one whole foot flat on a low step or stair.",
            "Drive through that heel to stand fully onto the step, letting the back leg lift naturally.",
            "Control the descent back down — don't just drop.",
            "Finish all reps on one side before switching legs.",
          ],
          cue: "Push the step away from you, don't push off the back foot.",
          watch: "Wobbling knee — pick a lower step until it feels stable.",
        }),
        ex("floor-press", "Dumbbell floor press", 3, reps(10, 12), {
          steps: [
            "Lie on your back on the floor, knees bent, feet flat, a dumbbell in each hand at chest height.",
            "Press the dumbbells straight up until your arms are extended.",
            "Lower slowly until your upper arms touch the floor — that's your depth limit.",
            "Press back up and repeat.",
          ],
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
        steps: [
          "Hold the handles lightly, elbows close to your body — your wrists turn the rope, not your arms.",
          "Keep a small, soft bounce, landing on the balls of your feet each time.",
          "Jump only high enough to clear the rope — a centimetre or two off the floor.",
          "Keep your eyes up and your breathing steady, not staring at your feet.",
        ],
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
          note: "Roughly where the first goal lands — reassess pace here." },
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
