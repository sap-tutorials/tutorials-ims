// KG community fingerprint (#985).
//
// Louvain community IDs are order-sensitive and shuffle across nightly
// re-runs — cluster {A,B,C} may be community 42 today and community 17
// tomorrow. Any downstream logic that needs to answer "is this the same
// community we already acted on?" must key off cluster *contents*, not
// the volatile Louvain ID.
//
// Fingerprint definition
// ----------------------
// SHA-256 (hex, 64 chars) over the sorted tutorial-typed member slug
// list joined with '\n'. Case-sensitive, no trimming — the input is
// expected to already carry canonical (lowercase) slugs, matching the
// tutorial-slug convention documented in CLAUDE.md.
//
// - tutorial-typed members only: a curator promotes tutorials, so the
//   identity of a community for promotion purposes is exactly its
//   tutorial set. Concepts / tags / products / etc. are excluded even
//   when Louvain groups them into the same community.
// - sorted: order in KgCommunity is unspecified.
// - joined with '\n': slug alphabet cannot contain newlines, so this
//   separator is unambiguous and doesn't require escaping.
// - hex output: fits Missions.sourceKgCommunityFingerprint String(64)
//   without any encoding fuss.
//
// Callers
// -------
// - srv/admin-service.js promoteCommunityToMission handler: computes
//   over the members loaded at promotion time and stores on Missions.
// - db/knowledge-graph-communities.cds KgCommunitySummaryV: computes
//   per-community via HANA HASH_SHA256 for the LEFT-JOIN against
//   Missions.sourceKgCommunityFingerprint (#986). SQL and JS MUST agree.
// - scripts/backfill-kg-community-fingerprint.js: recomputes fingerprint
//   for existing Missions carrying only the legacy Louvain ID.
//
// Empty input
// -----------
// An empty tutorial-slug list would produce a valid but semantically
// meaningless fingerprint. Callers should reject a promotion at that
// point rather than write a fingerprint over zero members — the handler
// already 404s on empty tutorials, so this helper's contract is "give
// me at least one slug".

import crypto from 'node:crypto';

/**
 * Compute a SHA-256 hex fingerprint over a set of tutorial slugs.
 *
 * @param {ReadonlyArray<string>} tutorialSlugs
 * @returns {string} 64-character lowercase hex digest
 * @throws {TypeError} if the input is not a non-empty array of strings
 */
export function computeKgCommunityFingerprint(tutorialSlugs) {
  if (!Array.isArray(tutorialSlugs) || tutorialSlugs.length === 0) {
    throw new TypeError(
      'computeKgCommunityFingerprint requires a non-empty array of tutorial slugs'
    );
  }
  const sorted = tutorialSlugs
    .map((s) => {
      if (typeof s !== 'string' || s.length === 0) {
        throw new TypeError(
          'computeKgCommunityFingerprint: every slug must be a non-empty string'
        );
      }
      return s;
    })
    .slice()
    .sort();
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex');
}

export default { computeKgCommunityFingerprint };
