// srv/lib/kg-tutorial-teaches-map.js
//
// In-process cache for the tutorial-teaches map used by the neighborhood
// handler's subset-suppression pass in rankNeighborhood().
//
// The map is a Map<tutorialSlug, Set<conceptSlug>> — one entry per
// (tutorial, active-concept, teaches-link) tuple in the DB. Cost of a
// fresh build is one full-table scan of TutorialConceptLinks joined with
// Tutorials + Concepts:
//
//   ~800ms warm, ~1s cold on the DEV dataset (110 published concepts,
//   4,679 tutorial-concept links).
//
// The neighborhood handler runs on EVERY /graph/neighborhood request,
// which means every request pays that cost even though the underlying
// data only changes when the concept-extraction cron runs (weekly) or
// admin curation flips concept status. A 5-minute in-process TTL captures
// >99% of that churn; the rest is caught by an explicit bust hook wired
// into graphRebuild() (see srv/lib/kg-graph-rebuild.js).
//
// Extracted from srv/knowledge-graph-service.js (was inline
// buildTutorialTeachesMap at line 394) in the KG-widget-perf PR.

import cds from '@sap/cds';

const NAMESPACE = 'com.sap.developers.ims';

// Same TTL as srv/lib/co-completion.js on the JIT path: 5 min covers a
// typical viewer session, and the bust hook handles graph-rebuild deltas.
const TTL_MS = 5 * 60 * 1000;

// Cardinality guard — logs a warning if the map ever explodes. Copied
// from the original inline constant so we preserve its semantics.
const MAX_TEACHES_MAP_ROWS = 200_000;

let cache = null;
let cacheAt = 0;
let inflight = null;

function isHana(db) {
  return db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
}

/**
 * Compute the raw (uncached) tutorial-teaches map. Exported for the cron/
 * consolidator to force-recompute on demand and for tests to bypass the
 * cache.
 */
export async function computeTutorialTeachesMap(db, log) {
  const rows = isHana(db)
    ? await db.run(
        `SELECT t."SLUG" AS "TUT_SLUG", c."SLUG" AS "CONCEPT_SLUG"
         FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS" l
         JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t."ID" = l."TUTORIAL_ID"
         JOIN "COM_SAP_DEVELOPERS_IMS_CONCEPTS" c   ON c."ID" = l."CONCEPT_ID"
         WHERE l."PREDICATE" = 'teaches' AND c."STATUS" = 'ACTIVE'`,
      )
    : await (async () => {
        // SQLite test path: small enough that a 3-way fetch+join in JS is fine.
        const { TutorialConceptLinks, Tutorials, Concepts } =
          cds.entities(NAMESPACE);
        const links = await SELECT.from(TutorialConceptLinks)
          .columns('tutorial_ID', 'concept_ID')
          .where({ predicate: 'teaches' });
        const tutIds = [...new Set(links.map((l) => l.tutorial_ID).filter(Boolean))];
        const conceptIds = [...new Set(links.map((l) => l.concept_ID).filter(Boolean))];
        const [tuts, concepts] = await Promise.all([
          tutIds.length
            ? SELECT.from(Tutorials).columns('ID', 'slug').where({ ID: { in: tutIds } })
            : Promise.resolve([]),
          conceptIds.length
            ? SELECT.from(Concepts)
                .columns('ID', 'slug', 'status')
                .where({ ID: { in: conceptIds }, status: 'ACTIVE' })
            : Promise.resolve([]),
        ]);
        const tutSlug = new Map(tuts.map((t) => [t.ID, t.slug]));
        const conSlug = new Map(concepts.map((c) => [c.ID, c.slug]));
        return links.map((l) => ({
          TUT_SLUG: tutSlug.get(l.tutorial_ID),
          CONCEPT_SLUG: conSlug.get(l.concept_ID),
        }));
      })();

  const map = new Map();
  let count = 0;
  for (const r of rows) {
    const tut = r.TUT_SLUG ?? r.tut_slug;
    const con = r.CONCEPT_SLUG ?? r.concept_slug;
    if (!tut || !con) continue;
    if (++count > MAX_TEACHES_MAP_ROWS) {
      log?.warn?.(
        `kg-tutorial-teaches-map: exceeded ${MAX_TEACHES_MAP_ROWS} rows; truncating`,
      );
      break;
    }
    if (!map.has(tut)) map.set(tut, new Set());
    map.get(tut).add(con);
  }
  return map;
}

/**
 * Cached wrapper. Returns the same Map instance for the whole TTL window
 * so callers can safely iterate without worrying about the underlying
 * data churning mid-loop.
 *
 * Coalesces concurrent misses via the `inflight` singleton — three
 * simultaneous neighborhood() calls on cold cache result in ONE DB scan,
 * not three.
 */
export async function getTutorialTeachesMap(db, log) {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  if (inflight) return inflight;

  const work = (async () => {
    try {
      const result = await computeTutorialTeachesMap(db, log);
      cache = result;
      cacheAt = Date.now();
      return result;
    } finally {
      if (inflight === work) inflight = null;
    }
  })();
  inflight = work;
  return work;
}

/**
 * Bust the cache. Called by graphRebuild() after a fresh graphVersion is
 * minted, so the next neighborhood() call sees the updated concept set
 * without waiting for the 5-minute TTL to expire.
 */
export function bustTutorialTeachesCache() {
  cache = null;
  cacheAt = 0;
  inflight = null;
}
