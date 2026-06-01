import cds from '@sap/cds';

/**
 * Returns a slug-to-label map of every Tag whose `label` column is non-null.
 *
 * Used by:
 *   - /build/tag-labels — exposed to the build pipeline (fetch-tutorials)
 *   - /content/nav      — to resolve displayTags from Tags.label
 *
 * Keyed by `titlePath` (the canonical slug, e.g. "software-product>sap-s-4hana")
 * because that is the join key used in tutorial frontmatter (`primary_tag`, `tags`).
 *
 * Tags with a NULL label are silently omitted — callers fall back to a
 * heuristic (humanizeTag in scripts/parsers/frontmatter-utils.ts, or
 * humanizeFallback inline in srv/lib/content-store.js).
 */
export async function getTagLabelMap() {
  const { Tags } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(Tags)
    .columns('titlePath', 'label')
    .where({ label: { '!=': null } });
  const map = {};
  for (const r of rows) {
    if (r.titlePath && r.label) map[r.titlePath] = r.label;
  }
  return map;
}
