// srv/lib/resolve-tutorial-author.js
//
// Spec: docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md
//
// Pure resolver. No I/O, no DB. Consumed by both the offline backfill
// script (scripts/backfill-tutorial-authors.cjs) and the live publish
// path (srv/lib/content-publish-session.js) so the two paths can never
// diverge.
//
// Resolution algorithm:
//   Phase A — per-contributor email lookup. For every contributor whose
//     normalized email is in the map, emit a contributorUserIds entry.
//     Run unconditionally, regardless of role.
//   Phase B — primary author resolution, in priority order:
//     (a) first contributor with role in {author, owner} whose email matches
//     (b) first contributor (any role) whose email matches
//     (c) ownerEmail if it matches the map
//     First hit wins. All-miss → authorUserId null + orphans list.
//
// Email comparison: LOWER(TRIM(email)). The caller MUST pre-normalize the
// Map's keys to LOWER(TRIM(email)) — this function does NOT re-normalize
// the map, only the inputs it looks up.

const AUTHOR_ROLES = new Set(['author', 'owner']);

function normalize(email) {
  if (email === null || email === undefined) return null;
  const s = String(email).trim().toLowerCase();
  return s.length === 0 ? null : s;
}

/**
 * @param {object} input
 * @param {Array<{email: string|null, role: string|null}>} input.contributors
 * @param {string|null} input.ownerEmail
 * @param {Map<string, string>} input.emailToUserId  LOWER(TRIM(email)) → Users.ID
 * @returns {{
 *   authorUserId: string|null,
 *   contributorUserIds: Array<{ contributorIndex: number, userId: string }>,
 *   orphans: Array<{ kind: 'contributor'|'tutorial', email: string|null, reason: string }>
 * }}
 */
export function resolveTutorialAuthor({ contributors, ownerEmail, emailToUserId } = {}) {
  const contribs = Array.isArray(contributors) ? contributors : [];
  const map = emailToUserId instanceof Map ? emailToUserId : new Map();

  const contributorUserIds = [];
  const orphans = [];

  // Phase A — per-contributor email lookup.
  for (let i = 0; i < contribs.length; i++) {
    const c = contribs[i] || {};
    const norm = normalize(c.email);
    if (!norm) {
      // Null/empty email contributor — not a candidate, not an orphan
      // (there's nothing to look up).
      continue;
    }
    const userId = map.get(norm);
    if (userId) {
      contributorUserIds.push({ contributorIndex: i, userId });
    } else {
      orphans.push({
        kind: 'contributor',
        email: c.email,
        reason: 'email not found in Users map',
      });
    }
  }

  // Phase B — primary author resolution (3-level fallback).
  let authorUserId = null;

  // (a) first contributor with role in {author, owner} whose email matches
  for (let i = 0; i < contribs.length; i++) {
    const c = contribs[i] || {};
    const role = c.role ? String(c.role).trim().toLowerCase() : '';
    if (!AUTHOR_ROLES.has(role)) continue;
    const norm = normalize(c.email);
    if (!norm) continue;
    const userId = map.get(norm);
    if (userId) {
      authorUserId = userId;
      break;
    }
  }

  // (b) first contributor (any role) whose email matches
  if (!authorUserId) {
    for (let i = 0; i < contribs.length; i++) {
      const c = contribs[i] || {};
      const norm = normalize(c.email);
      if (!norm) continue;
      const userId = map.get(norm);
      if (userId) {
        authorUserId = userId;
        break;
      }
    }
  }

  // (c) ownerEmail fallback
  if (!authorUserId) {
    const norm = normalize(ownerEmail);
    if (norm) {
      const userId = map.get(norm);
      if (userId) {
        authorUserId = userId;
      }
    }
  }

  // All-miss → report a tutorial-level orphan with the candidate emails tried.
  if (!authorUserId) {
    const tried = [];
    for (const c of contribs) {
      if (c && c.email) tried.push(c.email);
    }
    if (ownerEmail) tried.push(ownerEmail);
    if (tried.length > 0) {
      orphans.push({
        kind: 'tutorial',
        email: tried[0],
        reason: `no candidate email matched Users map (tried ${tried.length})`,
      });
    } else {
      orphans.push({
        kind: 'tutorial',
        email: null,
        reason: 'no candidate emails available',
      });
    }
  }

  return { authorUserId, contributorUserIds, orphans };
}
