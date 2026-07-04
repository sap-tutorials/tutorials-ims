// test/hybrid/search-kg-rerank.test.js
//
// Hybrid HANA + real AI Core coverage for the server-side search rerank
// path introduced in issue #945.
//
// End-to-end walk:
//   1. Seed 1 Concept (`__TEST__` slug) with a real 1536-dim embedding.
//   2. Seed 2 Tutorials + TutorialConceptLinks — one with high link
//      confidence (0.9), one with low (0.1). Both share the same title
//      token so their fuzzy rank is identical; only KG breaks the tie.
//   3. Enable `searchKgRerankEnabled` on the ChatSettings singleton.
//   4. Issue a `.search(...)` against SearchService.SearchableItems.
//   5. Assert the strong-link tutorial ranks above the weak-link one AND
//      that `searchScore` reflects the KG contribution.
//
// This is the counterpart to test/unit/search-service-kg-blend.test.js, which
// only verifies wiring (`searchScore` metadata + graceful degradation) —
// unit-side end-to-end is blocked by the two-module-identity quirk of
// cds.test('serve') (see comment in that file).
//
// COST: One AI Core embedding call per test run (1 for the concept seed +
// 1 for the query = 2 embeddings @ text-embedding-3-small = negligible $).
//
// GATING: Opt-in via BOTH `HYBRID_AI_TESTS=true` AND `ALLOW_HYBRID_WRITES=true`.
// Default `npm run test:hybrid` runs skip this file.
//
// Run:
//   HYBRID_AI_TESTS=true ALLOW_HYBRID_WRITES=true \
//     npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/search-kg-rerank.test.js

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { embed as embedInputs } from '../../srv/lib/embedding-client.js';
import { _resetForTest as resetSignalCache } from '../../srv/lib/search-kg-signal.js';

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

describe.runIf(RUN)('#945 SearchService KG rerank — hybrid HANA', () => {
  // Stable IDs so cleanup can DELETE by ID even if a test dies mid-INSERT.
  const CONCEPT_ID  = '00000000-0000-0000-0000-945000000001';
  const TUT_STRONG  = '00000000-0000-0000-0000-945000000020';
  const TUT_WEAK    = '00000000-0000-0000-0000-945000000021';
  const LINK_STRONG = '00000000-0000-0000-0000-945000000030';
  const LINK_WEAK   = '00000000-0000-0000-0000-945000000031';
  const CS_ID       = '00000000-0000-0000-0000-945000000040';

  const SLUG_PREFIX = '__TEST__945-';
  const CONCEPT_SLUG = `${SLUG_PREFIX}concept-kgrerank`;
  const TUT_STRONG_SLUG = `${SLUG_PREFIX}tut-strong-kgrerank`;
  const TUT_WEAK_SLUG   = `${SLUG_PREFIX}tut-weak-kgrerank`;
  // A recognizably distinctive title token — no existing catalog row should
  // match, so our fixtures dominate the result set for this query.
  const TITLE_TOKEN = '__test945probe';

  let db;
  let prevSettings = null;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error('search-kg-rerank.test.js must run against HANA (use `npm run test:hybrid`).');
    }

    const {
      Concepts, Tutorials, TutorialConceptLinks, ChatSettings,
    } = cds.entities('com.sap.developers.ims');

    // Save current settings singleton so we can restore in afterAll.
    prevSettings = await SELECT.one.from(ChatSettings);

    // Seed the concept with a real embedding.
    const [conceptVec] = await embedInputs(
      ['__TEST__945 KG rerank probe concept — teaches asynchronous programming'],
      EMBED_MODEL,
    );
    await INSERT.into(Concepts).entries({
      ID: CONCEPT_ID,
      slug: CONCEPT_SLUG,
      name: '__TEST__945 KG Rerank Probe',
      description: 'Test-only concept for the #945 rerank hybrid test.',
      status: 'ACTIVE',
      publishedAt: new Date().toISOString(),
      publishedBy: '__TEST__945@sap.com',
    });
    await db.run(
      `UPDATE COM_SAP_DEVELOPERS_IMS_CONCEPTS SET EMBEDDING = ? WHERE ID = ?`,
      [encodeEmbedding(conceptVec), CONCEPT_ID],
    );

    // Seed 2 tutorials whose title contains the same probe token. Fuzzy rank
    // will be equal (title-match = +3); KG breaks the tie.
    await INSERT.into(Tutorials).entries([
      {
        ID: TUT_STRONG, slug: TUT_STRONG_SLUG,
        title: `${TITLE_TOKEN} Strong Match Tutorial`,
        status: 'ACTIVE',
      },
      {
        ID: TUT_WEAK, slug: TUT_WEAK_SLUG,
        title: `${TITLE_TOKEN} Weak Match Tutorial`,
        status: 'ACTIVE',
      },
    ]);

    // Different link confidences → different KG contributions to rank.
    await INSERT.into(TutorialConceptLinks).entries([
      { ID: LINK_STRONG, tutorial_ID: TUT_STRONG, concept_ID: CONCEPT_ID,
        predicate: 'teaches', confidence: 0.9 },
      { ID: LINK_WEAK,   tutorial_ID: TUT_WEAK,   concept_ID: CONCEPT_ID,
        predicate: 'teaches', confidence: 0.1 },
    ]);

    // Flip the flag on. Use UPSERT-style: DELETE + INSERT to keep singleton.
    if (prevSettings) {
      await UPDATE(ChatSettings).set({ searchKgRerankEnabled: true });
    } else {
      await INSERT.into(ChatSettings).entries([
        { ID: CS_ID, enabled: true, searchKgRerankEnabled: true },
      ]);
    }

    // Clear the search-kg-signal in-process cache so the flag flip is
    // picked up on the next request (search-service.js has a 30s cache;
    // reset ensures the first request re-embeds).
    resetSignalCache();
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    const {
      Concepts, Tutorials, TutorialConceptLinks, ChatSettings,
    } = cds.entities('com.sap.developers.ims');

    try { await DELETE.from(TutorialConceptLinks).where({ ID: { in: [LINK_STRONG, LINK_WEAK] } }); } catch (_) {}
    try { await DELETE.from(Tutorials).where({ ID: { in: [TUT_STRONG, TUT_WEAK] } }); } catch (_) {}
    try { await DELETE.from(Concepts).where({ ID: CONCEPT_ID }); } catch (_) {}
    // Belt-and-braces slug sweep.
    try { await DELETE.from(Concepts).where({ slug: { like: `${SLUG_PREFIX}%` } }); } catch (_) {}
    try { await DELETE.from(Tutorials).where({ slug: { like: `${SLUG_PREFIX}%` } }); } catch (_) {}
    // Restore ChatSettings.
    if (prevSettings) {
      try {
        await UPDATE(ChatSettings).set({ searchKgRerankEnabled: !!prevSettings.searchKgRerankEnabled });
      } catch (_) {}
    } else {
      try { await DELETE.from(ChatSettings).where({ ID: CS_ID }); } catch (_) {}
    }
    resetSignalCache();
  }, 30_000);

  it('flag ON — strong-link tutorial ranks above weak-link one; searchScore reflects KG', async () => {
    const search = await cds.connect.to('SearchService');
    const rows = await search.run(
      SELECT.from('SearchService.SearchableItems')
        .columns('slug', 'title', 'searchScore')
        .search(TITLE_TOKEN)
        .limit(10),
    );

    // Both fixtures must be present.
    const strong = rows.find((r) => r.slug === TUT_STRONG_SLUG);
    const weak   = rows.find((r) => r.slug === TUT_WEAK_SLUG);
    expect(strong, `expected ${TUT_STRONG_SLUG} in ${JSON.stringify(rows.map(r => r.slug))}`).toBeDefined();
    expect(weak,   `expected ${TUT_WEAK_SLUG} in ${JSON.stringify(rows.map(r => r.slug))}`).toBeDefined();

    // searchScore is populated on both.
    expect(typeof strong.searchScore).toBe('number');
    expect(typeof weak.searchScore).toBe('number');

    // Both share the same title-match fuzzy contribution (+3). The KG delta
    // is 2.0 * concept_cosine * (0.9 - 0.1) ≈ 1.6 assuming cosine near 1,
    // so strong.searchScore must clear weak.searchScore by a comfortable
    // margin. Use > (not >=) — equal would mean KG didn't apply.
    expect(strong.searchScore).toBeGreaterThan(weak.searchScore);

    // Result order (DB-side ORDER BY _searchRank DESC) must place strong
    // before weak.
    const strongIdx = rows.findIndex((r) => r.slug === TUT_STRONG_SLUG);
    const weakIdx   = rows.findIndex((r) => r.slug === TUT_WEAK_SLUG);
    expect(strongIdx).toBeLessThan(weakIdx);
  }, 60_000);
});
