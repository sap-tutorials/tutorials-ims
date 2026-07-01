import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchUi5SapComCorpus, _setMockFetcher, _resetForTests }
  from '../../../srv/lib/help-docs/ui5-sap-com-fetcher.js';
import indexFixture from './__fixtures__/ui5-topics-index.json' assert { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LONG_TOPIC_HTML = readFileSync(
  path.join(__dirname, '__fixtures__/ui5-topic-body.html'),
  'utf8',
);
const SHORT_TOPIC_HTML = '<html><body><section>tiny</section></body></html>';

// Utility: clone fixtures so per-test mutations don't leak.
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('ui5-sap-com-fetcher', () => {
  beforeEach(() => { _resetForTests(); });

  it('walks the hierarchical index and enumerates topic keys (top-level + nested)', async () => {
    _setMockFetcher(async (url) => {
      if (url.endsWith('/index.json')) return clone(indexFixture);
      return LONG_TOPIC_HTML;
    });
    const rows = await fetchUi5SapComCorpus();
    // 3 top-level + 2 valid nested (Data Binding has 3 children but one has empty title)
    // = 5 topics that pass the title filter.
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.source).toBe('ui5-sap-com');
      expect(r.product).toBe('ui5');
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThanOrEqual(200);
    }
  });

  it('constructs sourceId and URL from the topic key', async () => {
    _setMockFetcher(async (url) => {
      if (url.endsWith('/index.json')) return [clone(indexFixture[0])];
      return LONG_TOPIC_HTML;
    });
    const rows = await fetchUi5SapComCorpus();
    expect(rows[0].sourceId).toBe('topic/91f0652b6f4fc0cec4cb8d5b4a1e6e6d');
    expect(rows[0].url).toBe('https://ui5.sap.com/#/topic/91f0652b6f4fc0cec4cb8d5b4a1e6e6d');
  });

  it('assigns section from parent index entry (null for top-level topics)', async () => {
    _setMockFetcher(async (url) => {
      if (url.endsWith('/index.json')) return clone(indexFixture);
      return LONG_TOPIC_HTML;
    });
    const rows = await fetchUi5SapComCorpus();
    const topLevel = rows.find(r => r.sourceId.endsWith('91f0652b6f4fc0cec4cb8d5b4a1e6e6d'));
    const nested = rows.find(r => r.sourceId.endsWith('b0000000000000000000000000000001'));
    expect(topLevel?.section).toBeNull();
    expect(nested?.section).toBe('Data Binding');
  });

  it('rejects entries with empty title', async () => {
    _setMockFetcher(async (url) => {
      if (url.endsWith('/index.json')) return clone(indexFixture);
      return LONG_TOPIC_HTML;
    });
    const rows = await fetchUi5SapComCorpus();
    expect(rows.find(r => r.sourceId.endsWith('b0000000000000000000000000000003'))).toBeUndefined();
  });

  it('drops topics whose stripped body is < 200 chars', async () => {
    _setMockFetcher(async (url) => {
      if (url.endsWith('/index.json')) return clone(indexFixture);
      // Only "Two-Way Data Binding" gets the short body; everyone else passes.
      if (url.includes('/topics/b0000000000000000000000000000002.html')) return SHORT_TOPIC_HTML;
      return LONG_TOPIC_HTML;
    });
    const rows = await fetchUi5SapComCorpus();
    expect(rows.find(r => r.sourceId.endsWith('b0000000000000000000000000000002'))).toBeUndefined();
  });

  it('strips HTML from the per-topic body and truncates to 2000 chars', async () => {
    const HUGE = '<html><body><section>' + 'x'.repeat(5000) + '</section></body></html>';
    _setMockFetcher(async (url) => {
      if (url.endsWith('/index.json')) return [clone(indexFixture[0])];
      return HUGE;
    });
    const rows = await fetchUi5SapComCorpus();
    expect(rows[0].description.length).toBe(2000);
    expect(rows[0].description).not.toMatch(/</);
  });
});
