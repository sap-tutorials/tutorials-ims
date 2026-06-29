import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js';

describe('buildConceptsPayload — discoveryMissions field', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { DiscoveryMissions, DiscoveryMissionConceptLinks } =
      cds.entities('com.sap.developers.ims.external');

    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries([
      { slug: 'cap-handlers', name: 'CAP handlers', description: 'd',
        status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c' },
      { slug: 'no-mission', name: 'No Mission', description: 'd',
        status: 'ACTIVE', publishedAt: now, publishedBy: 'a@b.c' },
    ]);
    const conceptRow = await SELECT.one.from(Concepts).columns('ID').where({ slug: 'cap-handlers' });

    await INSERT.into(DiscoveryMissions).entries([
      { slug: 'dm-3019', title: 'Easy Mission',
        url: 'https://discovery-center.cloud.sap/missiondetail/3019/',
        mcpId: '3019', effortLevel: 1, categorySlug: 'onboard',
        description: 'd' },
      { slug: 'dm-3258', title: 'Harder Mission',
        url: 'https://discovery-center.cloud.sap/missiondetail/3258/',
        mcpId: '3258', effortLevel: 3, categorySlug: 'develop',
        description: 'd' },
    ]);
    const m1 = await SELECT.one.from(DiscoveryMissions).columns('ID').where({ slug: 'dm-3019' });
    const m2 = await SELECT.one.from(DiscoveryMissions).columns('ID').where({ slug: 'dm-3258' });

    await INSERT.into(DiscoveryMissionConceptLinks).entries([
      { mission_ID: m1.ID, concept_ID: conceptRow.ID,
        predicate: 'teaches', confidence: 0.9 },
      { mission_ID: m2.ID, concept_ID: conceptRow.ID,
        predicate: 'teaches', confidence: 0.85 },
    ]);
  });

  afterAll(async () => { await cds.disconnect(); });

  it('every concept has a discoveryMissions array (empty when none)', async () => {
    const payload = await buildConceptsPayload(cds.db);
    for (const c of payload.concepts) {
      expect(Array.isArray(c.discoveryMissions)).toBe(true);
    }
  });

  it('populates discoveryMissions sorted by effortLevel asc', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const ch = payload.concepts.find(c => c.slug === 'cap-handlers');
    expect(ch.discoveryMissions).toHaveLength(2);
    expect(ch.discoveryMissions[0].slug).toBe('dm-3019');  // effortLevel=1 first
    expect(ch.discoveryMissions[0].categorySlug).toBe('onboard');  // raw slug; not yet labelled
  });

  it('returns empty discoveryMissions[] for concepts with no linked missions', async () => {
    const payload = await buildConceptsPayload(cds.db);
    const nm = payload.concepts.find(c => c.slug === 'no-mission');
    expect(nm.discoveryMissions).toEqual([]);
  });
});
