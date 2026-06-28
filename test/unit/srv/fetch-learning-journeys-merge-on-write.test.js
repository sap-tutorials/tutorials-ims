// test/unit/srv/fetch-learning-journeys-merge-on-write.test.js
//
// #707: integration test for the journey cron's merge-on-write path.
//
// Drives runFetchLearningJourneys against an in-memory SQLite with:
//   - one ACTIVE concept (with embedding) already in the registry
//   - a mock MCP transport returning two journeys
//   - a mock LLM returning covers including BOTH a known slug AND a
//     novel slug (one that should merge into the existing concept, one
//     that should mint fresh)
//   - a mock embed function returning vectors that produce the desired
//     cosine results
//
// Assertions:
//   1. The known slug produces a covers link via `action: 'exact'`.
//   2. The near-duplicate novel slug merges into the existing concept
//      (no new Concept row; summary.mergedAtExtract === 1).
//   3. The truly novel slug mints a NEW Concept row + cover link
//      (summary.mintedAtExtract === 1).
//   4. The legacy `skippedUnknownConcept` counter is GONE from summary.
//   5. The new `skippedNoEmbed` counter exists and reads 0.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

// We import the cron module dynamically AFTER the schema is deployed so the
// module's cds.entities() calls bind against our in-memory tables.
let runFetchLearningJourneys;
let _setMockTransport;
let _resetCache;

function vec(...nums) {
  const f = new Float32Array(nums);
  return f;
}

function buf(...nums) {
  const f = vec(...nums);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

describe('fetch-learning-journeys-job — merge-on-write (#707)', () => {
  beforeAll(async () => {
    const schemaRoots = [
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ];
    await cds.deploy(schemaRoots).to('sqlite::memory:');

    ({ runFetchLearningJourneys } = await import(
      '../../../srv/jobs/fetch-learning-journeys-job.js'
    ));
    ({ _setMockTransport, _resetCache } = await import(
      '../../../srv/lib/sap-devs-client.js'
    ));
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    // Reset DB to a known state for each test.
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { LearningJourneys, LearningJourneyConceptLinks, LearningJourneyPrerequisites } =
      cds.entities('com.sap.developers.ims.external');
    await DELETE.from(LearningJourneyPrerequisites);
    await DELETE.from(LearningJourneyConceptLinks);
    await DELETE.from(LearningJourneys);
    await DELETE.from(Concepts);

    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries({
      slug: 'cap-handlers',
      name: 'CAP handlers',
      description: 'desc',
      embedding: buf(1, 0, 0, 0),
      status: 'ACTIVE',
      publishedAt: now,
      publishedBy: 'admin@sap.com',
    });

    _resetCache();
  });

  it('exact-matches known slugs, merges near-dup novel slugs, mints truly novel slugs', async () => {
    // Mock MCP: one journey.
    _setMockTransport({
      async call(toolName, _args) {
        if (toolName === 'search_learning_journeys') {
          return {
            results: [{
              slug: 'cap-quickstart',
              title: 'CAP Quickstart',
              level: 'INTERMEDIATE',
              duration: '6',
              url: 'https://learning.sap.com/learning-journeys/cap-quickstart',
            }],
          };
        }
        throw new Error(`unmocked: ${toolName}`);
      },
    });

    // Inject the extract function so the test fully controls covers.
    const extractFn = vi.fn().mockResolvedValue({
      covers: [
        { slug: 'cap-handlers', name: 'CAP handlers', confidence: 0.9 },
        { slug: 'cap-event-handlers', name: 'CAP event handlers', confidence: 0.85 },
        { slug: 'odata-v4', name: 'OData v4', confidence: 0.8 },
      ],
      journeyPrerequisites: [],
      tokenUsage: { prompt: 100, completion: 50 },
    });

    // Mock embed: near-dup vector for 'cap-event-handlers' (cos > 0.85
    // vs the existing 'cap-handlers' embedding [1,0,0,0]); orthogonal
    // for 'odata-v4'.
    const embed = vi.fn(async ([name]) => {
      if (name === 'CAP event handlers') return [vec(0.99, 0.01, 0, 0)];
      if (name === 'OData v4') return [vec(0, 0, 1, 0)];
      throw new Error(`unexpected embed input: ${name}`);
    });

    const summary = await runFetchLearningJourneys({ embed, extractFn });

    // Counter assertions.
    expect(summary.mergedAtExtract).toBe(1);  // cap-event-handlers merged
    expect(summary.mintedAtExtract).toBe(1);  // odata-v4 minted
    expect(summary.skippedNoEmbed).toBe(0);
    // 3 covers RESOLVED, but two of them (cap-handlers exact + cap-event-handlers
    // merged) point at the SAME concept_ID. The @assert.unique.journeyConcept
    // constraint requires dedup → 2 unique link rows written.
    expect(summary.coversWritten).toBe(2);
    expect(summary).not.toHaveProperty('skippedUnknownConcept');

    // DB shape assertions.
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { LearningJourneyConceptLinks } = cds.entities('com.sap.developers.ims.external');

    const allConcepts = await SELECT.from(Concepts).columns('slug', 'name');
    const conceptSlugs = allConcepts.map((c) => c.slug).sort();
    // 'cap-handlers' is the seed; 'odata-v4' is newly minted;
    // 'cap-event-handlers' merged INTO cap-handlers (no fresh row).
    expect(conceptSlugs).toEqual(['cap-handlers', 'odata-v4']);

    const links = await SELECT.from(LearningJourneyConceptLinks).columns('concept_ID', 'predicate');
    expect(links).toHaveLength(2);
    // Both link rows point at the predicate 'covers'.
    expect(links.every((l) => l.predicate === 'covers')).toBe(true);
    // 2 distinct concept IDs referenced: cap-handlers (one row covering both
    // the exact slug AND the merged near-dup) + odata-v4.
    const uniqueConceptIds = new Set(links.map((l) => l.concept_ID));
    expect(uniqueConceptIds.size).toBe(2);
  });

  it('skipped-no-embed counter increments when embed fails for a novel slug', async () => {
    _setMockTransport({
      async call(toolName, _args) {
        if (toolName === 'search_learning_journeys') {
          return {
            results: [{
              slug: 'flaky-journey',
              title: 'Flaky',
              level: 'beginner',
              duration: '2',
              url: 'https://learning.sap.com/learning-journeys/flaky-journey',
            }],
          };
        }
        throw new Error(`unmocked: ${toolName}`);
      },
    });

    const extractFn = vi.fn().mockResolvedValue({
      covers: [{ slug: 'novel-only', name: 'Novel only', confidence: 0.9 }],
      journeyPrerequisites: [],
      tokenUsage: { prompt: 50, completion: 25 },
    });

    const embed = vi.fn().mockRejectedValue(new Error('quota exceeded'));

    const summary = await runFetchLearningJourneys({ embed, extractFn });

    expect(summary.skippedNoEmbed).toBe(1);
    expect(summary.mergedAtExtract).toBe(0);
    expect(summary.mintedAtExtract).toBe(0);
    expect(summary.coversWritten).toBe(0);  // no cover row written
  });
});
