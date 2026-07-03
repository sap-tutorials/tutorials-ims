// test/unit/srv/community-event-payload.test.js
//
// Phase 4.8 (#765): unit coverage for the communityEvents[] extension in
// /build/concepts (via buildConceptsPayload). Covers cap 5, sort by
// startDate ASC, virtual sentinel passthrough, and TTL prune.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { buildConceptsPayload } from '../../../srv/lib/published-concepts-query.js';

const CID = '00000000-0000-4000-8000-000000000765';

async function seedConceptAndEvents(events) {
  const { Concepts } = cds.entities('com.sap.developers.ims');
  const { CommunityEvents, CommunityEventConceptLinks } = cds.entities('com.sap.developers.ims.external');
  // Publish the concept so /build/concepts picks it up.
  await INSERT.into(Concepts).entries({
    ID: CID,
    slug: 'phase48-payload',
    name: 'Phase 4.8 Payload',
    description: 'x',
    status: 'ACTIVE',
    publishedAt: new Date(),
  });
  for (const e of events) {
    await INSERT.into(CommunityEvents).entries(e);
    const row = await SELECT.one.from(CommunityEvents).columns('ID').where({ slug: e.slug });
    await INSERT.into(CommunityEventConceptLinks).entries({
      event_ID: row.ID,
      concept_ID: CID,
      predicate: 'covers',
      confidence: 0.9,
      snippet: `snip-${e.slug}`,
      extractedAt: new Date(),
      modelVersion: 'test',
    });
  }
}

function mkEvent(slug, startIso, opts = {}) {
  return {
    slug,
    eventType: 'codejam',
    source: 'khoros',
    title: `T-${slug}`,
    description: 'ok',
    url: `https://x/${slug}`,
    sourceId: `codejam/${slug}`,
    location: opts.location ?? 'Munich',
    scope: 'local',
    virtualOrInPerson: opts.virtualOrInPerson ?? 'in-person',
    startDate: startIso,
    endDate: opts.endDate ?? startIso,
    contentHash: `h-${slug}`,
    lastSeenAt: new Date(),
  };
}

describe('buildConceptsPayload — communityEvents[]', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');
  });

  afterAll(async () => { await cds.disconnect(); });

  beforeEach(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { CommunityEvents, CommunityEventConceptLinks } = cds.entities('com.sap.developers.ims.external');
    await DELETE.from(CommunityEventConceptLinks);
    await DELETE.from(CommunityEvents);
    await DELETE.from(Concepts);
  });

  it('caps at 5 events per concept', async () => {
    const now = Date.now();
    const events = Array.from({ length: 8 }, (_, i) => mkEvent(
      `ce-cap-${i}`,
      new Date(now + (10 + i) * 86400000).toISOString().slice(0, 10),
    ));
    await seedConceptAndEvents(events);
    const { concepts } = await buildConceptsPayload(cds.db);
    const c = concepts.find(x => x.slug === 'phase48-payload');
    expect(c).toBeDefined();
    expect(c.communityEvents.length).toBe(5);
  });

  it('sorts by startDate ASC', async () => {
    const now = Date.now();
    const events = [
      mkEvent('ce-c', new Date(now + 30 * 86400000).toISOString().slice(0, 10)),
      mkEvent('ce-a', new Date(now + 10 * 86400000).toISOString().slice(0, 10)),
      mkEvent('ce-b', new Date(now + 20 * 86400000).toISOString().slice(0, 10)),
    ];
    await seedConceptAndEvents(events);
    const { concepts } = await buildConceptsPayload(cds.db);
    const c = concepts.find(x => x.slug === 'phase48-payload');
    expect(c.communityEvents.map(e => e.slug)).toEqual(['ce-a', 'ce-b', 'ce-c']);
  });

  it('preserves virtualOrInPerson sentinel on the wire', async () => {
    const iso = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
    await seedConceptAndEvents([mkEvent('ce-v1', iso, { virtualOrInPerson: 'virtual', location: 'virtual' })]);
    const { concepts } = await buildConceptsPayload(cds.db);
    const c = concepts.find(x => x.slug === 'phase48-payload');
    expect(c.communityEvents[0].virtualOrInPerson).toBe('virtual');
  });

  it('prunes events past endDate + 30d grace', async () => {
    const pastIso = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    await seedConceptAndEvents([mkEvent('ce-past', pastIso, { endDate: pastIso })]);
    const { concepts } = await buildConceptsPayload(cds.db);
    const c = concepts.find(x => x.slug === 'phase48-payload');
    expect(c.communityEvents.length).toBe(0);
  });
});
