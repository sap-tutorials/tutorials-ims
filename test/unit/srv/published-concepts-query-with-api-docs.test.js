// test/unit/srv/published-concepts-query-with-api-docs.test.js
//
// Phase 4.5 (#746): assert /build/concepts payload includes apiDocs[] per
// concept. Mirrors test/unit/srv/published-concepts-query-with-videos.test.js
// for the LOB-locator safety pattern.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js';

describe('buildConceptsPayload — apiDocs field (Phase 4.5)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { ApiDocs, ApiDocConceptLinks } =
      cds.entities('com.sap.developers.ims.external');

    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries([
      { slug: 'multi', name: 'Multi-doc', description: 'd',
        status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c' },
      { slug: 'lonely', name: 'No doc', description: 'd',
        status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c' },
    ]);
    const multi = await SELECT.one.from(Concepts).columns('ID').where({ slug: 'multi' });

    await INSERT.into(ApiDocs).entries([
      { slug: 'ad-alpha', title: 'Alpha', description: '...',
        url: 'https://api.sap.com/a', sourceId: 'A', contentHash: 'h',
        firstSeenAt: now, lastSeenAt: now,
        category: 'BTP', apiType: 'rest' },
      { slug: 'ad-bravo', title: 'Bravo', description: '...',
        url: 'https://api.sap.com/b', sourceId: 'B', contentHash: 'h',
        firstSeenAt: now, lastSeenAt: now,
        category: 'CAP', apiType: 'reference' },
    ]);
    const a = await SELECT.one.from(ApiDocs).columns('ID').where({ slug: 'ad-alpha' });
    const b = await SELECT.one.from(ApiDocs).columns('ID').where({ slug: 'ad-bravo' });

    await INSERT.into(ApiDocConceptLinks).entries([
      { apiDoc_ID: a.ID, concept_ID: multi.ID,
        predicate: 'officialReferenceFor', confidence: 0.9 },
      { apiDoc_ID: b.ID, concept_ID: multi.ID,
        predicate: 'officialReferenceFor', confidence: 0.9 },
    ]);
  });

  afterAll(async () => { await cds.disconnect(); });

  it('every concept has an apiDocs array (empty when no links)', async () => {
    const payload = await buildConceptsPayload(cds.db);
    for (const c of payload.concepts) {
      expect(Array.isArray(c.apiDocs)).toBe(true);
    }
    const lonely = payload.concepts.find(c => c.slug === 'lonely');
    expect(lonely.apiDocs).toEqual([]);
  });

  it('populates apiDocs[] sorted by category asc, title asc', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const multi = payload.concepts.find(c => c.slug === 'multi');
    expect(multi.apiDocs).toHaveLength(2);
    // category 'BTP' < 'CAP' alphabetically.
    expect(multi.apiDocs[0].slug).toBe('ad-alpha');
    expect(multi.apiDocs[1].slug).toBe('ad-bravo');
    expect(multi.apiDocs[0]).toMatchObject({
      slug: 'ad-alpha', title: 'Alpha', category: 'BTP', apiType: 'rest',
    });
  });

  it('does NOT pull description (LOB-locator safety)', async () => {
    const payload = await buildConceptsPayload(cds.db);
    for (const c of payload.concepts) {
      for (const ad of c.apiDocs ?? []) {
        expect(ad).not.toHaveProperty('description');
      }
    }
  });
});
