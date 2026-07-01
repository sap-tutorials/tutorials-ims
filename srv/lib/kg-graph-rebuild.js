// srv/lib/kg-graph-rebuild.js
// End-to-end full-graph rebuild — wipes the named graph and re-projects
// CDS state into RDF triples via the projection generator + SPARQL client.
//
// Source-of-truth references:
//   - PR 1 spike (#401) — established the DEFINER procedure access path.
//   - docs/superpowers/plans/2026-06-17-knowledge-graph-implementation.md
//     Task 4.4 — for the rebuild contract and audit-log fields.
//   - docs/superpowers/specs/2026-06-17-knowledge-graph-design.md — for
//     the graph IRI and predicate ontology.
//   - #525 (2026-06-21) — added the bootstrap INSERT before CLEAR. HANA
//     Cloud SPARQL does NOT support CREATE/DROP GRAPH DDL, and CLEAR on
//     a never-created graph fails with "Object does not exist". The
//     bootstrap INSERT auto-creates the graph (only `INSERT DATA` has
//     that implicit-create behaviour on HANA Cloud); the immediate
//     CLEAR then wipes the bootstrap triple and any prior state.
//   - Task 8 — replaced direct sparqlExec calls with typed-client calls to
//     the DEFINER procedures kgGraphClear + kgGraphInsert (see
//     srv/lib/kg-sparql-client.js for the procedure boundary).
//
// CONTRACT:
//   graphRebuild({ db, log, graphIri? })
//     1. Mints a fresh graphVersion (UUID).
//     2. Bootstrap INSERT to ensure the named graph exists (idempotent
//        — wiped by the CLEAR in step 3 either way).
//     3. CLEAR GRAPH <graphIri>.
//     4. for-await each batch from projectTriples({ db }), wraps in
//        INSERT DATA { GRAPH <graphIri> { ... } }, dispatches.
//     5. Upserts the singleton GraphMetadata row (including the
//        per-predicate counts + conceptCount/edgeCount — #526).
//     6. Returns { graphVersion, tripleCount, durationMs, conceptCount,
//        edgeCount, predicateCounts }.
//
//   Errors during the iteration propagate. We do NOT roll back partial
//   inserts — the next call's CLEAR GRAPH will wipe any partial state.
//   That is acceptable because the consolidator job is idempotent and the
//   query layer only reads from GraphMetadata-confirmed versions.
//
//   The graphIri parameter exists primarily so the hybrid test can
//   target a TEST-specific graph and never mutate production state. The
//   default is the production graph URI from the spec.

import { randomUUID } from 'node:crypto';
import { kgGraphClear, kgGraphInsert } from './kg-sparql-client.js';
import { projectTriples } from './kg-projection.js';
import { bustTutorialTeachesCache } from './kg-tutorial-teaches-map.js';
import { bustNeighborhoodCache } from './kg-neighborhood-cache.js';

// Production graph IRI. Bumped from `https://developers.sap.com/kg/tutorials`
// to `…/tutorials-v2` on 2026-06-21 (issue #533) because the original IRI
// was ACL-locked under a non-runtime user — a prior debug session or
// failed cf-task likely created the graph under a different identity,
// and HANA's KGE applies per-graph ACL that the .hdbgrants flow does not
// override. Probed live: INSERT to the old IRI returned "User is not
// allowed (INSERT)" while INSERT to any other IRI (including
// `…/tutorials-test`) succeeded under the same runtime user.
//
// MUST stay in sync with srv/lib/kg-queries.js `FROM <…>` clauses (3
// places) and the named-query test in test/hybrid/kg-named-queries.test.js.
// A grep on `developers.sap.com/kg/tutorials($|[^-])` should yield only
// docs references after a coordinated rename.
export const DEFAULT_GRAPH_IRI = 'https://developers.sap.com/kg/tutorials-v3';

// Bootstrap triple used to ensure the named graph exists before CLEAR.
// All three positions use the same "ghost" IRI so the triple is obviously
// not real data to anyone debugging. The triple is wiped by the immediate
// CLEAR that follows, so consumers never see it.
//
// Why we need this: HANA Cloud KGE doesn't support `CREATE GRAPH` /
// `CREATE SILENT GRAPH` DDL ("Unsupported functionality: DDL not allowed"
// — confirmed 2026-06-21 against the live runtime). Only `INSERT DATA`
// has implicit-create semantics for named graphs. So we auto-create via
// INSERT, then CLEAR. After the first successful run the graph
// "registration" persists across CLEARs (verified in the same probe);
// subsequent rebuilds make the bootstrap a no-op-equivalent (it inserts
// + immediately clears a single triple, ~750ms cold / ~250ms warm).
export const BOOTSTRAP_TRIPLE = '<urn:bootstrap:ignore> <urn:bootstrap:ignore> <urn:bootstrap:ignore> .';

// Fixed singleton ID for the GraphMetadata row. Chosen as a stable UUID
// so the upsert always targets the same row across rebuilds. Hardcoded
// (rather than an env var) because it is part of the schema contract.
export const GRAPH_METADATA_SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

// Predicate-counter regex — extracts the predicate IRI from an N-Triples
// line. The grammar guarantees subject + space + predicate as the first
// two tokens; the predicate is the second <...> token.
const PREDICATE_RE = /^\s*\S+\s+(<[^>]+>)\s+/;

// Predicate IRIs emitted by kg-projection.js, mapped to the GraphMetadata
// per-predicate-count column names. Keys are the EXACT N-Triples form
// (`<...>` brackets included) that tallyPredicates() captures. Added with
// #526 — the persisted breakdown saves a SPARQL round-trip when verifying
// "did this rebuild emit roughly the right cardinality per predicate?".
// Source-of-truth for this list is kg-projection.js; keep in sync.
const PREDICATE_TO_COUNT_FIELD = Object.freeze({
  '<https://developers.sap.com/kg/teaches>'         : 'teachesCount',
  '<https://developers.sap.com/kg/requires>'        : 'requiresCount',
  '<https://developers.sap.com/kg/relatedTo>'       : 'relatedToCount',
  '<https://developers.sap.com/kg/extends>'         : 'extendsCount',
  '<https://developers.sap.com/kg/partOf>'          : 'partOfCount',
  '<https://developers.sap.com/kg/taggedWith>'      : 'taggedWithCount',
  '<https://developers.sap.com/kg/aboutProduct>'    : 'aboutProductCount',
  '<https://developers.sap.com/kg/inCategory>'      : 'inCategoryCount',
  '<https://developers.sap.com/kg/coCompletedWith>' : 'coCompletedWithCount',
});

/**
 * Project predicateCounts (Map keyed by full N-Triples IRI form) to the
 * named GraphMetadata column fields. Unknown predicates (e.g.
 * `<…/kg/slug>` literal-triple metadata that the projection ALSO emits
 * for each concept) are silently ignored — they don't have dedicated
 * count columns and aren't part of the user-facing predicate ontology.
 *
 * Returns a plain object with one key per known predicate, defaulting to
 * 0 if the predicate didn't appear in this projection (e.g. a fresh
 * environment with no co-completion data emits 0 `coCompletedWithCount`).
 */
export function projectPredicateCounts(predicateCounts) {
  const out = {};
  for (const field of Object.values(PREDICATE_TO_COUNT_FIELD)) {
    out[field] = 0;
  }
  for (const [pred, n] of predicateCounts.entries()) {
    const field = PREDICATE_TO_COUNT_FIELD[pred];
    if (field) out[field] = n;
  }
  return out;
}

/** Tally a batch of N-Triples lines into a per-predicate Map. */
function tallyPredicates(batch, counters) {
  for (const line of batch) {
    const m = PREDICATE_RE.exec(line);
    if (m) {
      const pred = m[1];
      counters.set(pred, (counters.get(pred) ?? 0) + 1);
    }
  }
}

/**
 * Upsert the singleton GraphMetadata row. We use the codebase-wide
 * SELECT-then-INSERT-or-UPDATE idiom (per developer-service.js:593,
 * "zero direct UPSERT statements anywhere under srv/") rather than CDS
 * QL UPSERT. Wrapped in a single tx so the read+write is atomic.
 */
async function upsertGraphMetadata(db, fields) {
  const cdsMod = await import('@sap/cds');
  const cds = cdsMod.default || cdsMod;
  const { GraphMetadata } = cds.entities('com.sap.developers.ims');

  await db.tx(async (tx) => {
    const existing = await tx.run(
      SELECT.one.from(GraphMetadata).columns('ID').where({ ID: fields.ID })
    );
    if (existing) {
      const { ID, ...rest } = fields;
      await tx.run(UPDATE(GraphMetadata).set(rest).where({ ID }));
    } else {
      await tx.run(INSERT.into(GraphMetadata).entries(fields));
    }
  });
}

/**
 * Run a full graph rebuild end-to-end.
 *
 * @param {object}  args
 * @param {object}  args.db         — CAP db service from cds.connect.to('db')
 * @param {object}  [args.log]      — pino-style logger; no-op fallback if missing.
 * @param {string}  [args.graphIri] — named graph IRI; default DEFAULT_GRAPH_IRI.
 * @param {number}  [args.batchSize] — projection batch size; passed through.
 * @returns {Promise<{
 *   graphVersion: string,
 *   tripleCount: number,
 *   durationMs: number,
 *   conceptCount: number,
 *   edgeCount: number,
 *   predicateCounts: Record<string, number>
 * }>}
 */
export async function graphRebuild({ db, log, graphIri, batchSize } = {}) {
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('graphRebuild: db must be a CDS service with .run()');
  }
  const targetGraph = graphIri || DEFAULT_GRAPH_IRI;
  const noopLog = { info() {}, error() {}, warn() {}, debug() {} };
  const logger = log || noopLog;

  const graphVersion = randomUUID();
  const startedAt = Date.now();
  logger.info({ graphVersion, graphIri: targetGraph }, 'graphRebuild start');

  // Step 1: bootstrap. Ensures the named graph exists so the CLEAR in
  // step 2 doesn't fail "Object does not exist or is inaccessible" on
  // first-ever invocation against a fresh HDI container. See
  // BOOTSTRAP_TRIPLE comment for the HANA-specific rationale.
  //
  // The bootstrap triple is immediately wiped by CLEAR; readers never
  // see it. On warm graphs this is ~250ms; on a cold graph it's the
  // one-shot ~750ms cost of registering the named graph with KGE.
  await kgGraphInsert({ db, graphIri: targetGraph, triples: BOOTSTRAP_TRIPLE });

  // Step 2: wipe the named graph (now guaranteed to exist).
  await kgGraphClear({ db, graphIri: targetGraph });

  // Step 3: stream batches from the projection generator.
  let tripleCount = 0;
  const predicateCounts = new Map();
  for await (const batch of projectTriples({ db, batchSize })) {
    if (!batch || batch.length === 0) continue;
    await kgGraphInsert({ db, graphIri: targetGraph, triples: batch.join('\n') });
    tripleCount += batch.length;
    tallyPredicates(batch, predicateCounts);
  }

  const durationMs = Date.now() - startedAt;
  const predicateCountsObj = Object.fromEntries(predicateCounts);
  const predicateCountFields = projectPredicateCounts(predicateCounts);

  // High-level entity counts for GraphMetadata (#526). Cheap COUNT(*)
  // queries — these only matter for the singleton metadata write and
  // would otherwise cost a SPARQL round-trip per predicate when an
  // observer wants to verify cardinality. Wrap in try/catch so a count
  // failure doesn't poison the rebuild — the persisted graph is the
  // source of truth, these are observability metadata.
  let conceptCount = 0;
  let edgeCount = 0;
  try {
    const [{ N }] = await db.run(
      `SELECT COUNT(*) AS N FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTS" WHERE STATUS = 'ACTIVE'`
    );
    conceptCount = Number(N) || 0;
  } catch (err) {
    logger.warn({ err: err?.message }, 'graphRebuild: conceptCount probe failed; defaulting to 0');
  }
  try {
    const [{ N }] = await db.run(
      `SELECT COUNT(*) AS N FROM "COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES" WHERE STATUS = 'ACTIVE'`
    );
    edgeCount = Number(N) || 0;
  } catch (err) {
    logger.warn({ err: err?.message }, 'graphRebuild: edgeCount probe failed; defaulting to 0');
  }

  // Step 5: persist metadata.
  await upsertGraphMetadata(db, {
    ID: GRAPH_METADATA_SINGLETON_ID,
    graphVersion,
    lastRebuiltAt: new Date(),
    tripleCount,
    durationMs,
    conceptCount,
    edgeCount,
    ...predicateCountFields,
  });

  // Step 6: bust in-process caches whose keying is tied to the OLD
  // graphVersion. The neighborhood-result cache keys by (slug, graphVersion)
  // so its old entries are unreachable — but freeing them proactively
  // saves LRU pressure. The tutorial-teaches map cache is keyed by nothing
  // — a rebuild is exactly when its underlying data could have changed
  // (new concept published, status flipped), so we bust it too.
  bustTutorialTeachesCache();
  bustNeighborhoodCache();

  logger.info(
    { graphVersion, tripleCount, durationMs, conceptCount, edgeCount, predicateCounts: predicateCountsObj },
    'graphRebuild complete'
  );

  return {
    graphVersion,
    tripleCount,
    durationMs,
    conceptCount,
    edgeCount,
    predicateCounts: predicateCountsObj,
  };
}

// Test-only exports for the hybrid test to reuse the same constants.
export const __TESTING__ = {
  tallyPredicates,
  PREDICATE_RE,
  PREDICATE_TO_COUNT_FIELD,
};
