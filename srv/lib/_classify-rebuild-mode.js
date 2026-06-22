// srv/lib/_classify-rebuild-mode.js
//
// Pure helpers for routing admin writes to the right rebuild mode.
// Imported by srv/server.js admin.after hooks; tested directly via vitest.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md
// Issue: #429

import cds from '@sap/cds';

// Entities whose CRUD changes /browse/ catalog data but NOT tutorial-page
// content. Catalog data lives in hugo/data/browse.json (built from
// /build/catalog) and is consumed by /browse/ + mission/group landing pages.
// Tutorial-page breadcrumbs read from cached frontmatter at Hugo build time,
// so a Hugo rebuild captures them without re-fetching markdown.
const CATALOG_ONLY_ENTITIES = new Set([
  'Missions',
  'Groups',
  'CompletionPaths',
  'CompletionPathItems',
  'GroupPathItems',
  'FeaturedTasks',
]);

// Entities whose CRUD targets a specific tutorial. Re-fetch one markdown,
// rebuild Hugo (cheap when only 1 page changed), publish-content --heal.
const SLUG_TARGETED_ENTITIES = new Set([
  'Tutorials',
  'Steps',  // resolves via Step.tutorial_ID → Tutorials.slug at hook time
]);

// Entities whose CRUD affects tutorial frontmatter (display tag labels)
// across many tutorials. Full rebuild with force-cap-refetch=true is the
// safe-but-fast path — the GitHub markdown cache hits so only frontmatter
// regenerates against fresh /build/tag-labels.
const FULL_FORCE_CAP_REFETCH_ENTITIES = new Set([
  'Tags',
]);

// Bound actions on AdminService that mutate catalog state without going
// through standard CRUD on the entities above. Each needs an explicit hook
// because admin.after('CREATE'|'UPDATE'|'DELETE', ...) doesn't catch them.
const CATALOG_ONLY_ACTIONS = new Set([
  'classifyCategories',  // mutates MissionCategories/GroupCategories junctions
  'setFeaturedOrder',    // changes /browse/ featured ordering
]);

const FULL_FORCE_CAP_REFETCH_ACTIONS = new Set([
  'commitTagImport',     // bulk-creates Tag rows (affects tutorial frontmatter)
  'cleanupUnusedTags',   // deletes orphan Tag rows (affects tutorial frontmatter)
]);

/**
 * Classify an entity-CRUD or bound-action trigger to a rebuild mode.
 *
 * Unrecognized names fall through to { mode: 'full', forceCapRefetch: false,
 * needsSlug: false } — safe-by-default. New catalog-affecting entities/actions
 * MUST be added to one of the sets above to get the cheaper rebuild.
 *
 * @param {string} entityOrActionName — bare entity name (e.g. 'Missions') or
 *                                       bound action name (e.g. 'classifyCategories')
 * @param {'crud'|'action'} kind — defaults to 'crud'
 * @returns {{
 *   mode: 'catalog-only'|'slug-targeted'|'full',
 *   forceCapRefetch: boolean,
 *   needsSlug: boolean,
 * }}
 */
export function classifyRebuildMode(entityOrActionName, kind = 'crud') {
  if (kind === 'crud') {
    if (CATALOG_ONLY_ENTITIES.has(entityOrActionName)) {
      return { mode: 'catalog-only', forceCapRefetch: false, needsSlug: false };
    }
    if (SLUG_TARGETED_ENTITIES.has(entityOrActionName)) {
      return { mode: 'slug-targeted', forceCapRefetch: false, needsSlug: true };
    }
    if (FULL_FORCE_CAP_REFETCH_ENTITIES.has(entityOrActionName)) {
      return { mode: 'full', forceCapRefetch: true, needsSlug: false };
    }
    return { mode: 'full', forceCapRefetch: false, needsSlug: false };
  }
  if (CATALOG_ONLY_ACTIONS.has(entityOrActionName)) {
    return { mode: 'catalog-only', forceCapRefetch: false, needsSlug: false };
  }
  if (FULL_FORCE_CAP_REFETCH_ACTIONS.has(entityOrActionName)) {
    return { mode: 'full', forceCapRefetch: true, needsSlug: false };
  }
  return { mode: 'full', forceCapRefetch: false, needsSlug: false };
}

/**
 * Best-effort slug resolution for an entity row.
 * - Tutorials: returns row.slug directly.
 * - Steps: walks Step.tutorial_ID → Tutorials.slug via CQL.
 * - Anything else / lookup failure / null row: returns null. Caller falls back
 *   to 'full' mode.
 *
 * The CQL SELECT for Steps runs against the active cds connection — works
 * in unit tests via cds.test() AND in production. Any thrown error
 * (transient DB hiccup, schema mismatch) is caught and yields null, which
 * the admin.after hook in srv/server.js translates to a 'full' fallback
 * (with WARN log) instead of crashing the admin save.
 *
 * @param {string} entityName
 * @param {object|null} row — the saved entity row from req.data
 * @returns {Promise<string|null>}
 */
export async function resolveSlugForEntity(entityName, row) {
  if (!row) return null;
  if (entityName === 'Tutorials') {
    return row.slug ?? null;
  }
  if (entityName === 'Steps') {
    if (!row.tutorial_ID) return null;
    try {
      const { Tutorials } = cds.entities('com.sap.developers.ims');
      const tut = await SELECT.one.from(Tutorials).columns('slug').where({ ID: row.tutorial_ID });
      return tut?.slug ?? null;
    } catch (err) {
      // Surface the failure: caller's `null` fallback to 'full' mode is correct
      // but silent. Logging here makes regressions visible in CF logs without
      // changing the return contract. Memory: feedback_silent_swallow_hides_dead_code.
      console.warn(`[_classify-rebuild-mode] resolveSlugForEntity(Steps, tutorial_ID=${row?.tutorial_ID}) threw — falling back to null: ${err.message ?? err}`);
      return null;
    }
  }
  return null;
}
