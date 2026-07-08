// test/hybrid/homepage-events-hybrid.test.js
// #1030 — Real HANA: 30-row fixture across regions × virtual × past/future.
//
// Run via:  npm run test:hybrid -- --project hybrid
// Skips locally unless cds bind has set up real HANA credentials.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS_EXT = 'com.sap.developers.ims.external';
const TAG = 'hybrid-1030';

describe.runIf(isSafeForWrites())('homepage events auto-pull (hybrid)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NS_EXT);
    // Clean up fixture rows from previous runs, if any.
    await DELETE.from(CommunityEvents).where`slug like ${'ce-' + TAG + '%'}`;

    const fixtures = [];
    let n = 0;
    for (const region of ['AMERICAS', 'EMEA', 'APJ']) {
      for (const virt of ['in-person', 'in-person', 'virtual']) {
        for (const day of ['2027-01-01', '2027-06-01']) {
          fixtures.push({
            ID: cds.utils.uuid(),
            slug: `ce-${TAG}-${n++}`,
            eventType: n % 2 === 0 ? 'codejam' : 'devtoberfest',
            source: 'khoros',
            title: `Hybrid fixture ${n}`,
            url: `https://example.com/${n}`,
            sourceId: `${TAG}/${n}`,
            location: region === 'AMERICAS' ? 'Toronto' : region === 'EMEA' ? 'Berlin' : 'Tokyo',
            scope: 'local',
            virtualOrInPerson: virt,
            region: virt === 'virtual' ? 'UNKNOWN' : region,
            startDate: day,
            endDate: day,
            lastSeenAt: new Date(),
            firstSeenAt: new Date(),
          });
        }
      }
    }
    const { CommunityEvents: CE } = cds.entities(NS_EXT);
    await INSERT.into(CE).entries(fixtures);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    const { CommunityEvents } = cds.entities(NS_EXT);
    await DELETE.from(CommunityEvents).where`slug like ${'ce-' + TAG + '%'}`;
  }, 60_000);

  it('region=EMEA returns EMEA-or-virtual rows', async () => {
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'EMEA' });
    for (const r of rows) {
      expect(r.region === 'EMEA' || r.isVirtual).toBe(true);
    }
  });

  it('region=VIRTUAL returns only virtual rows', async () => {
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'VIRTUAL' });
    for (const r of rows) expect(r.isVirtual).toBe(true);
  });

  it('caps at 6 rows even when fixture has >6 matches', async () => {
    const svc = await cds.connect.to('HomepageService');
    const rows = await svc.send('events', { region: 'ALL' });
    expect(rows.length).toBeLessThanOrEqual(6);
  });
});
