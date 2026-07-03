// test/unit/srv/fetch-community-events-job.test.js
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

let runFetchCommunityEvents;

beforeAll(async () => {
  await cds.deploy([
    path.join(process.cwd(), 'db'),
    path.join(process.cwd(), 'srv'),
  ]).to('sqlite::memory:');
  ({ runFetchCommunityEvents } = await import('../../../srv/jobs/fetch-community-events-job.js'));
});

afterAll(async () => {
  await cds.disconnect();
});

beforeEach(async () => {
  const { Concepts } = cds.entities('com.sap.developers.ims');
  const { CommunityEvents, CommunityEventConceptLinks } = cds.entities('com.sap.developers.ims.external');
  await DELETE.from(CommunityEventConceptLinks);
  await DELETE.from(CommunityEvents);
  await DELETE.from(Concepts);
});

async function seedOne() {
  const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
  await INSERT.into(CommunityEvents).entries({
    slug: 'ce-seed-1',
    eventType: 'codejam',
    source: 'khoros',
    title: 'Seeded row',
    description: 'For MAX-or-abort bypass tests',
    url: 'https://example',
    sourceId: 'seed/1',
    startDate: '2027-01-01',
    contentHash: 'abc',
    lastSeenAt: new Date(),
  });
}

describe('runFetchCommunityEvents', () => {
  it('MAX-or-abort gate: refuses to run on empty CommunityEvents without override', async () => {
    const summary = await runFetchCommunityEvents(null, {
      fetchAllEvents: async () => ({ rows: [{ id: 'codejam/1', type: 'codejam', title: 'x', date: '2027-01-01', location: '', scope: 'local', url: 'https://x' }], perSource: {} }),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      embed: async () => new Float32Array(1536),
    });
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.fetched).toBe(0);
  });

  it('bypasses MAX-or-abort with manualTrigger:true', async () => {
    const summary = await runFetchCommunityEvents(null, {
      manualTrigger: true,
      budgetOverride: 0,
      fetchAllEvents: async () => ({ rows: [], perSource: { khoros: { rowsFetched: 0, fetcherRejected: false, reason: null }, rss: { rowsFetched: 0, fetcherRejected: false, reason: null } } }),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      embed: async () => new Float32Array(1536),
    });
    expect(summary.errors).toBe(0);
  });

  it('upserts one row per fetched event with ce-<slug> slug', async () => {
    await seedOne();
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    await runFetchCommunityEvents(null, {
      manualTrigger: true,
      budgetOverride: 0,   // extraction skipped; upsert still runs
      fetchAllEvents: async () => ({
        rows: [{ id: 'codejam/new', type: 'codejam', title: 'New CodeJam', date: '2027-06-01', end_date: '2027-06-01', location: 'Munich', scope: 'local', url: 'https://x', _source: 'khoros' }],
        perSource: { khoros: { rowsFetched: 1, fetcherRejected: false, reason: null }, rss: { rowsFetched: 0, fetcherRejected: false, reason: null } },
      }),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      embed: async () => new Float32Array(1536),
    });
    const row = await SELECT.one.from(CommunityEvents).columns('slug', 'eventType').where({ sourceId: 'codejam/new' });
    expect(row?.slug).toBe('ce-codejam-new');
    expect(row?.eventType).toBe('codejam');
  });

  it('#708 crash-safety: skips extract when contentHash === lastExtractedHash', async () => {
    // Seed a row with lastExtractedHash === contentHash. Cron must NOT re-extract.
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(CommunityEvents).entries({
      slug: 'ce-codejam-stable',
      eventType: 'codejam',
      source: 'khoros',
      title: 'Stable',
      description: 'x',
      url: 'https://x',
      sourceId: 'codejam/stable',
      startDate: '2027-01-01',
      contentHash: 'same',
      lastExtractedHash: 'same',
      lastSeenAt: new Date(),
    });
    let extractCalls = 0;
    await runFetchCommunityEvents(null, {
      manualTrigger: true,
      budgetOverride: 100,
      fetchAllEvents: async () => ({
        rows: [{ id: 'codejam/stable', type: 'codejam', title: 'Stable', date: '2027-01-01', location: '', scope: 'local', url: 'https://x' }],
        perSource: {},
      }),
      extractFn: async () => { extractCalls++; return { concepts: [], promptTokens: 0, completionTokens: 0 }; },
      embed: async () => new Float32Array(1536),
      // Force contentHash to match seeded 'same'
      hashOverride: () => 'same',
    });
    expect(extractCalls).toBe(0);
  });

  it('synthesizes description when upstream provides none', async () => {
    const { CommunityEvents } = cds.entities('com.sap.developers.ims.external');
    await runFetchCommunityEvents(null, {
      manualTrigger: true,
      budgetOverride: 0,
      fetchAllEvents: async () => ({
        rows: [{ id: 'codejam/syn', type: 'codejam', title: 'Bengaluru CodeJam', date: '2027-07-01', location: 'Bengaluru', scope: 'local', url: 'https://x' }],
        perSource: {},
      }),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      embed: async () => new Float32Array(1536),
    });
    const row = await SELECT.one.from(CommunityEvents).columns('description').where({ sourceId: 'codejam/syn' });
    expect(row.description).toContain('hands-on codejam');
    expect(row.description).toContain('Bengaluru');
    expect(row.description).toContain('2027-07-01');
  });

  it('respects budget cap on extractions', async () => {
    let extractCalls = 0;
    await runFetchCommunityEvents(null, {
      manualTrigger: true,
      budgetOverride: 2,
      fetchAllEvents: async () => ({
        rows: Array.from({ length: 5 }, (_, i) => ({ id: `codejam/b${i}`, type: 'codejam', title: `E${i}`, date: '2027-08-01', location: '', scope: 'local', url: `https://x/${i}` })),
        perSource: {},
      }),
      extractFn: async () => { extractCalls++; return { concepts: [], promptTokens: 0, completionTokens: 0 }; },
      embed: async () => new Float32Array(1536),
    });
    expect(extractCalls).toBeLessThanOrEqual(2);
  });

  it('emits per-source summary in log line', async () => {
    const logs = [];
    const origInfo = cds.log('fetch-community-events').info;
    cds.log('fetch-community-events').info = (msg) => logs.push(msg);
    try {
      await runFetchCommunityEvents(null, {
        manualTrigger: true,
        budgetOverride: 0,
        fetchAllEvents: async () => ({ rows: [], perSource: { khoros: { rowsFetched: 3, fetcherRejected: false, reason: null }, rss: { rowsFetched: 2, fetcherRejected: false, reason: null } } }),
        extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
        embed: async () => new Float32Array(1536),
      });
    } finally {
      cds.log('fetch-community-events').info = origInfo;
    }
    const flat = logs.join('\n');
    expect(flat).toContain('perSource');
    expect(flat).toContain('khoros');
    expect(flat).toContain('rss');
  });
});
