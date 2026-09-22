// srv/lib/sidecar-hash.js
// Canonical, deterministic per-slug content hashing for the contributors and
// validation-rules sidecars (#2464 — delta-skip unchanged sidecars).
//
// Shared by BOTH sides of the publish delta so they agree byte-for-byte:
//   - the CLIENT hashes the sidecar JSON files it is about to POST
//     (scripts/publish/publish-{contributors,validation-rules}.ts)
//   - the SERVER hashes the stored DB rows to expose a {slug: hash} feed
//     (srv/lib/{contributors,validation-rules}-publish.js)
//
// The hash MUST be computed over the same normalized shape on both sides or
// every slug looks "changed" and the skip never fires. To guarantee that, both
// sides normalize to the SAME array-of-field-arrays and hash that. Only the
// columns the publish path actually writes are included; random IDs
// (contributors ID/legacyId) and association keys are excluded.

import { createHash } from 'node:crypto'

/** Stable JSON of a value (null/undefined → null), for hashing. */
function norm(v) {
  return v === undefined ? null : v
}

/**
 * Canonical hash of one slug's CONTRIBUTORS set.
 * @param {Array<{login,name,email,avatarUrl}>} contributors
 * @returns {string} sha256 hex
 *
 * Mirrors the publish write path (contributors-publish.js): filters rows with
 * no login/name/email, caps at 10, and keys off login|name|email|avatarUrl.
 * profileUrl is derived from login so it is NOT part of the hash input.
 */
export function hashContributors(contributors) {
  const rows = (contributors || [])
    .filter((c) => c && (c.login || c.name || c.email))
    .slice(0, 10)
    .map((c) => [
      norm(c.login || ''),
      norm(c.name || ''),
      norm(c.email || ''),
      norm(c.avatarUrl || ''),
    ])
  // Deterministic order independent of source ordering.
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(rows), 'utf-8').digest('hex')
}

/**
 * Canonical hash of one slug's VALIDATION-RULES set.
 * @param {Array} rules
 * @returns {string} sha256 hex
 *
 * Mirrors the publish write path (validation-rules-publish.js). Rules are keyed
 * by (stepNumber, questionId); sort by that composite key so ordering in the
 * sidecar JSON does not change the hash. aiGrading is coerced to a boolean
 * exactly as the server stores it.
 */
export function hashValidationRules(rules) {
  const rows = (rules || []).map((r) => [
    norm(r.stepNumber),
    norm(String(r.questionId ?? '')),
    norm(r.questionText ?? ''),
    norm(r.ruleType ?? ''),
    norm(r.questionType ?? ''),
    norm(r.choiceMode ?? null),
    norm(r.options ?? null),
    norm(r.correctAnswer ?? null),
    Boolean(r.aiGrading),
  ])
  rows.sort((a, b) => {
    const s = (a[0] ?? 0) - (b[0] ?? 0)
    if (s !== 0) return s
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
  })
  return createHash('sha256').update(JSON.stringify(rows), 'utf-8').digest('hex')
}
