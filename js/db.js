// db.js — thin promise wrapper over IndexedDB.
//
// The local database is the single source of truth. The cloud is only a replica: every screen
// renders from here, so nothing in the app depends on the network being up.
//
// Stores:
//   events — append-only log of every observation and setting change. keyPath: eventId
//   queue  — eventIds not yet mirrored to the cloud. keyPath: eventId
//   meta   — misc key/value (which group we're in, who I am, the pull cursor)
//
// Deliberately leaner than Passport's equivalent: there are no photos, no per-trip index, and no
// device-local documents, because a habit room is a SINGLE room. Copying stores we would never
// write is how a vendored file rots.
//
// A separate database NAME from Passport's is not cosmetic. Even served from another origin (as
// it is, inside the WebView), sharing a name would mean a DB_VERSION bump in one app running the
// other app's migrations against the other app's data.

const DB_NAME = "habit";
const DB_VERSION = 1;

let _dbp = null;

function open() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("events")) db.createObjectStore("events", { keyPath: "eventId" });
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "eventId" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbp;
}

function tx(store, mode = "readonly") {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

function asPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const db = {
  // ---- events (append-only) ----

  /** put() is idempotent on eventId, so replaying or re-importing the same event is safe. */
  async addEvent(event) {
    return asPromise((await tx("events", "readwrite")).put(event));
  },
  async getEvent(eventId) {
    return asPromise((await tx("events")).get(eventId));
  },
  async allEvents() {
    return asPromise((await tx("events")).getAll());
  },
  /**
   * How many events exist, WITHOUT loading them. count() reads keys only — no record
   * deserialization — which is what makes it usable as a cheap "has anything changed?" probe in
   * front of a full replay. The log is append-only, so an unchanged count means unchanged state.
   */
  async countEvents() {
    return asPromise((await tx("events")).count());
  },

  // ---- sync queue ----
  async enqueue(eventId) {
    return asPromise((await tx("queue", "readwrite")).put({ eventId, at: Date.now() }));
  },
  async dequeue(eventId) {
    return asPromise((await tx("queue", "readwrite")).delete(eventId));
  },
  async queued() {
    return asPromise((await tx("queue")).getAll());
  },

  // ---- meta ----
  async setMeta(key, value) {
    return asPromise((await tx("meta", "readwrite")).put({ key, value }));
  },
  async getMeta(key, fallback = null) {
    const row = await asPromise((await tx("meta")).get(key));
    return row ? row.value : fallback;
  },
};
