import { describe, it, expect, beforeEach } from 'vitest';
import { fetchCapCloudSapCorpus, _setMockFetcher, _resetForTests }
  from '../../../srv/lib/help-docs/cap-cloud-sap-fetcher.js';
import treeFixture from './__fixtures__/cap-cloud-sap-tree.json' assert { type: 'json' };
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const handlersMd = readFileSync(
  fileURLToPath(new URL('./__fixtures__/cap-cloud-sap-handlers.md', import.meta.url)),
  'utf8'
);

describe('cap-cloud-sap-fetcher', () => {
  beforeEach(() => { _resetForTests(); });

  it('enumerates .md files under docs/, skipping README + assets + config', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return treeFixture;
      return handlersMd;
    });
    const rows = await fetchCapCloudSapCorpus({ apiKey: 'fake' });
    // Expected: docs/node.js/handlers.md, docs/node.js/services.md, docs/cds/cdl.md
    // README.md is at repo root (not under docs/) — rejected.
    // .png + .js — rejected (only .md).
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.source === 'cap-cloud-sap')).toBe(true);
    expect(rows.every(r => r.product === 'cap')).toBe(true);
    expect(rows.every(r => r.section === null)).toBe(true);
  });

  it('derives canonical URL from file path (docs/node.js/handlers.md → cap.cloud.sap/docs/node.js/handlers)', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return { ...treeFixture, tree: [treeFixture.tree[0]] };
      return handlersMd;
    });
    const rows = await fetchCapCloudSapCorpus({ apiKey: 'fake' });
    expect(rows[0].url).toBe('https://cap.cloud.sap/docs/node.js/handlers');
    expect(rows[0].sourceId).toBe('docs/node.js/handlers.md');
  });

  it('extracts title from frontmatter when present, falls back to filename', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return { ...treeFixture, tree: [treeFixture.tree[0], treeFixture.tree[2]] };
      if (url.includes('handlers.md')) return handlersMd;
      // cds/cdl.md — no frontmatter, no H1
      return 'This is CDL syntax documentation. '.repeat(20);
    });
    const rows = await fetchCapCloudSapCorpus({ apiKey: 'fake' });
    const h = rows.find(r => r.sourceId.endsWith('handlers.md'));
    expect(h.title).toBe('Event Handlers');   // from frontmatter title:
    const c = rows.find(r => r.sourceId.endsWith('cdl.md'));
    expect(c.title).toBe('cdl');              // fallback: filename without .md
  });

  it('strips markdown frontmatter and truncates body to 2000 chars', async () => {
    const HUGE = '# Title\n\n' + 'body body body '.repeat(500);
    _setMockFetcher(async (url) => {
      if (url.includes('/git/trees/')) return { ...treeFixture, tree: [treeFixture.tree[0]] };
      return HUGE;
    });
    const rows = await fetchCapCloudSapCorpus({ apiKey: 'fake' });
    expect(rows[0].description.length).toBeLessThanOrEqual(2000);
    expect(rows[0].description).not.toMatch(/^---/);
  });

  it('surfaces auth failure as a thrown error (partial-catalog is orchestrator concern)', async () => {
    _setMockFetcher(async () => {
      const err = new Error('GitHub 401 Unauthorized'); err.status = 401; throw err;
    });
    await expect(fetchCapCloudSapCorpus({ apiKey: 'fake' })).rejects.toThrow(/401/);
  });
});
