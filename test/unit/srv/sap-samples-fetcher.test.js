import { describe, it, expect, beforeEach } from 'vitest';
import { fetchSapSamplesCorpus, _setMockFetcher, _resetForTests }
  from '../../../srv/lib/sap-samples-fetcher.js';
import listingFixture from './__fixtures__/sap-samples-listing-page.json' assert { type: 'json' };
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readmeContent = readFileSync(
  fileURLToPath(new URL('./__fixtures__/sap-samples-readme.md', import.meta.url)),
  'utf8'
);

describe('sap-samples-fetcher', () => {
  beforeEach(() => { _resetForTests(); });

  it('returns 3 normalized rows after auto-filter (archive/fork/stale rejected)', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/SAP-samples/repos')) return listingFixture.items;
      if (url.includes('/readme')) return readmeContent;
      throw new Error(`unexpected url: ${url}`);
    });
    const rows = await fetchSapSamplesCorpus({ apiKey: 'fake-token' });
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.sourceId)).toEqual([
      'SAP-samples/cloud-cap-samples',
      'SAP-samples/s4hana-cloud-extension-business-partner-mdk',
      'SAP-samples/abap-cloud-developer-extensibility-starter-pack',
    ]);
  });

  it('filters archived repos', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/SAP-samples/repos')) return listingFixture.items;
      return readmeContent;
    });
    const rows = await fetchSapSamplesCorpus({ apiKey: 'fake-token' });
    expect(rows.find(r => r.sourceId === 'SAP-samples/archived-old-sample')).toBeUndefined();
  });

  it('filters fork repos', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/SAP-samples/repos')) return listingFixture.items;
      return readmeContent;
    });
    const rows = await fetchSapSamplesCorpus({ apiKey: 'fake-token' });
    expect(rows.find(r => r.sourceId === 'SAP-samples/forked-sample')).toBeUndefined();
  });

  it('filters stale repos (pushed_at > 24 months)', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/SAP-samples/repos')) return listingFixture.items;
      return readmeContent;
    });
    const rows = await fetchSapSamplesCorpus({ apiKey: 'fake-token' });
    expect(rows.find(r => r.sourceId === 'SAP-samples/stale-sample')).toBeUndefined();
  });

  it('truncates description to first 2000 chars', async () => {
    const longReadme = 'a'.repeat(3000);
    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/SAP-samples/repos')) return [listingFixture.items[0]];
      return longReadme;
    });
    const rows = await fetchSapSamplesCorpus({ apiKey: 'fake-token' });
    expect(rows[0].description.length).toBe(2000);
  });

  it('falls back to repo.description when README returns 404', async () => {
    _setMockFetcher(async (url, opts) => {
      if (url.includes('/orgs/SAP-samples/repos')) return [listingFixture.items[0]];
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    });
    const rows = await fetchSapSamplesCorpus({ apiKey: 'fake-token' });
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Samples for CAP — Cloud Application Programming Model');
  });

  it('skips repos where both README and description are empty', async () => {
    const noDescItem = { ...listingFixture.items[0], description: '' };
    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/SAP-samples/repos')) return [noDescItem];
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    });
    const rows = await fetchSapSamplesCorpus({ apiKey: 'fake-token' });
    expect(rows).toHaveLength(0);
  });
});
