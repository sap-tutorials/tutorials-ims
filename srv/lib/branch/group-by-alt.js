// srv/lib/branch/group-by-alt.js
//
// Shared utility for grouping CompletionPathItems / GroupPathItems by their
// (itemOrder, altGroupKey) tuple. Items with null altGroupKey are skipped
// (those are linear-backbone items, not alt-group members).
//
// Used by:
//   - srv/lib/branch/mission-detail.js  (HTTP /build/mission/:slug)
//   - srv/lib/branch/joule-tool.js      (chat tool mission scope)
//
// (Issue #172 PR 4 — extracted during code-quality review.)

/**
 * Group items by (itemOrder, altGroupKey). Returns an array of groups in
 * insertion order. Each group has shape:
 *   { itemOrder: number, groupKey: string, items: <input items> }
 *
 * Items where altGroupKey is null are skipped.
 *
 * @param {Array<{itemOrder: number, altGroupKey: string|null, ...}>} items
 * @returns {Array<{itemOrder, groupKey, items}>}
 */
export function groupByAlt(items) {
  const groups = new Map();
  for (const it of items) {
    if (!it.altGroupKey) continue;
    const key = `${it.itemOrder}:${it.altGroupKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        itemOrder: it.itemOrder,
        groupKey: it.altGroupKey,
        items: [],
      });
    }
    groups.get(key).items.push(it);
  }
  return Array.from(groups.values());
}
