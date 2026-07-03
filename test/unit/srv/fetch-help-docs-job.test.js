// test/unit/srv/fetch-help-docs-job.test.js
//
// Phase 4.7 (#748) Task 2: cron orchestration test for help-docs.
// Mirrors test/unit/srv/fetch-samples-job.test.js with the three-source
// orchestrator seam (_setMockOrchestrator) that bypasses the raw HTTP
// layer entirely and returns synthetic { rows, perSource } directly.

import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

let runFetchHelpDocs;
let _setMockOrchestrator;
let _resetForTests;

describe('fetch-help-docs-job', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    ({ runFetchHelpDocs } = await import('../../../srv/jobs/fetch-help-docs-job.js'));
    ({ _setMockOrchestrator, _resetForTests } = await import('../../../srv/lib/help-docs/index.js'));
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { HelpDocs, HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    await DELETE.from(HelpDocConceptLinks);
    await DELETE.from(HelpDocs);
    await DELETE.from(Concepts);
    _resetForTests();
  });

  it('MAX-or-abort gate fires when HelpDocs is empty', async () => {
    _setMockOrchestrator(async () => ({ rows: [], perSource: {} }));
    const summary = await runFetchHelpDocs(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.fetched).toBe(0);
  });

  it('exact-match concept resolves end-to-end (with anchor)', async () => {
    const { HelpDocs } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    // Seed prereqs: one existing HelpDocs row satisfies the MAX-or-abort gate.
    await INSERT.into(HelpDocs).entries({
      slug: 'hd-existing', title: 'seed', description: 'pre',
      source: 'cap-cloud-sap', product: 'cap', section: null,
      url: 'https://cap.cloud.sap/seed', sourceId: 'seed', contentHash: 'old',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    });
    await INSERT.into(Concepts).entries({
      ID: '00000000-0000-0000-0000-000000000201',
      slug: 'cap-service-handlers', name: 'CAP service handlers', status: 'ACTIVE',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    });

    _setMockOrchestrator(async () => ({ rows: [{
      source: 'cap-cloud-sap',
      sourceId: 'docs/node.js/handlers',
      title: 'Handlers',
      description: 'Register handlers before/on/after CRUD.',
      url: 'https://cap.cloud.sap/docs/node.js/handlers',
      product: 'cap',
      section: null,
      contentHash: 'new-hash-1',
    }], perSource: {} }));

    const summary = await runFetchHelpDocs(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({
        concepts: [{
          slug: 'cap-service-handlers',
          name: 'CAP service handlers',
          confidence: 0.95,
          anchor: 'before-create',
        }],
        promptTokens: 200, completionTokens: 30,
      }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    expect(summary.errors).toBe(0);
    expect(summary.linksWritten).toBe(1);
    expect(summary.hasAnchorCount).toBe(1);
    expect(summary.nullAnchorCount).toBe(0);
  });

  it('null anchor is counted and passed through', async () => {
    const { HelpDocs } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await INSERT.into(HelpDocs).entries({
      slug: 'hd-seed2', title: 'seed', description: 'x', source: 'help-sap-com',
      product: 'btp', section: null, url: 'https://help.sap.com/x',
      sourceId: 's', contentHash: 'h', firstSeenAt: new Date(), lastSeenAt: new Date(),
    });
    await INSERT.into(Concepts).entries({
      ID: '00000000-0000-0000-0000-000000000202',
      slug: 'concept-a', name: 'A', status: 'ACTIVE',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    });

    _setMockOrchestrator(async () => ({ rows: [{
      source: 'help-sap-com', sourceId: 'docs/btp/x', title: 'X page',
      description: 'body', url: 'https://help.sap.com/docs/btp/x',
      product: 'btp', section: 'Getting Started', contentHash: 'new-hash-2',
    }], perSource: {} }));

    const summary = await runFetchHelpDocs(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({
        concepts: [{ slug: 'concept-a', name: 'A', confidence: 0.9, anchor: null }],
        promptTokens: 100, completionTokens: 10,
      }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });
    expect(summary.hasAnchorCount).toBe(0);
    expect(summary.nullAnchorCount).toBe(1);
  });

  it('lastExtractedHash skip on second consecutive run (#708 crash-safety gate)', async () => {
    const { HelpDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(HelpDocs).entries({
      slug: 'hd-preexisting', title: 'x', description: 'x', source: 'cap-cloud-sap',
      product: 'cap', section: null, url: 'https://x', sourceId: 'pre',
      contentHash: 'preh', firstSeenAt: new Date(), lastSeenAt: new Date(),
    });

    _setMockOrchestrator(async () => ({ rows: [{
      source: 'cap-cloud-sap', sourceId: 'stable', title: 'Stable',
      description: 'unchanged', url: 'https://cap.cloud.sap/stable',
      product: 'cap', section: null, contentHash: 'stable-hash',
    }], perSource: {} }));

    const opts = {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    };
    await runFetchHelpDocs(null, opts);
    const second = await runFetchHelpDocs(null, opts);
    expect(second.skippedNoChange).toBeGreaterThanOrEqual(1);
    expect(second.extracted).toBe(0);
  });

  it('per-source summary logs { rowsFetched, fetcherRejected } for each source', async () => {
    const { HelpDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(HelpDocs).entries({
      slug: 'hd-seed3', title: 'x', description: 'x', source: 'cap-cloud-sap',
      product: 'cap', section: null, url: 'https://x', sourceId: 'x',
      contentHash: 'h', firstSeenAt: new Date(), lastSeenAt: new Date(),
    });

    _setMockOrchestrator(async () => ({
      rows: [{
        source: 'cap-cloud-sap', sourceId: 'a', title: 'A', description: 'a',
        url: 'https://cap.cloud.sap/a', product: 'cap', section: null, contentHash: 'ha',
      }],
      perSource: {
        'help-sap-com': { rowsFetched: 0, fetcherRejected: true, reason: '403 forbidden' },
        'cap-cloud-sap': { rowsFetched: 1, fetcherRejected: false },
        'ui5-sap-com': { rowsFetched: 0, fetcherRejected: false },
        'architecture-sap-com': { rowsFetched: 0, fetcherRejected: false },
      },
    }));

    const summary = await runFetchHelpDocs(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });
    expect(summary.perSource).toBeDefined();
    expect(summary.perSource['help-sap-com'].fetcherRejected).toBe(true);
    expect(summary.perSource['help-sap-com'].reason).toMatch(/403/);
    expect(summary.perSource['cap-cloud-sap'].fetcherRejected).toBe(false);
    expect(summary.perSource['cap-cloud-sap'].rowsFetched).toBe(1);
    expect(summary.perSource['ui5-sap-com'].fetcherRejected).toBe(false);
    expect(summary.perSource['ui5-sap-com'].rowsFetched).toBe(0);
    expect(summary.perSource['architecture-sap-com'].fetcherRejected).toBe(false);
    expect(summary.perSource['architecture-sap-com'].rowsFetched).toBe(0);
  });

  it('budget exhausted counts extracted but marks budgetExhausted flag', async () => {
    const { HelpDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(HelpDocs).entries({
      slug: 'hd-seed4', title: 'x', description: 'x', source: 'cap-cloud-sap',
      product: 'cap', section: null, url: 'https://x', sourceId: 'seed',
      contentHash: 'h', firstSeenAt: new Date(), lastSeenAt: new Date(),
    });

    _setMockOrchestrator(async () => ({ rows: [
      { source: 'cap-cloud-sap', sourceId: 'a', title: 'A', description: 'a',
        url: 'https://x/a', product: 'cap', section: null, contentHash: 'ha' },
      { source: 'cap-cloud-sap', sourceId: 'b', title: 'B', description: 'b',
        url: 'https://x/b', product: 'cap', section: null, contentHash: 'hb' },
    ], perSource: {} }));

    const summary = await runFetchHelpDocs(null, {
      budgetOverride: 1,
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });
    expect(summary.upserted).toBe(2);
    expect(summary.extracted).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
  });

  it('link INSERT denormalizes snippet (first ~120 chars of description)', async () => {
    const { HelpDocs, HelpDocConceptLinks } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await INSERT.into(HelpDocs).entries({
      slug: 'hd-seed5', title: 'x', description: 'x', source: 'cap-cloud-sap',
      product: 'cap', section: null, url: 'https://x', sourceId: 'seed',
      contentHash: 'h', firstSeenAt: new Date(), lastSeenAt: new Date(),
    });
    await INSERT.into(Concepts).entries({
      ID: '00000000-0000-0000-0000-000000000203',
      slug: 'concept-b', name: 'B', status: 'ACTIVE',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    });

    const longDesc = 'A'.repeat(300);
    _setMockOrchestrator(async () => ({ rows: [{
      source: 'cap-cloud-sap', sourceId: 'z', title: 'Long', description: longDesc,
      url: 'https://x/z', product: 'cap', section: null, contentHash: 'hz',
    }], perSource: {} }));
    await runFetchHelpDocs(null, {
      embed: async () => new Float32Array(384),
      extractFn: async () => ({
        concepts: [{ slug: 'concept-b', name: 'B', confidence: 0.9, anchor: null }],
        promptTokens: 100, completionTokens: 10,
      }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    const links = await SELECT.from(HelpDocConceptLinks).columns('snippet', 'helpDoc_ID');
    // The z-row should have been INSERTed; find its snippet.
    const zDoc = await SELECT.one.from(HelpDocs).columns('ID').where({ sourceId: 'z' });
    const zLink = links.find(l => l.helpDoc_ID === zDoc.ID);
    expect(zLink).toBeDefined();
    expect(zLink.snippet).toBeDefined();
    expect(zLink.snippet.length).toBeLessThanOrEqual(200);
    // First 120 chars of 300 As is 120 As
    expect(zLink.snippet.startsWith('AAAA')).toBe(true);
  });
});
