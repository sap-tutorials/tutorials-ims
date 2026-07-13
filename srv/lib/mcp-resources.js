// srv/lib/mcp-resources.js
//
// MCP resource templates for tutorial://, mission://, concept:// URIs.
// Registered by the compose router (next task) via registerResources().
//
// Design notes (see task-6-report.md for full rationale):
//
//  - Uses string-based SELECT.from('com.sap.developers.ims.Entity') throughout
//    so that cds.entities(NS) is never called at module load time — the CDS
//    model may not be loaded in unit tests that inject a fakeDb.
//
//  - Tutorials.tags is an Association to many TutorialTags (NOT a plain string
//    column). v1 returns tags:[] and defers real expansion to a future task.
//    // TODO tags via TutorialTags assoc — expand when tag-facet MCP tool lands.
//
//  - Mission tutorial traversal is two-step:
//      1. SELECT CompletionPaths WHERE mission.slug = slug  → collect path IDs
//      2. SELECT CompletionPathItems WHERE path_ID IN (ids) + expand tutorial →
//         sort by itemOrder
//    This avoids the deep path.mission.slug navigation whose HANA cross-join
//    behaviour across three tables is less predictable under load.
//
//  - concept:// filters status='ACTIVE' (MERGED/VETOED/RETIRED excluded).
//    teachingTutorials and relatedConcepts are empty in v1; populated via
//    ConceptLinks in a future task.
//
// (#1106 Task 6)

import cds from '@sap/cds';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as defaultSlicer from './tutorial-step-slicer.js';

const { SELECT } = cds.ql;
const log = cds.log('mcp-resources');

export const RESOURCE_LIST_CAP = 500;

const NS = 'com.sap.developers.ims';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a JSON content block for a resource URI. */
function jsonBlock(uri, obj) {
  return { uri, mimeType: 'application/json', text: JSON.stringify(obj) };
}

// ---------------------------------------------------------------------------
// Read functions (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Read a tutorial resource.
 * Returns: { contents: [{ uri, mimeType:'application/json', text:JSON }] }
 * Fail-open: never throws to caller — returns an empty-ish shape on any error.
 *
 * @param {string} slug
 * @param {{ db?: object, slicer?: object }} opts
 */
export async function readTutorialResource(slug, { db = cds.db, slicer = defaultSlicer } = {}) {
  const s = (slug ?? '').toLowerCase();
  try {
    const row = await db.run(
      SELECT.one.from(`${NS}.Tutorials`).where({ slug: s }),
    );
    // Tutorials.tags is Association to many TutorialTags — NOT a plain string.
    // v1 defers real tag expansion; return [] until tag-facet MCP tool lands.
    // TODO tags via TutorialTags assoc — expand when tag-facet MCP tool lands.
    const steps = (await slicer.sliceAllSteps(s)) ?? [];
    const meta = {
      slug:       s,
      title:      row?.title ?? s,
      totalSteps: steps.length,
      steps:      steps.map((st) => ({ n: st.stepNumber, title: st.title })),
      tags:       [],
    };
    return { contents: [jsonBlock(`tutorial://${s}`, meta)] };
  } catch (err) {
    log.error(`readTutorialResource(${s}) failed — ${err.message}`);
    return { contents: [jsonBlock(`tutorial://${s}`, { slug: s, title: s, totalSteps: 0, steps: [], tags: [] })] };
  }
}

/**
 * Read a mission resource.
 * Returns mission metadata + an ordered list of tutorial slugs/titles.
 *
 * Two-step traversal:
 *   1. CompletionPaths WHERE mission.slug = slug
 *   2. CompletionPathItems WHERE path_ID IN (path IDs), tutorial expanded, ordered by itemOrder
 *
 * @param {string} slug
 * @param {{ db?: object }} opts
 */
export async function readMissionResource(slug, { db = cds.db } = {}) {
  const s = (slug ?? '').toLowerCase();
  try {
    const row = await db.run(
      SELECT.one.from(`${NS}.Missions`).where({ slug: s }),
    );

    // Step 1: get all CompletionPaths for this mission.
    const paths = await db.run(
      SELECT.from(`${NS}.CompletionPaths`).columns('ID').where({ 'mission.slug': s }),
    );

    let tutorials = [];
    if (paths.length > 0) {
      const pathIds = paths.map((p) => p.ID);

      // Step 2: get all CompletionPathItems for those paths, expand tutorial association.
      const items = await db.run(
        SELECT.from(`${NS}.CompletionPathItems`)
          .columns('itemOrder', { ref: ['tutorial'], expand: ['slug', 'title'] })
          .where({ path_ID: { in: pathIds } })
          .orderBy('itemOrder'),
      );

      tutorials = items
        .filter((i) => i.tutorial)
        .sort((a, b) => (a.itemOrder ?? 0) - (b.itemOrder ?? 0))
        .map((i) => ({
          slug:  i.tutorial.slug  ?? i.tutorial_slug  ?? null,
          title: i.tutorial.title ?? i.tutorial_title ?? i.tutorial.slug ?? null,
          order: i.itemOrder ?? 0,
        }));
    }

    const meta = {
      slug:      s,
      title:     row?.title ?? s,
      tutorials,
    };
    return { contents: [jsonBlock(`mission://${s}`, meta)] };
  } catch (err) {
    log.error(`readMissionResource(${s}) failed — ${err.message}`);
    return { contents: [jsonBlock(`mission://${s}`, { slug: s, title: s, tutorials: [] })] };
  }
}

/**
 * Read a concept resource.
 * `id` can be a UUID or a slug — we try UUID first, then slug fallback.
 * Filters to status='ACTIVE' only.
 *
 * teachingTutorials and relatedConcepts are empty in v1.
 * TODO populate via ConceptLinks (predicate='teaches') + ConceptEdges.
 *
 * @param {string} id  UUID or slug
 * @param {{ db?: object }} opts
 */
export async function readConceptResource(id, { db = cds.db } = {}) {
  try {
    // Try by UUID first; fall back to slug if the caller passes a slug string.
    const row =
      (await db.run(SELECT.one.from(`${NS}.Concepts`).where({ ID: id, status: 'ACTIVE' })))
      ?? (await db.run(SELECT.one.from(`${NS}.Concepts`).where({ slug: id, status: 'ACTIVE' })));

    const meta = row
      ? {
          id:                 row.ID,
          slug:               row.slug,
          name:               row.name,
          teachingTutorials:  [], // TODO via ConceptLinks WHERE predicate='teaches'
          relatedConcepts:    [], // TODO via ConceptEdges
        }
      : {
          id,
          slug:              null,
          name:              null,
          teachingTutorials: [],
          relatedConcepts:   [],
        };
    return { contents: [jsonBlock(`concept://${id}`, meta)] };
  } catch (err) {
    log.error(`readConceptResource(${id}) failed — ${err.message}`);
    return { contents: [jsonBlock(`concept://${id}`, { id, slug: null, name: null, teachingTutorials: [], relatedConcepts: [] })] };
  }
}

// ---------------------------------------------------------------------------
// List helper (shared by all three resource templates)
// ---------------------------------------------------------------------------

/**
 * List resources of a given entity up to RESOURCE_LIST_CAP.
 * Returns `{ resources: [...] }` matching ListResourcesResult schema.
 */
async function listResources(entityFqn, scheme, { db, active = false } = {}) {
  let q = SELECT.from(entityFqn).columns('ID', 'slug', 'name', 'title').limit(RESOURCE_LIST_CAP + 1);
  if (active) q = q.where({ status: 'ACTIVE' });
  let rows = [];
  try {
    rows = await db.run(q);
  } catch (err) {
    log.error(`resources/list ${scheme} failed — ${err.message}`);
    return { resources: [] };
  }
  const truncated = rows.length > RESOURCE_LIST_CAP;
  if (truncated) log.warn(`resources/list ${scheme}: truncated at ${RESOURCE_LIST_CAP}`);
  const items = rows.slice(0, RESOURCE_LIST_CAP).map((r) => ({
    uri:      `${scheme}://${scheme === 'concept' ? (r.ID ?? r.slug) : r.slug}`,
    name:     r.title ?? r.name ?? r.slug ?? r.ID,
    mimeType: 'application/json',
  }));
  return { resources: items };
}

// ---------------------------------------------------------------------------
// registerResources — called by the compose router
// ---------------------------------------------------------------------------

/**
 * Register all three MCP resource templates on `server`.
 * Injects `db` and `slicer` for testability; defaults to `cds.db` and the
 * real tutorial-step-slicer at runtime.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ db?: object, slicer?: object }} opts
 */
export function registerResources(server, { db = cds.db, slicer = defaultSlicer } = {}) {
  // tutorial://
  server.registerResource(
    'tutorial',
    new ResourceTemplate('tutorial://{slug}', {
      list: () => listResources(`${NS}.Tutorials`, 'tutorial', { db }),
    }),
    { title: 'Tutorial', description: 'A published SAP tutorial: metadata, step titles, and rendered HTML.' },
    async (_uri, { slug }) => readTutorialResource(slug, { db, slicer }),
  );

  // mission://
  server.registerResource(
    'mission',
    new ResourceTemplate('mission://{slug}', {
      list: () => listResources(`${NS}.Missions`, 'mission', { db }),
    }),
    { title: 'Mission', description: 'An SAP mission and its ordered tutorial path.' },
    async (_uri, { slug }) => readMissionResource(slug, { db }),
  );

  // concept://
  server.registerResource(
    'concept',
    new ResourceTemplate('concept://{id}', {
      list: () => listResources(`${NS}.Concepts`, 'concept', { db, active: true }),
    }),
    { title: 'Concept', description: 'A knowledge-graph concept (ACTIVE only) and the tutorials that teach it.' },
    async (_uri, { id }) => readConceptResource(id, { db }),
  );
}
