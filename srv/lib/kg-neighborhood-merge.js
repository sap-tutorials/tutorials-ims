// srv/lib/kg-neighborhood-merge.js
//
// Phase 4.2 (#447 §9): pure helper for the cross-type ranking step in
// neighborhood().otherResources. Extracted here so the merge-and-cap
// logic is unit-testable independent of the HANA-only KG_QUERY procedure
// the full neighborhood handler depends on.
//
// Contract: takes pre-computed journey + blog row arrays (each carrying
// `overlapCount`); UNIONs them; sorts by overlapCount desc; caps top-5
// TOTAL across both types (no per-type diversity quota — spec §9).

/**
 * Merge journey + blog rows; sort by overlapCount desc; cap top-5.
 *
 * @param {Array<object>} journeyRows
 * @param {Array<object>} blogRows
 * @returns {Array<object>} merged + sorted + capped
 */
export function mergeOtherResources(journeyRows = [], blogRows = []) {
  return [...journeyRows, ...blogRows]
    .sort((a, b) => (b.overlapCount ?? 0) - (a.overlapCount ?? 0))
    .slice(0, 5);
}
