// Skip-key hash for community labeling (#1126). Distinct from
// kg-community-fingerprint.js (tutorial-typed slugs only): this hashes the
// FULL member-slug set (tutorials + concepts + tags + …) so the labeling job
// re-labels when non-tutorial members change too.

import crypto from 'node:crypto';

/**
 * @param {ReadonlyArray<string>} slugs - any-typed member slugs (may contain nulls/dups).
 * @returns {string} 64-char lowercase hex, or '' when no usable slug is present.
 */
export function computeMemberSlugsHash(slugs) {
  if (!Array.isArray(slugs)) return '';
  const clean = [...new Set(slugs.filter((s) => typeof s === 'string' && s.length > 0))].sort();
  if (clean.length === 0) return '';
  return crypto.createHash('sha256').update(clean.join('\n')).digest('hex');
}

export default { computeMemberSlugsHash };
