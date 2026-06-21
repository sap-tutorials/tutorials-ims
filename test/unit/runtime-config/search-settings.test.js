// test/unit/runtime-config/search-settings.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  resolveSearchSettings,
  _resetCacheForTests,
} from '../../../srv/lib/runtime-config/search-settings.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { SearchSettings } = cds.entities('com.sap.developers.ims');
  await DELETE.from(SearchSettings);
  delete process.env.SEARCH_RATE_LIMIT_MAX;
  delete process.env.SEARCH_RATE_LIMIT_WINDOW_MS;
  _resetCacheForTests();
});

describe('resolveSearchSettings (#466)', () => {
  it('returns hardcoded defaults when DB empty + env unset', async () => {
    const s = await resolveSearchSettings();
    expect(s).toEqual({ rateLimitMax: 60, rateLimitWindowMs: 60_000 });
  });

  it('falls through to env vars when DB row absent', async () => {
    process.env.SEARCH_RATE_LIMIT_MAX = '100';
    process.env.SEARCH_RATE_LIMIT_WINDOW_MS = '30000';
    const s = await resolveSearchSettings();
    expect(s.rateLimitMax).toBe(100);
    expect(s.rateLimitWindowMs).toBe(30000);
  });

  it('DB row wins over env var (admin override)', async () => {
    process.env.SEARCH_RATE_LIMIT_MAX = '100';
    const { SearchSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(SearchSettings).entries({
      ID: 'bb000000-0000-0000-0000-000000000001',
      rateLimitMax: 30,
      rateLimitWindowMs: 45000,
    });
    _resetCacheForTests();
    const s = await resolveSearchSettings();
    expect(s.rateLimitMax).toBe(30);
    expect(s.rateLimitWindowMs).toBe(45000);
  });

  it('caches reads within 5s TTL', async () => {
    const { SearchSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(SearchSettings).entries({
      ID: 'bb000000-0000-0000-0000-000000000002',
      rateLimitMax: 25,
    });
    _resetCacheForTests();
    const first = await resolveSearchSettings();
    expect(first.rateLimitMax).toBe(25);

    await UPDATE(SearchSettings).with({ rateLimitMax: 99 });
    const second = await resolveSearchSettings();
    expect(second.rateLimitMax).toBe(25); // cached
  });

  it('cache reset returns fresh row', async () => {
    const { SearchSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(SearchSettings).entries({
      ID: 'bb000000-0000-0000-0000-000000000003',
      rateLimitMax: 25,
    });
    _resetCacheForTests();
    expect((await resolveSearchSettings()).rateLimitMax).toBe(25);

    await UPDATE(SearchSettings).with({ rateLimitMax: 99 });
    _resetCacheForTests();
    expect((await resolveSearchSettings()).rateLimitMax).toBe(99);
  });

  it('rateLimitMax = 0 is preserved (effectively disables search)', async () => {
    const { SearchSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(SearchSettings).entries({
      ID: 'bb000000-0000-0000-0000-000000000004',
      rateLimitMax: 0,
    });
    _resetCacheForTests();
    const s = await resolveSearchSettings();
    expect(s.rateLimitMax).toBe(0);
  });
});
