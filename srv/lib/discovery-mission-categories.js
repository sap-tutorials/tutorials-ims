// srv/lib/discovery-mission-categories.js
//
// Phase 4.3 (#447): Hand-curated short-code → English-label mapping for
// SAP Discovery Center mission categories. The MCP returns short codes only
// (e.g. 'onboard', 'intgn'); this table renders them as labels.
//
// Imported by:
//   - srv/lib/kg-other-resources-loader.js (categoryLabel for KG resource enrichment)
//
// Single source of truth. Add new entries as SAP adds categories; title-case
// fallback handles unknown slugs gracefully.

export const CATEGORY_LABELS = {
  onboard: 'Onboarding',
  intgn: 'Integration',
  develop: 'Development',
  extend: 'Extension',
  analyze: 'Analytics',
  automate: 'Automation',
  secure: 'Security',
  migrate: 'Migration',
};

/**
 * Resolve a mission category short code to its English label.
 *
 * @param {string|null|undefined} slug — short code from MCP
 * @returns {string} English label, or title-cased slug, or empty string
 */
export function categoryLabel(slug) {
  if (!slug) return '';
  return CATEGORY_LABELS[slug] ?? (slug.charAt(0).toUpperCase() + slug.slice(1));
}
