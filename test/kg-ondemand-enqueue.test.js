import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';
import { enqueueOnDemandExtraction, normalizeQuery } from '../srv/lib/kg/on-demand-enqueue.js';
import { _resetForTests as _resetRateLimits } from '../srv/lib/per-user-rate-limit.js';
import { _resetCacheForTests as _resetSettingsCache } from '../srv/lib/runtime-config/kg-settings.js';
import * as kgSettings from '../srv/lib/runtime-config/kg-settings.js';

const NS = 'com.sap.developers.ims';

async function enableFlag(on) {
  const { KnowledgeGraphSettings } = cds.entities(NS);
  await DELETE.from(KnowledgeGraphSettings);
  await INSERT.into(KnowledgeGraphSettings).entries({ enabled: true, onDemandExtractionEnabled: on });
  _resetSettingsCache();
}

describe('normalizeQuery', () => {
  it('lowercases, collapses whitespace, strips punctuation', () => {
    expect(normalizeQuery('CAP  Tutorial!')).toBe('cap tutorial');
    expect(normalizeQuery('  hello,  WORLD?? ')).toBe('hello world');
    expect(normalizeQuery('foo___bar')).toBe('foo___bar'); // underscores preserved (\w)
  });

  it('returns empty for pure punctuation input', () => {
    expect(normalizeQuery('!!!')).toBe('');
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('enqueueOnDemandExtraction (#948)', () => {
  let db;

  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    const { KgOnDemandRequests } = cds.entities(NS);
    await DELETE.from(KgOnDemandRequests);
    _resetRateLimits();
    delete process.env.KG_ONDEMAND_USER_MAX_PER_HOUR;
    delete process.env.KG_ONDEMAND_GLOBAL_MAX_PER_HOUR;
  });

  it('returns disabled and does NOT insert when flag is off', async () => {
    await enableFlag(false);
    const r = await enqueueOnDemandExtraction({
      db, query: 'test query',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r.status).toBe('disabled');
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests);
    expect(rows).toHaveLength(0);
  });

  it('inserts a PENDING row when flag is on and budget is available', async () => {
    await enableFlag(true);
    const r = await enqueueOnDemandExtraction({
      db, query: 'CAP tutorial',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r.status).toBe('enqueued');
    expect(r.normalizedKey).toBe('cap tutorial');
    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'query', 'normalizedKey', 'requestedBy', 'requestedByKind');
    expect(row.status).toBe('PENDING');
    expect(row.query).toBe('CAP tutorial');
    expect(row.normalizedKey).toBe('cap tutorial');
    expect(row.requestedBy).toBe('u1');
    expect(row.requestedByKind).toBe('user');
  });

  it('returns invalid for empty normalized query', async () => {
    await enableFlag(true);
    const r = await enqueueOnDemandExtraction({
      db, query: '!!!',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r.status).toBe('invalid');
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests);
    expect(rows).toHaveLength(0);
  });

  it('coalesces near-duplicate queries under the same normalizedKey', async () => {
    await enableFlag(true);
    const r1 = await enqueueOnDemandExtraction({
      db, query: 'CAP tutorial',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r1.status).toBe('enqueued');

    const r2 = await enqueueOnDemandExtraction({
      db, query: 'cap  tutorial!',
      requester: { id: 'u2', kind: 'user' },
    });
    expect(r2.status).toBe('coalesced');

    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests);
    expect(rows).toHaveLength(1);
  });

  it('per-user cap: rejects the 4th enqueue in the same window', async () => {
    await enableFlag(true);
    process.env.KG_ONDEMAND_USER_MAX_PER_HOUR = '3';
    for (let i = 0; i < 3; i++) {
      const r = await enqueueOnDemandExtraction({
        db, query: `distinct query ${i}`,
        requester: { id: 'u1', kind: 'user' },
      });
      expect(r.status).toBe('enqueued');
    }
    const r4 = await enqueueOnDemandExtraction({
      db, query: 'distinct query 3',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r4.status).toBe('rate_limited');
    expect(r4.reason).toBe('user');
  });

  it('global cap: rejects the 21st enqueue across distinct users', async () => {
    await enableFlag(true);
    process.env.KG_ONDEMAND_USER_MAX_PER_HOUR = '99';
    process.env.KG_ONDEMAND_GLOBAL_MAX_PER_HOUR = '20';
    for (let i = 0; i < 20; i++) {
      const r = await enqueueOnDemandExtraction({
        db, query: `distinct query ${i}`,
        requester: { id: `u${i}`, kind: 'user' },
      });
      expect(r.status).toBe('enqueued');
    }
    const r21 = await enqueueOnDemandExtraction({
      db, query: 'one more',
      requester: { id: 'u99', kind: 'user' },
    });
    expect(r21.status).toBe('rate_limited');
    expect(r21.reason).toBe('global');
  });

  it('anonymous requesters share the anon user-bucket', async () => {
    await enableFlag(true);
    process.env.KG_ONDEMAND_USER_MAX_PER_HOUR = '2';
    for (let i = 0; i < 2; i++) {
      const r = await enqueueOnDemandExtraction({
        db, query: `q${i}`,
        requester: { ipHash: `ip${i}`, kind: 'anon' },
      });
      expect(r.status).toBe('enqueued');
    }
    const r3 = await enqueueOnDemandExtraction({
      db, query: 'q2',
      requester: { ipHash: 'ipZ', kind: 'anon' },
    });
    expect(r3.status).toBe('rate_limited');
    expect(r3.reason).toBe('user'); // 'user' bucket is the per-key bucket, keyed on 'anon' for anonymous
  });

  it('never throws — settings lookup failure returns { invalid, db_error }', async () => {
    const spy = vi.spyOn(kgSettings, 'resolveKnowledgeGraphSettings')
      .mockRejectedValueOnce(new Error('DB unreachable'));
    let result, threw = false;
    try {
      result = await enqueueOnDemandExtraction({
        db,
        query: 'test',
        requester: { id: 'u1', kind: 'user' },
      });
    } catch (e) {
      threw = true;
    }
    spy.mockRestore();
    expect(threw).toBe(false);
    expect(result).toHaveProperty('status');
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('db_error');
  });
});
