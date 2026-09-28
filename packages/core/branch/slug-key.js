// srv/lib/branch/slug-key.js
//
// Single source of truth for branch-key derivation. Imported by:
//   - srv/lib/build-catalog.js          (catalog SSR's `data-altgroup-branch-key`)
//   - srv/lib/branch/mission-detail.js  (recommendation payload's branch key)
//
// Both call sites must emit byte-identical output for the same label, otherwise
// the `?branch=<groupKey>:<key>` URL param silently breaks between catalog markup
// and mission-detail recommendations.
//
// Spec: docs/superpowers/specs/2026-06-10-172-branching-pr3-tutorial-branches-design.md
// Refs: issue #293 (consolidation), issue #172 (branching paths)

/**
 * Slugify a label into a branch key. Stable + URL-safe.
 *
 * Rules: lowercase, non-alnum collapses to `-`, trim leading/trailing `-`,
 * cap at 40 chars. Collisions after truncation are accepted by design — branch
 * keys live alongside a `groupKey` in URLs, so the addressable space is scoped.
 *
 * @param {string} label
 * @returns {string}
 */
export function slugifyKey(label) {
  return String(label).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
