// srv/lib/_classify-rebuild-mode.js
//
// Pure helpers for routing admin writes to the right rebuild mode.
// Imported by srv/server.js admin.after hooks; tested directly via vitest.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-429-targeted-rebuild-design.md
// Issue: #429 (the 3-mode classifier), #541 (Tag reverse-lookup)

import cds from '@sap/cds';

// Entities whose CRUD changes /browse/ catalog data but NOT tutorial-page
// content. Catalog data lives in hugo/data/browse.json (built from
// /build/catalog) and is consumed by /browse/ + mission/group landing pages.
// Tutorial-page breadcrumbs read from cached frontmatter at Hugo build time,
// so a Hugo rebuild captures them without re-fetching markdown.
//
// #601: Advocates/AdvocateTopics/AdvocateLinks are treated as catalog-only
// because the per-advocate profile page generator (scripts/fetch-advocates.ts)
// runs at the same Hugo build step as catalog data and regenerates all
// per-advocate .md files. The output is catalog-scale (one .md per advocate,
// roughly the same order of magnitude as Missions/Groups), not tutorial-scale,
// so the slug-targeted path is the wrong shape. catalog-only mode rebuilds
// the full set in ~1 min wall-clock.
//
// #685: KnowledgeGraphService.Concepts is included because admin Publish/
// Unpublish (and inline name/description edits) change the /build/concepts
// payload + which /concepts/<slug>/ Hugo pages get generated, but don't
// touch tutorial markdown. catalog-only rebuilds the full set in ~1 min.
// NOTE: Concepts lives on KnowledgeGraphService (not AdminService), so the
// classifier match here is keyed on the bare entity name only — srv/server.js
// wires a kg.after hook separately to feed the entity name into this fn.
const CATALOG_ONLY_ENTITIES = new Set([
  'Missions',
  'Groups',
  'CompletionPaths',
  'CompletionPathItems',
  'GroupPathItems',
  'FeaturedTasks',
  'Advocates',
  'AdvocateTopics',
  'AdvocateLinks',
  // #639: HomepageShelves admin saves rebuild hugo/data/homepage_shelves.json
  // via /build/homepage-shelves — same pattern as Missions/Groups/Advocates.
  // (Was missing from the set; admin saves to HomepageShelves were
  // triggering 'full' rebuilds via the default fallthrough — wasteful
  // but not incorrect. Discovered while implementing #759 Task 15.)
  'HomepageShelves',
  'Concepts',
  // #759: homepage explainer entities. Admin writes affect the baked
  // hugo/data/*.json feeds served from /build/verb-definitions and
  // /build/shelf-definitions, not slug-keyed tutorial HTML. catalog-only
  // mode rebuilds the full set of /build/* feeds in ~1 min wall-clock.
  'VerbDefinitions',
  'ShelfDefinitions',
]);

// Entities whose CRUD targets a specific tutorial. Re-fetch one markdown,
// rebuild Hugo (cheap when only 1 page changed), publish-content --heal.
const SLUG_TARGETED_ENTITIES = new Set([
  'Tutorials',
  'Steps',  // resolves via Step.tutorial_ID → Tutorials.slug at hook time
]);

// Entities whose CRUD affects tutorial frontmatter (display tag labels)
// across N tutorials linked via TutorialTags. The classifier signals
// `needsSlugsByTag` so the hook can reverse-lookup the affected slugs and
// dispatch slug-targeted instead of full+force-cap-refetch. If the
// reverse-lookup returns 0 or > TAG_REVERSE_LOOKUP_CAP slugs, the hook
// falls back to full+force-cap-refetch (today's pre-#541 behavior).
const TAG_REVERSE_LOOKUP_ENTITIES = new Set([
  'Tags',
]);

// #548: Entities served at runtime via dedicated endpoints (e.g. Alerts via
// /api/alerts*). Admin CRUD on these MUST NOT trigger a Hugo rebuild
// — the runtime endpoint serves fresh data within the cache TTL.
// Returned mode='none' is a signal to the dispatch hook to short-circuit.
const NO_REBUILD_ENTITIES = new Set([
  'Alerts',
]);

// Bound actions on AdminService that mutate catalog state without going
// through standard CRUD on the entities above. Each needs an explicit hook
// because admin.after('CREATE'|'UPDATE'|'DELETE', ...) doesn't catch them.
const CATALOG_ONLY_ACTIONS = new Set([
  'classifyCategories',  // mutates MissionCategories/GroupCategories junctions
  'setFeaturedOrder',    // changes /browse/ featured ordering
  // #685: KG Concept publish/unpublish — sets/clears publishedAt + publishedBy
  // on a Concept, which gates the /concepts/<slug>/ Hugo page generation
  // and the /build/concepts payload.
  'publishConcept',
  'unpublishConcept',
]);

const FULL_FORCE_CAP_REFETCH_ACTIONS = new Set([
  'commitTagImport',     // bulk-creates Tag rows (affects tutorial frontmatter)
  'cleanupUnusedTags',   // deletes orphan Tag rows (affects tutorial frontmatter)
]);

// #541: cap on per-tag reverse-lookup slug count. Beyond this the hook
// dispatches full+force-cap-refetch (today's behavior pre-#541) instead of
// N slug-targeted dispatches. Matches the existing SLUG_ACCUMULATOR_CAP in
// scheduleRebuild for symmetry.
export const TAG_REVERSE_LOOKUP_CAP = 50;

/**
 * Classify an entity-CRUD or bound-action trigger to a rebuild mode.
 *
 * Unrecognized names fall through to { mode: 'full', forceCapRefetch: false,
 * needsSlug: false, needsSlugsByTag: false } — safe-by-default. New
 * catalog-affecting entities/actions MUST be added to one of the sets above
 * to get the cheaper rebuild.
 *
 * The Tags branch (#541) returns the slug-targeted shape with
 * `forceCapRefetch: true` AND `needsSlugsByTag: true`. Read the flags:
 *   - `needsSlugsByTag`: caller MUST run resolveSlugsForTagRename(tagId)
 *      before dispatching. If the result is 1..TAG_REVERSE_LOOKUP_CAP slugs,
 *      use mode='slug-targeted' with those slugs. Otherwise (0 or >cap) fall
 *      back to mode='full' + forceCapRefetch=true.
 *
 * @param {string} entityOrActionName — bare entity name (e.g. 'Missions') or
 *                                       bound action name (e.g. 'classifyCategories')
 * @param {'crud'|'action'} kind — defaults to 'crud'
 * @returns {{
 *   mode: 'catalog-only'|'slug-targeted'|'full'|'none',
 *   forceCapRefetch: boolean,
 *   needsSlug: boolean,
 *   needsSlugsByTag: boolean,
 * }}
 */
export function classifyRebuildMode(entityOrActionName, kind = 'crud') {
  if (kind === 'crud') {
    if (NO_REBUILD_ENTITIES.has(entityOrActionName)) {
      // #548: runtime-served entity (e.g. Alerts). Caller MUST short-circuit
      // before dispatching any rebuild — see srv/server.js admin.after hook.
      return { mode: 'none', forceCapRefetch: false, needsSlug: false, needsSlugsByTag: false };
    }
    if (CATALOG_ONLY_ENTITIES.has(entityOrActionName)) {
      return { mode: 'catalog-only', forceCapRefetch: false, needsSlug: false, needsSlugsByTag: false };
    }
    if (SLUG_TARGETED_ENTITIES.has(entityOrActionName)) {
      return { mode: 'slug-targeted', forceCapRefetch: false, needsSlug: true, needsSlugsByTag: false };
    }
    if (TAG_REVERSE_LOOKUP_ENTITIES.has(entityOrActionName)) {
      // #541: recommend slug-targeted (forceCapRefetch=true preserved as the
      // fallback signal — the hook reads it when the reverse-lookup yields
      // 0 or >cap slugs and downgrades the dispatch to full+force).
      return { mode: 'slug-targeted', forceCapRefetch: true, needsSlug: false, needsSlugsByTag: true };
    }
    return { mode: 'full', forceCapRefetch: false, needsSlug: false, needsSlugsByTag: false };
  }
  if (CATALOG_ONLY_ACTIONS.has(entityOrActionName)) {
    return { mode: 'catalog-only', forceCapRefetch: false, needsSlug: false, needsSlugsByTag: false };
  }
  if (FULL_FORCE_CAP_REFETCH_ACTIONS.has(entityOrActionName)) {
    return { mode: 'full', forceCapRefetch: true, needsSlug: false, needsSlugsByTag: false };
  }
  return { mode: 'full', forceCapRefetch: false, needsSlug: false, needsSlugsByTag: false };
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

/**
 * #541: resolve the set of tutorial slugs affected by a Tag rename/CRUD by
 * walking the TutorialTags many-to-many junction. Returns a deduped array
 * of slugs. Empty array means either the tag has no linked tutorials OR
 * the lookup failed (DB hiccup, schema mismatch).
 *
 * The caller (srv/server.js admin.after Tags hook) decides what to do with
 * the result:
 *   - 0 slugs → fall back to full+force-cap-refetch (safe default).
 *   - 1..TAG_REVERSE_LOOKUP_CAP → dispatch slug-targeted per slug.
 *   - >cap → fall back to full+force-cap-refetch.
 *
 * Errors are caught + WARN-logged so a transient DB issue doesn't crash the
 * admin save. Same defensive pattern as resolveSlugForEntity.
 *
 * @param {string|null|undefined} tagId — the Tag row's ID from req.data?.ID
 * @returns {Promise<string[]>}
 */
export async function resolveSlugsForTagRename(tagId) {
  if (!tagId || typeof tagId !== 'string') return [];
  try {
    const { TutorialTags } = cds.entities('com.sap.developers.ims');
    // Walk the junction: every TutorialTags row with this tag, expand the
    // tutorial association to read its slug. CDS QL .expand and the
    // navigation .slug both work; we use the dotted-path form because it
    // produces a single flat row shape (no nested objects).
    const rows = await SELECT.from(TutorialTags)
      .columns('tutorial.slug as slug')
      .where({ tag_ID: tagId });
    const slugs = new Set();
    for (const r of rows) {
      if (r?.slug) slugs.add(r.slug);
    }
    return [...slugs];
  } catch (err) {
    console.warn(`[_classify-rebuild-mode] resolveSlugsForTagRename(tagId=${tagId}) threw — falling back to empty array: ${err.message ?? err}`);
    return [];
  }
}
