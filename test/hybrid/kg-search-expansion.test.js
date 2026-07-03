// test/hybrid/kg-search-expansion.test.js
//
// Hybrid HANA + real AI Core coverage for the `expandSearchConcepts`
// Joule tool handler (issue #943).
//
// End-to-end walk:
//   1. Seed 3 Concepts (`__TEST__` slugs) with real 1536-dim embeddings
//      minted by the shared AI Core client (one embed() call per concept).
//   2. Link two of them with a ConceptEdges row so the one-hop walk has
//      something to expand.
//   3. Seed 2 Tutorials + TutorialConceptLinks so the aggregation branch
//      of the handler has hits to return.
//   4. Invoke expandSearchConceptsHandler({ db, embedClient, args }) with
//      a query that should embed near one of the seeded concepts.
//   5. Assert the response is non-empty and carries at least one
//      `rationale` string.
//
// COST: One AI Core embedding call per test run (3 for seeding + 1 for
// the query = 4 embeddings @ text-embedding-3-small = negligible $).
//
// GATING: Opt-in via BOTH `HYBRID_AI_TESTS=true` AND `ALLOW_HYBRID_WRITES=true`.
// Default `npm run test:hybrid` runs skip this file — free of $ cost.
//
// Run:
//   HYBRID_AI_TESTS=true ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-search-expansion.test.js

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { expandSearchConceptsHandler } from '../../srv/lib/kg/joule-tool-expand-concepts.js';
import { embed as embedInputs } from '../../srv/lib/embedding-client.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const RUN =
  process.env.HYBRID_AI_TESTS === 'true' &&
  process.env.ALLOW_HYBRID_WRITES === 'true' &&
  isSafeForWrites();

const DIMS = 1536;
const BYTES_PER_FLOAT = 4;
const EMBED_MODEL = 'text-embedding-3-small';

function encodeEmbedding(vec) {
  const buf = Buffer.alloc(vec.length * BYTES_PER_FLOAT);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * BYTES_PER_FLOAT);
  return buf;
}

/**
 * Adapter matching the DI contract expected by expandSearchConceptsHandler:
 *   { embed(text, opts?) => Promise<Float32Array> }
 *
 * Same shape as srv/lib/chat-orchestrator.js `defaultEmbedClient`.
 */
function makeEmbedClient(model) {
  return {
    async embed(text /* , _opts */) {
      const [vec] = await embedInputs([text], model);
      return vec;
    },
  };
}

describe.runIf(RUN)('expandSearchConcepts hybrid — real HANA + real AI Core', () => {
  // Stable IDs so cleanup can DELETE by ID even if a test dies mid-INSERT.
  const CONCEPT_A_ID = '00000000-0000-0000-0000-943000000001';
  const CONCEPT_B_ID = '00000000-0000-0000-0000-943000000002';
  const CONCEPT_C_ID = '00000000-0000-0000-0000-943000000003';
  const EDGE_AB_ID   = '00000000-0000-0000-0000-943000000010';
  const TUT_1_ID     = '00000000-0000-0000-0000-943000000020';
  const TUT_2_ID     = '00000000-0000-0000-0000-943000000021';
  const LINK_1_ID    = '00000000-0000-0000-0000-943000000030';
  const LINK_2_ID    = '00000000-0000-0000-0000-943000000031';
  const LINK_3_ID    = '00000000-0000-0000-0000-943000000032';

  const SLUG_PREFIX = '__TEST__943-search-';
  const TUT_SLUG_PREFIX = '__TEST__943-search-tut-';

  const insertedConceptIds = [CONCEPT_A_ID, CONCEPT_B_ID, CONCEPT_C_ID];
  const insertedEdgeIds    = [EDGE_AB_ID];
  const insertedTutorialIds = [TUT_1_ID, TUT_2_ID];
  const insertedLinkIds    = [LINK_1_ID, LINK_2_ID, LINK_3_ID];

  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');

    // Fail fast if we somehow ended up on SQLite — this test only makes
    // sense against real HANA with the shared AI Core client.
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'kg-search-expansion.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }

    const { Concepts, ConceptEdges, Tutorials, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    // Seed 3 concepts with real 1536-dim embeddings. We use ABAP async-
    // programming vocabulary so a query like "ABAP asynchronous programming"
    // reliably lands nearest to the seeded rows.
    const conceptSeeds = [
      {
        ID: CONCEPT_A_ID,
        slug: `${SLUG_PREFIX}abap-async-programming`,
        name: '__TEST__ ABAP Asynchronous Programming',
        description: 'Non-blocking parallel processing in ABAP using aRFC, bgRFC and background tasks.',
      },
      {
        ID: CONCEPT_B_ID,
        slug: `${SLUG_PREFIX}abap-parallel-cursor`,
        name: '__TEST__ ABAP Parallel Cursor Technique',
        description: 'A performance idiom for nested-loop iteration over sorted internal tables in ABAP.',
      },
      {
        ID: CONCEPT_C_ID,
        slug: `${SLUG_PREFIX}cds-annotations`,
        name: '__TEST__ CDS Annotations',
        description: 'Semantic metadata layered onto Core Data Services artifacts for UI, auth, and analytics.',
      },
    ];

    // One embed() call batches all three inputs into a single AI Core round-trip.
    const texts = conceptSeeds.map((s) => `${s.name} — ${s.description}`);
    const vectors = await embedInputs(texts, EMBED_MODEL);

    for (let i = 0; i < conceptSeeds.length; i++) {
      const seed = conceptSeeds[i];
      const vec = vectors[i];
      if (!vec || vec.length !== DIMS) {
        throw new Error(`seed embed returned bad vector for ${seed.slug}`);
      }
      await INSERT.into(Concepts).entries({
        ID: seed.ID,
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        status: 'ACTIVE',
        // Read-side gate requires publishedAt IS NOT NULL — set explicitly
        // so the handler's fetchConceptsByIds / topConceptsByCosine see it.
        publishedAt: new Date().toISOString(),
        publishedBy: '__TEST__943@sap.com',
      });
      // Write the embedding via raw SQL — LargeBinary handled outside CDS QL
      // to match production write path (srv/jobs/concept-embedding-backfill.js).
      const blob = encodeEmbedding(vec);
      await db.run(
        `UPDATE COM_SAP_DEVELOPERS_IMS_CONCEPTS SET EMBEDDING = ? WHERE ID = ?`,
        [blob, seed.ID]
      );
    }

    // Edge A -> B so the one-hop walk from A pulls B as a neighbour.
    await INSERT.into(ConceptEdges).entries({
      ID: EDGE_AB_ID,
      source_ID: CONCEPT_A_ID,
      target_ID: CONCEPT_B_ID,
      predicate: 'relatedTo',
      confidence: 0.85,
      status: 'ACTIVE',
    });

    // Two tutorials linked to the concepts via TutorialConceptLinks.
    // These provide the tutorials[] result set of the handler.
    await INSERT.into(Tutorials).entries([
      {
        ID: TUT_1_ID,
        slug: `${TUT_SLUG_PREFIX}abap-async-intro`,
        title: '__TEST__ ABAP Async Intro',
      },
      {
        ID: TUT_2_ID,
        slug: `${TUT_SLUG_PREFIX}abap-parallel-cursor-howto`,
        title: '__TEST__ ABAP Parallel Cursor How-To',
      },
    ]);

    await INSERT.into(TutorialConceptLinks).entries([
      {
        ID: LINK_1_ID,
        tutorial_ID: TUT_1_ID,
        concept_ID: CONCEPT_A_ID,
        predicate: 'teaches',
        confidence: 0.9,
      },
      {
        ID: LINK_2_ID,
        tutorial_ID: TUT_2_ID,
        concept_ID: CONCEPT_A_ID,
        predicate: 'teaches',
        confidence: 0.6,
      },
      {
        ID: LINK_3_ID,
        tutorial_ID: TUT_2_ID,
        concept_ID: CONCEPT_B_ID,
        predicate: 'teaches',
        confidence: 0.8,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    const { Concepts, ConceptEdges, Tutorials, TutorialConceptLinks } =
      cds.entities('com.sap.developers.ims');

    // Delete in FK-safe order — links first, then edges, then parents.
    try {
      await DELETE.from(TutorialConceptLinks).where({ ID: { in: insertedLinkIds } });
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(ConceptEdges).where({ ID: { in: insertedEdgeIds } });
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(Tutorials).where({ ID: { in: insertedTutorialIds } });
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(Concepts).where({ ID: { in: insertedConceptIds } });
    } catch (_) { /* best-effort */ }

    // Belt-and-braces sweep — catches rows whose IDs weren't in the arrays
    // above (e.g. if a future edit adds fixtures and forgets to update the
    // cleanup list). @assert.unique.slug on Concepts / Tutorials would
    // otherwise block reruns.
    try {
      await DELETE.from(TutorialConceptLinks).where({ tutorial_ID: { in: insertedTutorialIds } });
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(Concepts).where({ slug: { like: `${SLUG_PREFIX}%` } });
    } catch (_) { /* best-effort */ }
    try {
      await DELETE.from(Tutorials).where({ slug: { like: `${TUT_SLUG_PREFIX}%` } });
    } catch (_) { /* best-effort */ }
  }, 30_000);

  it('returns concepts + tutorials with rationale for a real query via real embed + HANA cosine', async () => {
    const embedClient = makeEmbedClient(EMBED_MODEL);

    const out = await expandSearchConceptsHandler({
      db,
      embedClient,
      args: { query: 'ABAP asynchronous programming' },
      // Give AI Core + a full pass of edge/link fetches plenty of head-room
      // over the production 5s default — hybrid DEV round-trips are slower.
      timeoutMs: 30_000,
    });

    // Structural shape — never throws under happy-path.
    expect(out).toBeDefined();
    expect(out.queryEcho).toContain('ABAP');
    expect(out.warning).toBeUndefined();

    // Non-empty concept expansion — at least the seed row must land as a hit
    // since we controlled the embedding text upstream.
    expect(Array.isArray(out.concepts)).toBe(true);
    expect(out.concepts.length).toBeGreaterThan(0);

    // The nearest seeded concept slug must appear in the result set.
    const conceptSlugs = out.concepts.map((c) => c.slug);
    const sawSeed = conceptSlugs.some((s) => s && s.startsWith(SLUG_PREFIX));
    expect(sawSeed, `expected a seeded __TEST__ concept in ${JSON.stringify(conceptSlugs)}`).toBe(true);

    // Non-empty tutorials array + at least one rationale populated.
    expect(Array.isArray(out.tutorials)).toBe(true);
    expect(out.tutorials.length).toBeGreaterThan(0);
    const withRationale = out.tutorials.find(
      (t) => typeof t.rationale === 'string' && t.rationale.length > 0
    );
    expect(
      withRationale,
      `expected at least one tutorial with rationale in ${JSON.stringify(out.tutorials)}`
    ).toBeDefined();

    // Sanity: at least one seeded tutorial should surface.
    const tutSlugs = out.tutorials.map((t) => t.slug);
    const sawSeedTut = tutSlugs.some((s) => s && s.startsWith(TUT_SLUG_PREFIX));
    expect(
      sawSeedTut,
      `expected a seeded __TEST__ tutorial in ${JSON.stringify(tutSlugs)}`
    ).toBe(true);
  }, 60_000);
});
