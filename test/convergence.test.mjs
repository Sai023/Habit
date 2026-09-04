// convergence.test.mjs — two phones, one room, and whether they actually agree.
//
// Everything in this app rests on one claim: every device replaying the same log derives the same
// numbers. The engine tests check that a SHUFFLED list produces identical state, which is close
// but not the real thing — a real device does not see a shuffle, it sees its own writes without
// server stamps and everyone else's with them. That asymmetry is the whole reason restamping
// exists, and nothing until now exercised it.
//
// So this simulates the actual path: two devices writing, a server assigning arrival order, and
// each device pulling what it did not write.

import assert from "node:assert/strict";
import { planMerge } from "../js/sync.js";
import {
  replay, walk, valueOn,
} from "../js/habits.js";
import { leaderboard } from "../js/score.js";
import { ev, SOURCE, AT_LEAST, METRIC } from "../js/schema.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push({ name, err }); }
}

const TZ = "Africa/Johannesburg";
const SERVER_START = Date.UTC(2026, 2, 2, 6, 0, 0);

function at(day, hour = 12) {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - 2);
}

/**
 * The room: assigns arrival order and an arrival time, exactly as push_events does.
 *
 * `arrivedAt` is the SERVER's clock, and it is a parameter rather than derived from the events,
 * which matters more than it looks. The ordering rule is min(author's clock, arrival), so a fake
 * server that stamped arrival from a fixed start would make every arrival appear to precede its
 * own event and collapse the whole rule into plain arrival order — passing tests that prove
 * nothing. A real server receives things after they were written, except when the writer's clock
 * is wrong, which is the one case the rule exists for.
 */
function makeServer() {
  const rows = [];
  let lastArrival = SERVER_START;
  return {
    push(events, arrivedAt) {
      const arrival = Math.max(arrivedAt || SERVER_START, lastArrival + 1000);
      lastArrival = arrival;
      for (const e of events) {
        const seq = rows.length + 1;
        rows.push({
          uuid: e.eventId, seq, type: e.type, author: e.author, ts: e.ts,
          payload: e.payload,
          inserted_at: new Date(arrival).toISOString(),
        });
      }
    },
    pull(since) { return rows.filter((r) => r.seq > since); },
    get size() { return rows.length; },
  };
}

/** One phone: its own local log, and how far through the room it has read. */
function makeDevice(name, clockSkewMs = 0) {
  return { name, clockSkewMs, log: new Map(), cursor: 0, pending: [] };
}

let _n = 0;
function write(device, spec, day, hour = 12) {
  _n += 1;
  const e = {
    eventId: device.name + "-" + String(_n).padStart(3, "0"),
    type: spec.type,
    author: device.name,
    // A device writes with ITS OWN clock, which may be wrong.
    ts: at(day, hour) + device.clockSkewMs,
    payload: spec.payload,
  };
  device.log.set(e.eventId, e);
  device.pending.push(e);
  return e;
}

/**
 * Push what we wrote, then merge everything we have not seen — the real flush, in miniature.
 *
 * `realNow` is when this sync actually happens, which is not the same as when the events were
 * written: that gap is the entire point of the offline case.
 */
function sync(device, server, realNow) {
  const arrival = realNow != null
    ? realNow
    // Default: it reached the server just after the true time it was written. A device with a
    // skewed clock still stamps its events wrong, which is what the clamp then has to fix.
    : Math.max(...device.pending.map((e) => e.ts - device.clockSkewMs), SERVER_START) + 1000;
  server.push(device.pending, arrival);
  device.pending = [];
  const incoming = server.pull(device.cursor);
  const known = new Map();
  for (const r of incoming) if (device.log.has(r.uuid)) known.set(r.uuid, device.log.get(r.uuid));
  const plan = planMerge(incoming, known);
  for (const e of [...plan.toAdd, ...plan.toRestamp]) device.log.set(e.eventId, e);
  device.cursor = Math.max(device.cursor, plan.maxSeq);
}

const stateOf = (device) => replay([...device.log.values()]);

const habitSpec = ev.habit("steps", {
  name: "Steps", metric: METRIC.STEPS, direction: AT_LEAST, target: 10000,
  source: SOURCE.MANUAL, tz: TZ, dayStartHour: 4, scored: true,
});

// ===========================================================================

test("two devices writing in turn end up with the same log and the same numbers", () => {
  const server = makeServer();
  const a = makeDevice("alice");
  const b = makeDevice("bob");

  write(a, ev.member("alice", "Alice"), "2026-03-01");
  write(a, ev.member("bob", "Bob"), "2026-03-01");
  write(a, habitSpec, "2026-03-01");
  sync(a, server);
  sync(b, server);

  write(a, ev.log("steps", "alice", "2026-03-02", 12000, SOURCE.MANUAL), "2026-03-02", 20);
  write(b, ev.log("steps", "bob", "2026-03-02", 11000, SOURCE.MANUAL), "2026-03-02", 21);
  // Each pushes before seeing the other — the ordinary case, not a contrived one.
  sync(a, server);
  sync(b, server);
  sync(a, server);

  const sa = stateOf(a);
  const sb = stateOf(b);
  assert.equal(a.log.size, b.log.size);
  for (const member of ["alice", "bob"]) {
    assert.equal(
      valueOn(sa, sa.habits.get("steps"), member, "2026-03-02"),
      valueOn(sb, sb.habits.get("steps"), member, "2026-03-02"),
      member + " differs",
    );
  }
  assert.deepEqual(
    leaderboard(sa, ["alice", "bob"], "2026-03-02", "2026-03-02", "2026-03-03").map((r) => [r.name, r.pct]),
    leaderboard(sb, ["alice", "bob"], "2026-03-02", "2026-03-02", "2026-03-03").map((r) => [r.name, r.pct]),
  );
});

test("a device whose clock runs hours fast does not win every race", () => {
  // The failure this guards against: a fast clock stamps its writes into the future, so they sort
  // last and beat edits made afterwards by someone who had already seen them. Clamping to the
  // server's arrival time is what stops it — and it only works because our own copy gets restamped.
  //
  // The skew has to exceed the gap between the two writes or the test proves nothing: a clock ten
  // minutes fast cannot beat something written fifty minutes later either way.
  const server = makeServer();
  const fast = makeDevice("fast", 3 * 3600_000); // three hours fast
  const normal = makeDevice("normal");

  write(fast, ev.member("fast", "Fast"), "2026-03-01");
  write(fast, habitSpec, "2026-03-01");
  sync(fast, server);
  sync(normal, server);

  // Fast writes first in real time; normal writes afterwards, having seen it.
  write(fast, ev.log("steps", "fast", "2026-03-02", 5000, SOURCE.MANUAL), "2026-03-02", 18);
  sync(fast, server);
  sync(normal, server);
  write(normal, ev.log("steps", "fast", "2026-03-02", 9000, SOURCE.MANUAL), "2026-03-02", 19);
  sync(normal, server);
  sync(fast, server);

  const sf = stateOf(fast);
  const sn = stateOf(normal);
  assert.equal(valueOn(sn, sn.habits.get("steps"), "fast", "2026-03-02"), 9000, "the later write wins");
  assert.equal(
    valueOn(sf, sf.habits.get("steps"), "fast", "2026-03-02"),
    valueOn(sn, sn.habits.get("steps"), "fast", "2026-03-02"),
    "and the device with the bad clock agrees",
  );
});

test("without restamping, the author would disagree with everyone else", () => {
  // Proof that the restamp is load-bearing rather than decorative. Same events, same order, but
  // the authoring device keeps only its own timestamp.
  const server = makeServer();
  const fast = makeDevice("fast", 3 * 3600_000); // three hours fast

  const setup = [
    write(fast, ev.member("fast", "Fast"), "2026-03-01"),
    write(fast, habitSpec, "2026-03-01"),
  ];
  const early = write(fast, ev.log("steps", "fast", "2026-03-02", 5000, SOURCE.MANUAL), "2026-03-02", 18);
  sync(fast, server, at("2026-03-02", 18));

  const later = {
    eventId: "other-1", type: "habit_log", author: "normal",
    ts: at("2026-03-02", 19),
    payload: ev.log("steps", "fast", "2026-03-02", 9000, SOURCE.MANUAL).payload,
  };
  server.push([later], at("2026-03-02", 19));

  // What the author would hold WITHOUT the restamp: its own unstamped copies, plus the other
  // device's row exactly as the server hands it over.
  const pulledLater = server.pull(0).find((r) => r.uuid === "other-1");
  const unstamped = replay([
    ...setup.map((e) => ({ ...e, serverTs: undefined })),
    { ...early, serverTs: undefined },
    {
      eventId: pulledLater.uuid, type: pulledLater.type, author: pulledLater.author,
      ts: pulledLater.ts, seq: pulledLater.seq,
      serverTs: Date.parse(pulledLater.inserted_at),
      payload: pulledLater.payload,
    },
  ]);
  sync(fast, server, at("2026-03-02", 20)); // and what it holds WITH it

  const stamped = stateOf(fast);
  assert.equal(valueOn(unstamped, unstamped.habits.get("steps"), "fast", "2026-03-02"), 5000,
    "the fast clock's stale write wins on the author's own phone");
  assert.equal(valueOn(stamped, stamped.habits.get("steps"), "fast", "2026-03-02"), 9000,
    "restamped, it agrees with the rest of the group");
});

test("an edit made offline keeps its place rather than jumping the queue", () => {
  // Written Monday, pushed Friday. Ordering by arrival alone would let it clobber Wednesday's
  // work; ordering by the author's clock alone would let a fast clock do the same. min() of the
  // two is what gets both cases right.
  const server = makeServer();
  const online = makeDevice("online");
  const offline = makeDevice("offline");

  write(online, ev.member("online", "On"), "2026-03-01");
  write(online, habitSpec, "2026-03-01");
  sync(online, server);
  sync(offline, server);

  // Offline writes Monday but cannot send it.
  write(offline, ev.log("steps", "online", "2026-03-02", 3000, SOURCE.MANUAL), "2026-03-02", 9);
  // Online writes Wednesday and syncs immediately.
  write(online, ev.log("steps", "online", "2026-03-02", 11000, SOURCE.MANUAL), "2026-03-04", 9);
  sync(online, server, at("2026-03-04", 9));
  // Friday: the offline device finally connects, three days after it wrote.
  sync(offline, server, at("2026-03-06", 9));
  sync(online, server, at("2026-03-06", 10));

  const so = stateOf(online);
  const sf = stateOf(offline);
  assert.equal(valueOn(so, so.habits.get("steps"), "online", "2026-03-02"), 11000,
    "Wednesday's value survives Monday's late arrival");
  assert.equal(
    valueOn(sf, sf.habits.get("steps"), "online", "2026-03-02"),
    valueOn(so, so.habits.get("steps"), "online", "2026-03-02"),
  );
});

test("three devices, interleaved writes, all agree on streaks", () => {
  const server = makeServer();
  const devices = [makeDevice("d1"), makeDevice("d2", 4 * 60_000), makeDevice("d3", -90_000)];

  write(devices[0], ev.member("d1", "One"), "2026-03-01");
  write(devices[0], ev.member("d2", "Two"), "2026-03-01");
  write(devices[0], ev.member("d3", "Three"), "2026-03-01");
  write(devices[0], habitSpec, "2026-03-01");
  for (const d of devices) sync(d, server);

  for (let day = 2; day <= 8; day += 1) {
    const key = "2026-03-0" + day;
    devices.forEach((d, i) => {
      write(d, ev.log("steps", d.name, key, 10000 + i * 500, SOURCE.MANUAL), key, 18 + i);
    });
    // Sync in a different order each day, so nobody sees a consistent arrival pattern.
    const order = [devices[day % 3], devices[(day + 1) % 3], devices[(day + 2) % 3]];
    for (const d of order) sync(d, server);
  }
  for (const d of devices) sync(d, server);

  const states = devices.map(stateOf);
  const reference = states[0];
  for (const name of ["d1", "d2", "d3"]) {
    const expected = walk(reference, "steps", name, "2026-03-09").streak;
    assert.equal(expected, 7, name + " should have a clean week");
    for (const s of states) {
      assert.equal(walk(s, "steps", name, "2026-03-09").streak, expected, name + " disagrees");
    }
  }
  assert.equal(new Set(devices.map((d) => d.log.size)).size, 1, "all three hold the same log");
});

if (failures.length) {
  for (const { name, err } of failures) {
    console.error("\n✗ " + name);
    console.error("  " + (err && err.message ? err.message.split("\n").join("\n  ") : err));
  }
  console.error("\n" + failures.length + " failed, " + passed + " passed\n");
  process.exit(1);
}
console.log("✓ multi-device convergence: " + passed + " tests passed");
