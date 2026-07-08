// test/unit/refresh-community-events-job.test.js
// #1030 — refresh cron is upsert-only; no LLM cost.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { runRefreshCommunityEvents } from '../../srv/jobs/refresh-community-events-job.js';

const NAMESPACE_EXT = 'com.sap.developers.ims.external';

// cds.test bootstraps an in-memory SQLite that reflects db/*.cds.
const { test } = cds;
test.in(__dirname, '..', '..');
test('serve', 'all', '--in-memory');

async function seedRow(overrides = {}) {
  const db = await cds.connect.to('db');
  const { CommunityEvents } = cds.entities(NAMESPACE_EXT);
  const row = {
    ID: cds.utils.uuid(),
    slug: 'ce-codejam-existing',
    eventType: 'codejam',
    source: 'khoros',
    title: 'Existing',
    url: 'https://example.com/existing',
    sourceId: 'codejam/existing',
    location: 'Berlin, Germany',
    scope: 'local',
    virtualOrInPerson: 'in-person',
    region: 'EMEA',
    startDate: '2027-01-01',
    endDate: '2027-01-01',
    contentHash: 'HASH-preserved',
    lastExtractedHash: 'HASH-preserved',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    ...overrides,
  };
  await INSERT.into(CommunityEvents).entries(row);
  return row;
}

function fakeFetcher(rows, opts = {}) {
  return async () => ({
    rows,
    perSource: {
      khoros: { rowsFetched: rows.filter(r => r._source === 'khoros').length, fetcherRejected: false, reason: null },
      rss:    { rowsFetched: rows.filter(r => r._source === 'rss').length,    fetcherRejected: false, reason: null },
      ...opts,
    },
  });
}

describe('runRefreshCommunityEvents', () => {
  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NAMESPACE_EXT);
    await DELETE.from(CommunityEvents);
  });

  it('inserts new rows with derived region', async () => {
    const summary = await runRefreshCommunityEvents('t1', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/new-1',
          type: 'codejam',
          _source: 'khoros',
          title: 'CAP CodeJam Bengaluru',
          url: 'https://example.com/1',
          location: 'Bengaluru, India',
          scope: 'local',
          date: '2027-05-15',
          end_date: '2027-05-15',
        },
      ]),
    });
    expect(summary.fetched).toBe(1);
    expect(summary.upserted).toBe(1);
    expect(summary.errors).toBe(0);
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NAMESPACE_EXT);
    const row = await SELECT.one.from(CommunityEvents).where({ slug: 'ce-codejam-new-1' });
    expect(row.region).toBe('APJ');
  });

  it('updates existing rows but does NOT touch contentHash/lastExtractedHash', async () => {
    const seed = await seedRow();
    await runRefreshCommunityEvents('t2', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/existing',
          type: 'codejam',
          _source: 'khoros',
          title: 'Existing (updated title)',
          url: 'https://example.com/existing',
          location: 'Berlin, Germany',
          scope: 'local',
          date: '2027-01-01',
          end_date: '2027-01-01',
        },
      ]),
    });
    const db = await cds.connect.to('db');
    const { CommunityEvents } = cds.entities(NAMESPACE_EXT);
    const row = await SELECT.one.from(CommunityEvents).where({ slug: 'ce-codejam-existing' });
    expect(row.title).toBe('Existing (updated title)');
    // Critical: the extraction-owned columns are untouched.
    expect(row.contentHash).toBe('HASH-preserved');
    expect(row.lastExtractedHash).toBe('HASH-preserved');
  });

  it('counts region_unknown for parser misses', async () => {
    const summary = await runRefreshCommunityEvents('t3', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/mystery',
          type: 'codejam',
          _source: 'khoros',
          title: 'Mystery event',
          url: 'https://example.com/x',
          location: 'Somewhere Unmapped',
          scope: 'local',
          date: '2027-06-01',
        },
      ]),
    });
    expect(summary.unknownRegion).toBe(1);
  });

  it('does NOT count region_unknown for virtual events', async () => {
    const summary = await runRefreshCommunityEvents('t4', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/virtual',
          type: 'codejam',
          _source: 'khoros',
          title: 'Virtual CodeJam',
          url: 'https://example.com/v',
          location: 'virtual',
          scope: 'virtual',
          date: '2027-06-01',
        },
      ]),
    });
    expect(summary.unknownRegion).toBe(0);
  });

  it('returns non-fatally when the fetcher throws', async () => {
    const summary = await runRefreshCommunityEvents('t5', {
      fetchAllEvents: async () => { throw new Error('Khoros unreachable'); },
    });
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.fetched).toBe(0);
  });

  it('per-row error does not halt the loop', async () => {
    // Construct a row that will cause an UPDATE failure by targeting a
    // duplicate slug on INSERT — one row succeeds, one errors.
    await seedRow({ slug: 'ce-codejam-one' });
    const summary = await runRefreshCommunityEvents('t6', {
      fetchAllEvents: fakeFetcher([
        {
          id: 'codejam/one', type: 'codejam', _source: 'khoros',
          title: 'One (update)', url: 'https://x/1', location: 'Paris, France',
          scope: 'local', date: '2027-07-01',
        },
        {
          id: 'codejam/two', type: 'codejam', _source: 'khoros',
          title: 'Two', url: 'https://x/2', location: 'Tokyo, Japan',
          scope: 'local', date: '2027-07-02',
        },
      ]),
    });
    expect(summary.fetched).toBe(2);
    expect(summary.upserted).toBe(2);
  });
});
