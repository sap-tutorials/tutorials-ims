// srv/lib/khoros-cache.js
//
// Bounded LRU keyed by Khoros user id. Module-scoped singleton.
// Per-process (not Redis-shared); two CF instances may each warm
// independently. Acceptable for v1 (display-only unlock).
//
// Spec: docs/superpowers/specs/2026-06-26-566-khoros-community-link-design.md
// Issue: #566

const cache = new Map();
const MAX_ENTRIES = 500;
const TTL_MS = 6 * 60 * 60 * 1000;

export function get(khorosId) {
  const entry = cache.get(khorosId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(khorosId);
    return null;
  }
  cache.delete(khorosId);
  cache.set(khorosId, entry);
  return entry.profile;
}

export function set(khorosId, profile) {
  cache.delete(khorosId);
  cache.set(khorosId, { profile, fetchedAt: Date.now() });
  if (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

export function evict(khorosId) {
  cache.delete(khorosId);
}

// Test-only.
export function _resetForTests() {
  cache.clear();
}
