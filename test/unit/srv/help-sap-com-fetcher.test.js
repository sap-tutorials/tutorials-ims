import { describe, it, expect, beforeEach } from 'vitest';
import {
  fetchHelpSapComCorpus,
  _setMockFetcher,
  _resetForTests,
  HELP_SAP_COM_DELIVERABLES,
} from '../../../srv/lib/help-docs/help-sap-com-fetcher.js';
import metaFixture from './__fixtures__/help-sap-com-deliverable-metadata.json' assert { type: 'json' };
import pageFixture from './__fixtures__/help-sap-com-page-content.json' assert { type: 'json' };

// Utility: clone fixtures so per-test mutations don't leak.
const clone = (o) => JSON.parse(JSON.stringify(o));

// Long body — comfortably above the 200-char floor after HTML strip.
const LONG_HTML = '<html><body><p>' + 'Lorem ipsum dolor sit amet. '.repeat(20) + '</p></body></html>';
const SHORT_HTML = '<html><body>tiny</body></html>';

// Minimal single-pair scope override — tests use this to keep call graphs small.
const BTP_ONLY = [{ product: 'btp', deliverable: 'sap-business-technology-platform' }];

describe('help-sap-com-fetcher', () => {
  beforeEach(() => { _resetForTests(); });

  it('exports a frozen, non-empty deliverable scope of {product, deliverable} pairs', () => {
    expect(Object.isFrozen(HELP_SAP_COM_DELIVERABLES)).toBe(true);
    expect(HELP_SAP_COM_DELIVERABLES.length).toBeGreaterThanOrEqual(15);
    for (const entry of HELP_SAP_COM_DELIVERABLES) {
      expect(typeof entry.product).toBe('string');
      expect(typeof entry.deliverable).toBe('string');
    }
    // Sample assertion for canonical entries.
    expect(HELP_SAP_COM_DELIVERABLES).toContainEqual(
      { product: 'btp', deliverable: 'sap-business-technology-platform' }
    );
  });

  it('enumerates the TOC, returns HelpDocRow[] with correct source/product/url shape', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/deliverableMetadata')) return clone(metaFixture);
      if (url.includes('/pagecontent')) {
        // Per-topic pagecontent calls after the landing call — return a small body payload.
        const p = clone(pageFixture);
        // For non-landing topics, don't re-send fullToc (server behavior); trim it.
        if (!url.includes('file_path=landing.html')) {
          p.data.deliverable = { id: p.data.deliverable.id, buildNo: p.data.deliverable.buildNo };
          p.data.body = LONG_HTML;
          p.data.currentPage = { readableUrls: { topicReadableUrl: 'some-topic' } };
        }
        return p;
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const rows = await fetchHelpSapComCorpus({ deliverables: BTP_ONLY });
    // Landing + 2 valid Administration children (Managing Subaccounts, Entitlements and Quotas);
    // "Short Stub" is dropped by body-length filter (SHORT body is only returned via the mock
    // override in a different test), "" title is dropped by title filter.
    // In this test, ALL non-landing topics get LONG_HTML, so the short-stub is filtered by
    // its title-only. The empty-title is dropped. We keep landing + Managing + Entitlements + Short Stub.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.source).toBe('help-sap-com');
      expect(r.product).toBe('btp');
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThanOrEqual(200);
      expect(r.sourceId.startsWith('btp/sap-business-technology-platform/')).toBe(true);
      expect(r.url.startsWith('https://help.sap.com/docs/btp/sap-business-technology-platform/')).toBe(true);
      expect(r.url).toContain('?locale=en-US&state=PRODUCTION&version=Cloud');
    }
  });

  it('assigns section from the immediate parent TOC entry (null for deliverable-root topics)', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/deliverableMetadata')) return clone(metaFixture);
      if (url.includes('/pagecontent')) {
        const p = clone(pageFixture);
        if (!url.includes('file_path=landing.html')) {
          p.data.body = LONG_HTML;
        }
        return p;
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const rows = await fetchHelpSapComCorpus({ deliverables: BTP_ONLY });
    const landing = rows.find(r => r.sourceId.endsWith('/landing'));
    const nested = rows.find(r => r.sourceId.endsWith('/administration/subaccounts'));
    expect(landing?.section).toBeNull();
    expect(nested?.section).toBe('Administration');
  });

  it('skips a deliverable whose metadata call returns HTTP 404 (partial-catalog behavior)', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/deliverableMetadata') && url.includes('product_url=btp')) {
        const err = new Error('Not Found'); err.status = 404; throw err;
      }
      if (url.includes('/deliverableMetadata')) return clone(metaFixture);
      if (url.includes('/pagecontent')) {
        const p = clone(pageFixture);
        if (!url.includes('file_path=landing.html')) p.data.body = LONG_HTML;
        return p;
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const rows = await fetchHelpSapComCorpus({
      deliverables: [
        { product: 'btp', deliverable: 'sap-business-technology-platform' },
        { product: 'cap', deliverable: 'sap-business-technology-platform' },
      ],
    });
    // btp 404'd; cap succeeded. All surviving rows must be product=cap.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.product === 'cap')).toBe(true);
  });

  it('treats HTTP 200 with status != "OK" as failure and skips the deliverable', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/deliverableMetadata')) return { status: 'ERROR', data: null };
      throw new Error(`unexpected URL: ${url}`);
    });
    const rows = await fetchHelpSapComCorpus({ deliverables: BTP_ONLY });
    expect(rows).toEqual([]);
  });

  it('drops topics whose stripped body is < 200 chars OR title is empty', async () => {
    _setMockFetcher(async (url) => {
      if (url.includes('/deliverableMetadata')) return clone(metaFixture);
      if (url.includes('/pagecontent')) {
        const p = clone(pageFixture);
        // URLSearchParams percent-encodes '/'; decode the URL for readable matching.
        const decodedUrl = decodeURIComponent(url);
        if (decodedUrl.includes('file_path=administration/short-stub.html')) {
          p.data.body = SHORT_HTML;   // 4-char body → rejected
        } else if (!decodedUrl.includes('file_path=landing.html')) {
          p.data.body = LONG_HTML;
        }
        return p;
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const rows = await fetchHelpSapComCorpus({ deliverables: BTP_ONLY });
    expect(rows.find(r => r.sourceId.endsWith('/administration/short-stub'))).toBeUndefined();
    expect(rows.find(r => r.sourceId.endsWith('/administration/no-title'))).toBeUndefined();
  });
});
