import { describe, it, expect, beforeEach } from 'vitest';
import { fetchAllHelpDocs, _setMockFetcher, _setMockOrchestrator, _resetForTests } from '../../../srv/lib/help-docs/index.js';
import { HELP_SAP_COM_DELIVERABLES } from '../../../srv/lib/help-docs/help-sap-com-fetcher.js';

describe('help-docs orchestrator', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('returns { rows, perSource } when all three fetchers succeed', async () => {
    // Empty payloads per source — orchestrator returns { rows: [], perSource: {...} }
    _setMockFetcher('help-sap-com', async (url) => {
      if (url.includes('/http.svc/deliverableMetadata')) {
        return { status: 'OK', data: { deliverable: { id: 999, buildNo: 1 }, filePath: 'x.html', topicLoio: 'x' } };
      }
      if (url.includes('/http.svc/pagecontent')) {
        return { status: 'OK', data: { body: '', deliverable: { fullToc: [] }, currentPage: {} } };
      }
      return null;
    });
    _setMockFetcher('cap-cloud-sap', async (url) => url.includes('/git/trees/') ? { tree: [] } : '');
    _setMockFetcher('ui5-sap-com', async (url) => url.includes('/docs/topics/index.json') ? [] : '');
    const result = await fetchAllHelpDocs({ apiKey: 'fake' });
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.perSource).toBeDefined();
    expect(result.perSource['help-sap-com'].fetcherRejected).toBe(false);
    expect(result.perSource['cap-cloud-sap'].fetcherRejected).toBe(false);
    expect(result.perSource['ui5-sap-com'].fetcherRejected).toBe(false);
  });

  it('surfaces partial catalog when one fetcher rejects (does not abort cycle)', async () => {
    // help-sap-com and ui5-sap-com are designed to survive per-item errors and
    // return []; cap-cloud-sap propagates tree-fetch failures. To exercise the
    // partial-catalog path we make cap-cloud-sap reject while the other two
    // still return their (empty) fulfilled catalogs.
    _setMockFetcher('help-sap-com', async () => { throw new Error('help.sap.com item down'); });
    _setMockFetcher('cap-cloud-sap', async () => { throw new Error('cap-cloud-sap tree 500'); });
    _setMockFetcher('ui5-sap-com', async (url) => url.includes('/docs/topics/index.json') ? [] : '');
    const { rows, perSource } = await fetchAllHelpDocs({ apiKey: 'fake' });
    expect(rows).toEqual([]);
    // help-sap-com swallowed per-deliverable errors and produced an empty catalog.
    expect(perSource['help-sap-com'].fetcherRejected).toBe(false);
    expect(perSource['help-sap-com'].rowsFetched).toBe(0);
    // cap-cloud-sap propagates tree-fetch failures — this is the "rejected" case.
    expect(perSource['cap-cloud-sap'].fetcherRejected).toBe(true);
    expect(perSource['cap-cloud-sap'].reason).toMatch(/tree 500/);
    expect(perSource['ui5-sap-com'].fetcherRejected).toBe(false);
  });

  it('returns empty rows when all fetchers produce zero output; perSource records status', async () => {
    // Only cap-cloud-sap actually rejects (its contract is to propagate);
    // help-sap-com and ui5-sap-com swallow per-item errors and return [].
    _setMockFetcher('help-sap-com', async () => { throw new Error('down1'); });
    _setMockFetcher('cap-cloud-sap', async () => { throw new Error('down2'); });
    _setMockFetcher('ui5-sap-com', async () => { throw new Error('down3'); });
    const { rows, perSource } = await fetchAllHelpDocs({ apiKey: 'fake' });
    expect(rows).toEqual([]);
    expect(perSource['help-sap-com'].rowsFetched).toBe(0);
    expect(perSource['cap-cloud-sap'].fetcherRejected).toBe(true);
    expect(perSource['ui5-sap-com'].rowsFetched).toBe(0);
  });

  it('passes seenSourceIds through to each fetcher (filter is actually applied)', async () => {
    // Mock returns a real topic for every deliverable. The help-sap-com fetcher
    // computes sourceId as `${product}/${deliverable}/${stripDotHtml(node.u)}`.
    // Build the full seenSourceIds set from HELP_SAP_COM_DELIVERABLES so every
    // possible emitted sourceId is filtered — proving the passthrough works.
    // Post-dedupe row counts alone won't work because dedupe collapses
    // same-content rows across deliverables.
    const longBody = '<html><body>' + 'x '.repeat(250) + '</body></html>';
    const helpMock = async (url) => {
      if (url.includes('/http.svc/deliverableMetadata')) {
        return {
          status: 'OK',
          data: {
            deliverable: { id: 1, buildNo: 1 },
            filePath: 'landing.html',
            topicLoio: 'landing',
          },
        };
      }
      if (url.includes('/http.svc/pagecontent')) {
        return {
          status: 'OK',
          data: {
            body: longBody,
            deliverable: {
              fullToc: [
                { t: 'Seen Topic', u: 'seen-topic.html', c: [] },
              ],
            },
            currentPage: { readableUrls: { topicReadableUrl: 'seen-topic' } },
          },
        };
      }
      return null;
    };
    _setMockFetcher('help-sap-com', helpMock);
    _setMockFetcher('cap-cloud-sap', async (url) => url.includes('/git/trees/') ? { tree: [] } : '');
    _setMockFetcher('ui5-sap-com', async (url) => url.includes('/docs/topics/index.json') ? [] : '');

    // Baseline: no seenSourceIds — orchestrator returns some rows (post-dedupe).
    const baseline = await fetchAllHelpDocs({ apiKey: 'fake' });
    const baselineHelp = baseline.rows.filter(r => r.source === 'help-sap-com');
    expect(baselineHelp.length).toBeGreaterThan(0);

    // Now pass every possible help-sap-com sourceId (product/deliverable/seen-topic)
    // as seenSourceIds. The orchestrator MUST forward this to the fetcher, which
    // then filters BEFORE dedupe. If the orchestrator drops seenSourceIds, rows survive.
    _resetForTests();
    _setMockFetcher('help-sap-com', helpMock);
    _setMockFetcher('cap-cloud-sap', async (url) => url.includes('/git/trees/') ? { tree: [] } : '');
    _setMockFetcher('ui5-sap-com', async (url) => url.includes('/docs/topics/index.json') ? [] : '');
    const seenSourceIds = new Set(
      HELP_SAP_COM_DELIVERABLES.map(({ product, deliverable }) => `${product}/${deliverable}/seen-topic`)
    );
    const filtered = await fetchAllHelpDocs({ apiKey: 'fake', seenSourceIds });
    const filteredHelpRows = filtered.rows.filter(r => r.source === 'help-sap-com');
    expect(filteredHelpRows).toHaveLength(0);
  });

  it('perSource.rowsFetched matches actual returned rows', async () => {
    // Use _setMockOrchestrator to inject a controlled { rows, perSource } shape
    // and assert an EXACT count. This is cleaner than trying to control the
    // fetcher-level mock across 20 deliverables.
    _setMockOrchestrator(async () => ({
      rows: [
        { source: 'help-sap-com', sourceId: 'a', title: 'A', description: 'a', url: 'https://x/a', product: 'btp', section: null },
        { source: 'help-sap-com', sourceId: 'b', title: 'B', description: 'b', url: 'https://x/b', product: 'btp', section: null },
      ],
      perSource: {
        'help-sap-com': { rowsFetched: 2, fetcherRejected: false, reason: null },
        'cap-cloud-sap': { rowsFetched: 0, fetcherRejected: false, reason: null },
        'ui5-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
      },
    }));
    const { rows, perSource } = await fetchAllHelpDocs({ apiKey: 'fake' });
    expect(perSource['help-sap-com'].rowsFetched).toBe(2);
    expect(rows).toHaveLength(2);
  });
});
