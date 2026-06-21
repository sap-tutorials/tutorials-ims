// srv/lib/kg-graph-rebuild.js
// End-to-end full-graph rebuild — wipes the named graph and re-projects
// CDS state into RDF triples via the projection generator + SPARQL client.
//
// Source-of-truth references:
//   - PR 1 spike (#401) — established CALL SYS.SPARQL_EXECUTE access path.
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
//
// CONTRACT:
//   graphRebuild({ db, log, graphIri? })
//     1. Mints a fresh graphVersion (UUID).
//     2. Bootstrap INSERT to ensure the named graph exists (idempotent
//        — wiped by the CLEAR in step 3 either way).
//     3. CLEAR GRAPH <graphIri>.
//     4. for-await each batch from projectTriples({ db }), wraps in
//        INSERT DATA { GRAPH <graphIri> { ... } }, dispatches.
//     5. Upserts the singleton GraphMetadata row.
//     6. Returns { graphVersion, tripleCount, durationMs, predicateCounts }.
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
import { sparqlExec } from './kg-sparql-client.js';
import { projectTriples } from './kg-projection.js';

// Production graph IRI — must match the spec and the query-layer reader.
export const DEFAULT_GRAPH_IRI = 'https://developers.sap.com/kg/tutorials';

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
 * Wrap a batch of N-Triples lines in a SPARQL INSERT DATA { GRAPH <...> { ... } }
 * block. Lines from projectTriples already end in ` .` so we just newline-join.
 */
function buildInsertData(graphIri, batch) {
  return `INSERT DATA { GRAPH <${graphIri}> {\n${batch.join('\n')}\n} }`;
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
  await sparqlExec(db, `INSERT DATA { GRAPH <${targetGraph}> { ${BOOTSTRAP_TRIPLE} } }`);

  // Step 2: wipe the named graph (now guaranteed to exist).
  await sparqlExec(db, `CLEAR GRAPH <${targetGraph}>`);

  // Step 3: stream batches from the projection generator.
  let tripleCount = 0;
  const predicateCounts = new Map();
  for await (const batch of projectTriples({ db, batchSize })) {
    if (!batch || batch.length === 0) continue;
    const insertSparql = buildInsertData(targetGraph, batch);
    await sparqlExec(db, insertSparql);
    tripleCount += batch.length;
    tallyPredicates(batch, predicateCounts);
  }

  const durationMs = Date.now() - startedAt;
  const predicateCountsObj = Object.fromEntries(predicateCounts);

  // Step 4: persist metadata.
  await upsertGraphMetadata(db, {
    ID: GRAPH_METADATA_SINGLETON_ID,
    graphVersion,
    lastRebuiltAt: new Date(),
    tripleCount,
    durationMs,
  });

  logger.info(
    { graphVersion, tripleCount, durationMs, predicateCounts: predicateCountsObj },
    'graphRebuild complete'
  );

  return {
    graphVersion,
    tripleCount,
    durationMs,
    predicateCounts: predicateCountsObj,
  };
}

// Test-only exports for the hybrid test to reuse the same constants.
export const __TESTING__ = {
  buildInsertData,
  tallyPredicates,
  PREDICATE_RE,
};
