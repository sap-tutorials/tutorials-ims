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
 * Cap on the number of "Other resources" surfaced in tutorial-OP sidebars.
 * Applied AFTER the cross-type merge — i.e., top-5 TOTAL across all content
 * types, not top-5 per type. Spec §9: "top-5 total across types"
 * (no type-diversity quota).
 *
 * Also used as the per-type intermediate cap in
 * srv/knowledge-graph-service.js to bound the candidate set fed into
 * mergeOtherResources (current behavior: 5 journeys + 5 blogs → top-5).
 */
export const MAX_OTHER_RESOURCES = 5;

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
    .slice(0, MAX_OTHER_RESOURCES);
}
