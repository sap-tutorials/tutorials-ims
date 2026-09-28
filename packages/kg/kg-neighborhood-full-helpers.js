// srv/lib/kg-neighborhood-full-helpers.js
//
// Task 5 of #850 (KG-widget redesign): pure helpers backing the
// /graph/neighborhoodFull handler.
//
// The handler orchestrates:
//   1. slug validation, feature-flag, graphVersion lookup, cache check,
//   2. SPARQL round-trip, rank, tutorial title enrichment,
//   3. per-corpus loader (kg-other-resources-loader.js) → `byType` Map,
//   4. THIS module's `buildOtherResourcesByType` shapes the Map into the
//      priority-ordered, per-type-capped, metaText-stamped envelope field
//      the wire schema declares.
//
// Extracting the shape step keeps it pure-function-testable without loading
// CDS or mocking cds.service.impl. The handler stays a thin orchestration
// layer.

import { RESOURCE_TYPE_CONFIG } from './kg-resource-type-config.js';

// Default per-type cap for neighborhoodFull. Overridable via the
// KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT env var — resolved in the handler
// (not here) so this module stays a pure library.
export const KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT_DEFAULT = 15;

/**
 * Compose the `otherResourcesByType` envelope field from a per-corpus row
 * Map (as returned by loadOtherResourcesByType).
 *
 * Guarantees:
 *   - Iteration follows RESOURCE_TYPE_CONFIG order (priority-ascending),
 *     so callers get a stable, deterministic array without a sort step.
 *   - Empty corpora are OMITTED — the array length equals the number of
 *     corpora that actually have rows, so the client can render only
 *     sections with data.
 *   - Each entry's `items` is capped at `perTypeLimit`; input rows are
 *     assumed pre-ranked (the loader tallies overlap desc + slices).
 *   - Every row is stamped with `metaText` in place via the per-type
 *     `renderMeta` from RESOURCE_TYPE_CONFIG. Unknown-type rows would
 *     get an empty string, but this path only iterates configured types
 *     so that branch is dead by construction.
 *
 * @param {Map<string, Array<Object>>} byType — per-corpus wire-shape rows,
 *   keyed by RESOURCE_TYPE_CONFIG.type. Missing keys treated as empty.
 * @param {number} perTypeLimit — max rows retained per bucket.
 * @returns {Array<{type: string, config: Object, items: Array<Object>}>}
 */
export function buildOtherResourcesByType(byType, perTypeLimit) {
  const out = [];
  for (const cfg of RESOURCE_TYPE_CONFIG) {
    const rows = byType?.get(cfg.type) ?? [];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const capped = rows.slice(0, perTypeLimit);
    for (const row of capped) {
      row.metaText = cfg.renderMeta(row);
    }
    // Strip renderMeta from the config we ship on the wire — same
    // rule as typeConfigForWire (client can't call functions).
    const { renderMeta: _rm, ...configForWire } = cfg;
    out.push({
      type: cfg.type,
      config: configForWire,
      items: capped,
    });
  }
  return out;
}
