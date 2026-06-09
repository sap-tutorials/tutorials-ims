// srv/lib/build-catalog-categories.js
//
// Pure helpers for the Categories facet payload extension to /build/catalog
// (#201). Extracted from build-catalog.js so the sort/filter/aggregate logic
// is unit-testable without booting CDS.

/**
 * Returns up to 3 category slugs for an item, sorted DESC by score then
 * ASC by sortOrder for tie-break.
 * @param {string} itemId
 * @param {Array<{[fk]: string, category_ID: string, score: number}>} assignments
 * @param {string} fk - 'mission_ID' | 'group_ID' | 'tutorial_ID'
 * @param {Map<string, {ID: string, slug: string, sortOrder: number}>} catByID
 * @returns {string[]}
 */
export function categorySlugsFor(itemId, assignments, fk, catByID) {
  return assignments
    .filter(a => a[fk] === itemId)
    .map(a => ({ a, meta: catByID.get(a.category_ID) }))
    .filter(x => x.meta)
    .sort((x, y) => (y.a.score - x.a.score) || (x.meta.sortOrder - y.meta.sortOrder))
    .slice(0, 3)
    .map(x => x.meta.slug);
}

/**
 * Returns total count of items linked to a category (across mission/group/tutorial).
 * @param {string} catId
 * @param {Array<{category_ID: string}>} missionAssign
 * @param {Array<{category_ID: string}>} groupAssign
 * @param {Array<{category_ID: string}>} tutorialAssign
 * @returns {number}
 */
export function countActiveFor(catId, missionAssign, groupAssign, tutorialAssign) {
  let n = 0;
  for (const a of missionAssign)  if (a.category_ID === catId) n++;
  for (const a of groupAssign)    if (a.category_ID === catId) n++;
  for (const a of tutorialAssign) if (a.category_ID === catId) n++;
  return n;
}

/**
 * Builds the top-level categories[] array, sorted by sortOrder ASC.
 * @param {Array<{ID: string, slug: string, label: string, sortOrder: number}>} categories
 * @param {Array<{category_ID: string}>} missionAssign
 * @param {Array<{category_ID: string}>} groupAssign
 * @param {Array<{category_ID: string}>} tutorialAssign
 * @returns {Array<{slug: string, label: string, sortOrder: number, activeCount: number}>}
 */
export function buildCategoriesPayload(categories, missionAssign, groupAssign, tutorialAssign) {
  return categories
    .map(c => ({
      slug: c.slug,
      label: c.label,
      sortOrder: c.sortOrder ?? 100,
      activeCount: countActiveFor(c.ID, missionAssign, groupAssign, tutorialAssign),
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
