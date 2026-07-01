// srv/lib/kg-stamp-meta-text.js
//
// Task 4 of #850 (KG-widget redesign): stamps `metaText` on each
// `otherResources` row of the neighborhood response using the per-type
// `renderMeta` from RESOURCE_TYPE_CONFIG.
//
// Extracted out of srv/knowledge-graph-service.js so the mutation step can
// be unit-tested independently of the HANA-only neighborhood handler.
// The client renderer becomes a pure per-row function without a
// `v-if r.type === '…'` chain — server owns the meta-text string.

import { RESOURCE_TYPE_CONFIG } from './kg-resource-type-config.js';

const CONFIG_BY_TYPE = new Map(RESOURCE_TYPE_CONFIG.map((c) => [c.type, c]));

/**
 * Mutates `rows` in place, stamping `metaText` on each row via
 * RESOURCE_TYPE_CONFIG's per-type `renderMeta`. Rows whose `type` isn't in
 * the registry get an empty `metaText` (defensive; the merge helper caps
 * inputs to known types by construction).
 *
 * @param {Array<Object>} rows — otherResources rows from mergeOtherResources.
 * @returns {Array<Object>} the same array reference (for expression-chaining).
 */
export function stampMetaText(rows) {
  for (const row of rows) {
    const cfg = CONFIG_BY_TYPE.get(row.type);
    row.metaText = cfg ? cfg.renderMeta(row) : '';
  }
  return rows;
}

/**
 * Returns the RESOURCE_TYPE_CONFIG entries with `renderMeta` stripped —
 * shape suitable for shipping on the neighborhood response's `typeConfig`
 * envelope field. Sorted by `priority` ascending.
 *
 * The source registry is currently already priority-sorted, but we sort
 * defensively so a future author reordering the RESOURCE_TYPE_CONFIG array
 * literal can't silently break the wire contract (the client relies on
 * ascending priority for rail rendering order).
 */
export function typeConfigForWire() {
  return RESOURCE_TYPE_CONFIG
    .map(({ renderMeta, ...rest }) => rest)
    .sort((a, b) => a.priority - b.priority);
}
