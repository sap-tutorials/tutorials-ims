// test/unit/srv/published-concepts-query-with-samples.test.js
//
// Phase 4.6 (#747): assert /build/concepts payload includes samples[] per
// concept. Mirrors published-concepts-query-with-api-docs.test.js for the
// LOB-locator safety pattern (LargeString description omitted from SELECT).

import { describe, it, beforeAll, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js';

describe('buildConceptsPayload — samples field (Phase 4.6)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  it('every concept has a samples array (empty when no links)', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const now = new Date().toISOString();
    await DELETE.from(Concepts);
    await INSERT.into(Concepts).entries({
      slug: 'lonely', name: 'Lonely', description: 'd',
      status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c',
    });
    const payload = await buildConceptsPayload(cds.db);
    for (const c of payload.concepts) {
      expect(Array.isArray(c.samples)).toBe(true);
    }
    const lonely = payload.concepts.find(c => c.slug === 'lonely');
    expect(lonely.samples).toEqual([]);
  });

  it('populates samples[] sorted by stars desc then lastCommitAt desc', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { Samples, SampleConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    const now = new Date().toISOString();
    await DELETE.from(SampleConceptLinks);
    await DELETE.from(Samples);
    await DELETE.from(Concepts);

    await INSERT.into(Concepts).entries({
      slug: 'multi', name: 'Multi', description: 'd',
      status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c',
    });
    const multi = await SELECT.one.from(Concepts).columns('ID').where({ slug: 'multi' });

    await INSERT.into(Samples).entries([
      { slug: 'sa-low-stars', title: 'Low', description: 'x', url: 'https://github.com/x/a',
        sourceId: 'x/a', contentHash: 'h', firstSeenAt: now, lastSeenAt: now,
        language: 'X', stars: 10, lastCommitAt: '2026-06-01T00:00:00Z' },
      { slug: 'sa-high-stars', title: 'High', description: 'x', url: 'https://github.com/x/b',
        sourceId: 'x/b', contentHash: 'h', firstSeenAt: now, lastSeenAt: now,
        language: 'X', stars: 100, lastCommitAt: '2026-01-01T00:00:00Z' },
    ]);
    const lo = await SELECT.one.from(Samples).columns('ID').where({ slug: 'sa-low-stars' });
    const hi = await SELECT.one.from(Samples).columns('ID').where({ slug: 'sa-high-stars' });

    await INSERT.into(SampleConceptLinks).entries([
      { sample_ID: lo.ID, concept_ID: multi.ID, predicate: 'embodies', confidence: 0.9, extractedAt: now },
      { sample_ID: hi.ID, concept_ID: multi.ID, predicate: 'embodies', confidence: 0.9, extractedAt: now },
    ]);

    const payload = await buildConceptsPayload(cds.db);
    const multiConcept = payload.concepts.find(c => c.slug === 'multi');
    expect(multiConcept.samples).toHaveLength(2);
    expect(multiConcept.samples[0].slug).toBe('sa-high-stars');    // 100 stars wins
    expect(multiConcept.samples[1].slug).toBe('sa-low-stars');
  });

  it('does NOT pull description (LOB-locator safety)', async () => {
    const payload = await buildConceptsPayload(cds.db);
    for (const c of payload.concepts) {
      for (const s of c.samples ?? []) {
        expect(s).not.toHaveProperty('description');
      }
    }
  });
});
