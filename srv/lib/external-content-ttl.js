// srv/lib/external-content-ttl.js
//
// Phase 4 chassis: per-type TTL table + shared isWithinTTL filter.
// Sub-phases add their content-type key as they ship.
//
// Spec: docs/superpowers/specs/2026-06-28-447-knowledge-graph-phase4-architecture.md §5

export const PER_TYPE_TTL_DAYS = Object.freeze({
  'learning-journey': 365,
  'blog-post': 540,         // 4.2 will use
  'discovery-mission': 180, // 4.3
  'trial': null,            // 4.3 — date-aware via endDate
  'video': 730,             // 4.4
  'api-doc': 3650,          // 4.5
  'sample': 365,            // 4.6
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Returns true if a content row's lastSeenAt + optional endDate make it
 * eligible for graph projection right now.
 *
 * @param {string} contentType — key in PER_TYPE_TTL_DAYS
 * @param {Date|string|null} lastSeenAt
 * @param {Date|string|null} endDate — only used for content types with
 *        null TTL (trials). 30-day grace period after endDate before
 *        the row stops projecting.
 * @returns {boolean}
 */
export function isWithinTTL(contentType, lastSeenAt, endDate = null) {
  if (!(contentType in PER_TYPE_TTL_DAYS)) return false;

  const seenAt = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seenAt)) return false;

  const ttlDays = PER_TYPE_TTL_DAYS[contentType];

  // Standard TTL check (skipped for date-aware types).
  if (ttlDays != null) {
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    if (Date.now() - seenAt > ttlMs) return false;
  }

  // Date-aware tier: trials. endDate + 30-day grace.
  if (endDate != null) {
    const ends = new Date(endDate).getTime();
    if (Number.isFinite(ends) && Date.now() - ends > THIRTY_DAYS_MS) return false;
  }

  return true;
}
