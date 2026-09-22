// test/unit/semaphore-tag-sync-job.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runSemaphoreTagSync } from '../../srv/jobs/semaphore-tag-sync-job.js';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

cds.test('serve', '--project', '.', '--in-memory');

// A fake SES allterms payload + an injectable fetch/getDestination/resolveSecret
// triple. The job now does a PDC two-step + rotation pre-check, so the fake
// fetch is URL-aware: POST /token/ → token, GET /api/account/apikey → far-future
// expiry (no rotation), GET allterms.json → payload.
const PAYLOAD = {
  terms: [
    { term: { name: 'SAP S/4HANA', id: 's1', classes: ['SoftwareProduct'], paths: [{ path: ['Software Product'] }] } },
    { term: { name: 'Retail', id: 's2', classes: ['IndustryCluster'] } },
  ],
};

// URL-aware fake fetch. `alltermsRes` lets a test override just the allterms leg.
function makeFetch({ payload = PAYLOAD, alltermsRes } = {}) {
  return async (url) => {
    if (String(url).endsWith('/token/')) {
      return { ok: true, json: async () => ({ access_token: 't', expires_in: 180 }) };
    }
    if (String(url).includes('/api/account/apikey')) {
      // far-future expiry → rotation is a no-op
      return { ok: true, json: async () => ({ apikey: 'K', expiryDate: '2099-01-01T00:00:00Z' }) };
    }
    if (alltermsRes) return alltermsRes;
    return { ok: true, json: async () => payload };
  };
}

const okDeps = (payload = PAYLOAD) => ({
  getDestination: async () => ({ url: 'https://sap.data.progress.cloud/semantic/prodses' }),
  resolveSecret: async () => 'API-KEY',
  fetch: makeFetch({ payload }),
});

async function setConfig(db, entries) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  for (const [key, value] of Object.entries(entries)) {
    await db.run(INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key, value }));
  }
}

describe('runSemaphoreTagSync', () => {
  let db;
  let Tags;
  let ImsConfig;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ Tags, ImsConfig } = cds.entities('com.sap.developers.ims'));
    await DELETE.from(Tags);
    await DELETE.from(ImsConfig);
    __resetFlagsForTest();
  });
  afterEach(() => __resetFlagsForTest());

  it('no-ops when the feature flag is off', async () => {
    __setFlagForTest('SEMAPHORE_SYNC_ENABLED', false);
    const res = await runSemaphoreTagSync(null, { _deps: okDeps() });
    expect(res).toEqual({ ok: true, skipped: true, reason: 'flag-off' });
    expect(await SELECT.from(Tags)).toHaveLength(0);
  });

  it('dryRun default: reports the plan (with class histogram) without writing', async () => {
    __setFlagForTest('SEMAPHORE_SYNC_ENABLED', true);
    const res = await runSemaphoreTagSync(null, { _deps: okDeps() });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    // Intake is off by default (no intakeClasses) → both unmatched terms are
    // counted skippedIntake, nothing inserted. The histogram surfaces the real
    // class distribution so the FILTER/intakeClasses can be chosen from data.
    expect(res).toMatchObject({ fetched: 2, mapped: 2, inserted: 0, updated: 0, skippedIntake: 2 });
    expect(res.classHistogram).toContain('SoftwareProduct=1');
    expect(res.classHistogram).toContain('IndustryCluster=1');
    expect(res.intakeClasses).toBe('(none — adopt-only)');
    expect(await SELECT.from(Tags)).toHaveLength(0); // dry run wrote nothing
  });

  it('writes only allowlisted new tags (inert) when dryRun is disabled', async () => {
    __setFlagForTest('SEMAPHORE_SYNC_ENABLED', true);
    await setConfig(db, {
      'semaphore.sync.dryRun': 'false',
      // Only SoftwareProduct terms are admitted; IndustryCluster (Retail) is skipped.
      'semaphore.sync.intakeClasses': 'SoftwareProduct',
    });
    const res = await runSemaphoreTagSync(null, { _deps: okDeps() });
    expect(res).toMatchObject({ ok: true, dryRun: false, inserted: 1, skippedIntake: 1 });
    const tags = await SELECT.from(Tags);
    expect(tags).toHaveLength(1);
    const s4 = tags.find((t) => t.semaphoreId === 's1');
    expect(s4.name).toBe('sap s 4hana');
    // New intake rows always land inert, awaiting editor curation.
    expect(s4.isActualTag).toBe(false);
    expect(s4.isInterestItem).toBe(false);
    // The non-allowlisted term was not written.
    expect(tags.find((t) => t.semaphoreId === 's2')).toBeUndefined();
  });

  it('fails shut on a fetch error — writes nothing', async () => {
    __setFlagForTest('SEMAPHORE_SYNC_ENABLED', true);
    await setConfig(db, { 'semaphore.sync.dryRun': 'false' });
    // token + rotation succeed; the allterms leg 500s → fail-shut, no writes.
    const deps = {
      getDestination: async () => ({ url: 'https://sap.data.progress.cloud/semantic/prodses' }),
      resolveSecret: async () => 'API-KEY',
      fetch: makeFetch({ alltermsRes: { ok: false, status: 500, text: async () => 'boom' } }),
    };
    const res = await runSemaphoreTagSync(null, { _deps: deps });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/HTTP 500/);
    expect(await SELECT.from(Tags)).toHaveLength(0);
  });
});
