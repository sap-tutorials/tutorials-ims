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
//   Phase 0 — frontmatter author_profile → Users.githubLogin (BEATS all below).
//     If frontmatterGithubLogin normalizes to a non-empty string AND is found
//     in loginToUserId, that user wins immediately. source = 'frontmatter'.
//   Phase A — per-contributor email lookup. For every contributor whose
//     normalized email is in the map, emit a contributorUserIds entry.
//     Run unconditionally, regardless of role.
//   Phase B — primary author resolution, in priority order:
//     (a) first contributor with role in {author, owner} whose email matches
//         source = 'role-match'
//     (b) first contributor (any role) whose email matches
//         source = 'any-contributor'
//     All-miss → authorUserId null + orphans list. source = null.
//
// Phase (c) `ownerEmail` fallback was removed in the #862 reopen because
// TutorialMeta.ownerEmail encodes a *monitoring* signal (who watches for
// staleness), not authorship. See the block comment at the removed call
// site for the full rationale.
//
// Email comparison: LOWER(TRIM(email)). The caller MUST pre-normalize the
// Map's keys to LOWER(TRIM(email)) — this function does NOT re-normalize
// the map, only the inputs it looks up.
// Login comparison: LOWER(TRIM(login)). loginToUserId map keys MUST be lower.

const AUTHOR_ROLES = new Set(['author', 'owner']);

function normalize(email) {
  if (email === null || email === undefined) return null;
  const s = String(email).trim().toLowerCase();
  return s.length === 0 ? null : s;
}

function normalizeLogin(login) {
  if (typeof login !== 'string') return null;
  const s = login.trim().toLowerCase();
  return s.length === 0 ? null : s;
}

/**
 * @param {object} input
 * @param {Array<{email: string|null, role: string|null}>} input.contributors
 * @param {string|null} input.ownerEmail
 * @param {Map<string, string>} input.emailToUserId  LOWER(TRIM(email)) → Users.ID
 * @param {string|null} [input.frontmatterGithubLogin]  raw login from tutorial frontmatter
 *   (author_profile field). When this resolves via loginToUserId, it wins over all
 *   email-based phases. Defaults to null (safe for existing callers).
 * @param {Map<string, string>} [input.loginToUserId]  LOWER(TRIM(login)) → Users.ID.
 *   Defaults to empty Map (safe for existing callers).
 * @returns {{
 *   authorUserId: string|null,
 *   source: 'frontmatter'|'role-match'|'any-contributor'|null,
 *   contributorUserIds: Array<{ contributorIndex: number, userId: string }>,
 *   orphans: Array<{
 *     kind: 'contributor'|'tutorial'|'frontmatter-login',
 *     email: string|null,
 *     login?: string,
 *     reason: string
 *   }>
 * }}
 */
export function resolveTutorialAuthor({
  contributors,
  ownerEmail,
  emailToUserId,
  frontmatterGithubLogin = null,
  loginToUserId,
} = {}) {
  const contribs = Array.isArray(contributors) ? contributors : [];
  const map = emailToUserId instanceof Map ? emailToUserId : new Map();
  const loginMap = loginToUserId instanceof Map ? loginToUserId : new Map();

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
  let source = null;

  // Phase 0 — frontmatter author_profile → Users.githubLogin.
  // BEATS every email-based phase below. This makes the tutorial's source
  // markdown the durable signal for ownership: even if Riley made the last
  // commit and contributors[0] is Riley, the frontmatter's author_profile
  // determines who owns the tutorial in HANA.
  const fmLogin = normalizeLogin(frontmatterGithubLogin);
  if (fmLogin) {
    const userId = loginMap.get(fmLogin);
    if (userId) {
      authorUserId = userId;
      source = 'frontmatter';
    } else {
      // Frontmatter declared an author but no Users row matched the login.
      // Record for debuggability — this is exactly the case where we'd
      // otherwise silently fall through to "Riley was last committer".
      orphans.push({
        kind: 'frontmatter-login',
        email: null,
        login: fmLogin,
        reason: 'frontmatterGithubLogin not found in loginToUserId map',
      });
    }
  }

  // (a) first contributor with role in {author, owner} whose email matches
  if (!authorUserId) {
    for (let i = 0; i < contribs.length; i++) {
      const c = contribs[i] || {};
      const role = c.role ? String(c.role).trim().toLowerCase() : '';
      if (!AUTHOR_ROLES.has(role)) continue;
      const norm = normalize(c.email);
      if (!norm) continue;
      const userId = map.get(norm);
      if (userId) {
        authorUserId = userId;
        source = 'role-match';
        break;
      }
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
        source = 'any-contributor';
        break;
      }
    }
  }

  // (c) ownerEmail fallback — REMOVED in #862 (reopen). TutorialMeta.ownerEmail
  // is a *monitoring* signal (who watches this tutorial for staleness), not
  // an authorship signal. Promoting it to author_ID via Phase (c) meant a
  // single stale monitoring assignment (e.g. from the legacy IMS migration)
  // would silently promote that user to "author" on every tutorial they
  // watched. In DEV that hit 36 tutorials for Riley, none of which he wrote.
  //
  // If no frontmatter author is declared (Phase 0) and no contributor's
  // email matches a Users row (Phase a/b), author_ID stays NULL. The
  // MyAuthoredTutorials endpoint returns fewer false positives; the broader
  // MyTutorials endpoint still shows the tutorial because MyTutorialsView
  // source #3 (TutorialMeta.ownerEmail = Users.email) still contributes.
  // Watchers still show up in the broad list; they just no longer get
  // promoted to strict authors.
  // The `owner-email` value is no longer a valid `source` return value.

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

  return { authorUserId, source, contributorUserIds, orphans };
}
