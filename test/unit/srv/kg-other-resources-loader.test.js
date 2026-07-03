// test/unit/srv/kg-other-resources-loader.test.js
//
// Phase 4.8 (#765): unit coverage for the 8th corpus (community-event) in
// loadOtherResourcesByType. Deploys the CDS model in-memory, seeds a
// concept + one CommunityEvent + one link, and verifies the wire shape
// returned by the loader (metaText, TTL gate, `type: 'community-event'`).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { loadOtherResourcesByType, buildEventMetaText } from '../../../srv/lib/kg-other-resources-loader.js';

const CONCEPT_ID = '00000000-0000-4000-8000-000000000042';

async function seedConceptAndEvent({ event }) {
  const { Concepts } = cds.entities('com.sap.developers.ims');
  const { CommunityEvents, CommunityEventConceptLinks } = cds.entities('com.sap.developers.ims.external');

  await INSERT.into(Concepts).entries({
    ID: CONCEPT_ID,
    slug: 'test-concept',
    name: 'Test Concept',
    description: '',
    status: 'ACTIVE',
  });
  const inserted = await INSERT.into(CommunityEvents).entries(event);
  const evRow = await SELECT.one.from(CommunityEvents).columns('ID').where({ slug: event.slug });
  await INSERT.into(CommunityEventConceptLinks).entries({
    event_ID: evRow.ID,
    concept_ID: CONCEPT_ID,
    predicate: 'covers',
    confidence: 0.9,
    snippet: 'test snippet',
    extractedAt: new Date(),
    modelVersion: 'test',
  });
  return evRow.ID;
}

describe('kg-other-resources-loader — community-event corpus', () => {
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

  it('includes community-event items with overlapCount and metaText', async () => {
    const now = new Date();
    const futureIso = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    await seedConceptAndEvent({
      event: {
        slug: 'ce-codejam-x1',
        eventType: 'codejam',
        source: 'khoros',
        title: 'X1',
        description: 'ok',
        url: 'https://x',
        sourceId: 'codejam/x1',
        location: 'Munich',
        scope: 'local',
        virtualOrInPerson: 'in-person',
        startDate: futureIso,
        endDate: futureIso,
        contentHash: 'h',
        lastSeenAt: now,
      },
    });
    const byType = await loadOtherResourcesByType(cds, [CONCEPT_ID], 5);
    const rows = byType.get('community-event') ?? [];
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.type).toBe('community-event');
    expect(r.slug).toBe('ce-codejam-x1');
    expect(r.overlapCount).toBe(1);
    expect(r.metaText).toContain('Munich');
    expect(r.metaText).toContain(futureIso);
  });

  it('filters community-event items past endDate + 30d grace', async () => {
    const now = new Date();
    const pastIso = new Date(now.getTime() - 45 * 86400000).toISOString().slice(0, 10);
    await seedConceptAndEvent({
      event: {
        slug: 'ce-codejam-old',
        eventType: 'codejam',
        source: 'khoros',
        title: 'Old',
        description: 'x',
        url: 'https://x',
        sourceId: 'codejam/old',
        location: 'Berlin',
        scope: 'local',
        virtualOrInPerson: 'in-person',
        startDate: pastIso,
        endDate: pastIso,
        contentHash: 'h2',
        lastSeenAt: now,
      },
    });
    const byType = await loadOtherResourcesByType(cds, [CONCEPT_ID], 5);
    const rows = byType.get('community-event') ?? [];
    expect(rows.length).toBe(0);
  });

  it('buildEventMetaText marks virtual events with 🌐', () => {
    const t = buildEventMetaText({ location: 'Anywhere', startDate: '2027-05-05', virtualOrInPerson: 'virtual' });
    expect(t).toContain('🌐');
  });

  it('buildEventMetaText renders "Location TBD" when location is missing', () => {
    const t = buildEventMetaText({ startDate: '2027-05-05' });
    expect(t.startsWith('Location TBD')).toBe(true);
  });
});
