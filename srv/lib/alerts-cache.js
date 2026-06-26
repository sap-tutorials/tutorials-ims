// srv/lib/alerts-cache.js
//
// Bounded in-memory TTL cache for the /api/alerts and /api/alerts/me
// endpoints. Keyed by (endpoint, role-flag). Same shape as
// srv/lib/secret-resolver.js. Debounce-purged on AdminService.Alerts save.

const DEFAULT_TTL_MS = 60_000; // matches /api/alerts Cache-Control max-age=60
const MAX_ENTRIES = 10;

const store = new Map(); // key -> { value, expiresAt }

export function getCached(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function setCached(key, value, ttlMs = DEFAULT_TTL_MS) {
  // Trim oldest if over MAX_ENTRIES.
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function invalidate() {
  store.clear();
}

/** @internal — for vitest only. */
export function _resetForTests() {
  store.clear();
}
