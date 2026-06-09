// srv/lib/branch/user-state.js
//
// Build the per-request userState shape consumed by pickBranch / evaluateSkip,
// and compute its sha256 fingerprint for cache keys.
// Spec: docs/superpowers/specs/2026-06-09-172-branching-paths-design.md §4.3, §5.6

import { createHash } from 'node:crypto';

const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];

const EMPTY_STATE = Object.freeze({
  completedSlugs: new Set(),
  completedMissionSlugs: new Set(),
  profile: Object.freeze({ deployment: null, role: null, cloud: null }),
});

/**
 * Build a frozen userState for the request.
 * - Anonymous user → null user → empty Sets and null-fields profile.
 * - Profile fields not in PROFILE_FIELDS are dropped.
 */
export async function buildUserState(user, deps) {
  if (!user) return EMPTY_STATE;

  const [slugs, missions, profileRaw] = await Promise.all([
    deps.loadCompletedSlugs(user),
    deps.loadCompletedMissionSlugs(user),
    deps.loadProfile(user),
  ]);

  const profile = Object.create(null);
  for (const f of PROFILE_FIELDS) profile[f] = profileRaw?.[f] ?? null;

  return Object.freeze({
    completedSlugs: new Set(slugs),
    completedMissionSlugs: new Set(missions),
    profile: Object.freeze(profile),
  });
}

/**
 * Deterministic sha256 fingerprint of a userState.
 * Same content → same fingerprint, regardless of Set iteration order.
 */
export function fingerprintUserState(state) {
  const h = createHash('sha256');
  h.update(JSON.stringify({
    s: [...state.completedSlugs].sort(),
    m: [...state.completedMissionSlugs].sort(),
    p: PROFILE_FIELDS.reduce((o, f) => { o[f] = state.profile?.[f] ?? null; return o; }, {}),
  }));
  return h.digest('hex');
}
