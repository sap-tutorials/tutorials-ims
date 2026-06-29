// test/unit/srv/fetch-samples-job.test.js
//
// Phase 4.6 (#747) Task 2: cron orchestration test for SAP-samples.
// Mirrors test/unit/srv/fetch-api-docs-job.test.js with single-predicate
// shape: SampleConceptLinks (embodies).

import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

let runFetchSamples;
let _setMockFetcher;
let _resetForTests;

function vec(...nums) { return new Float32Array(nums); }
function buf(...nums) {
  const f = vec(...nums);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

describe('fetch-samples-job', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    ({ runFetchSamples } = await import('../../../srv/jobs/fetch-samples-job.js'));
    ({ _setMockFetcher, _resetForTests } = await import('../../../srv/lib/sap-samples-fetcher.js'));
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { Samples, SampleConceptLinks } = cds.entities('com.sap.developers.ims.external');
    await DELETE.from(SampleConceptLinks);
    await DELETE.from(Samples);
    await DELETE.from(Concepts);
    _resetForTests();
    _setMockFetcher(null);
  });

  it('MAX-or-abort gate fires when Samples is empty', async () => {
    _setMockFetcher(async () => []);
    const summary = await runFetchSamples(null, {
      apiKeyOverride: 'fake-token',
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.fetched).toBe(0);
    expect(summary.upserted).toBe(0);
  });

  it('exact-match concept resolves end-to-end', async () => {
    const { Samples } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    // Seed prereqs
    await INSERT.into(Samples).entries({
      slug: 'sa-existing', title: 'Existing', description: 'pre',
      url: 'https://github.com/x/y', sourceId: 'x/y', contentHash: 'old-hash',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      language: 'JavaScript', stars: 1, lastCommitAt: new Date(),
    });
    await INSERT.into(Concepts).entries({
      ID: '00000000-0000-0000-0000-000000000001',
      slug: 'cap-service-handlers', name: 'CAP service handlers', status: 'ACTIVE',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    });

    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/')) {
        return [{
          full_name: 'SAP-samples/cap-handler-demo',
          name: 'cap-handler-demo',
          archived: false, fork: false,
          pushed_at: new Date().toISOString(),
          stargazers_count: 50, language: 'JavaScript',
          topics: ['cap'], description: 'Demo of CAP handlers',
          html_url: 'https://github.com/SAP-samples/cap-handler-demo',
        }];
      }
      return 'README content for handlers demo';
    });

    const summary = await runFetchSamples(null, {
      apiKeyOverride: 'fake-token',
      embed: async () => new Float32Array(384),
      extractFn: async () => ({
        concepts: [{ slug: 'cap-service-handlers', name: 'CAP service handlers', confidence: 0.95 }],
        promptTokens: 100, completionTokens: 20,
      }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    expect(summary.errors).toBe(0);
    expect(summary.upserted).toBe(1);
    expect(summary.linksWritten).toBe(1);
  });

  it('merge+mint+dedup works (3 candidates → resolved unique)', async () => {
    const { Samples } = cds.entities('com.sap.developers.ims.external');
    const { Concepts } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Samples).entries({
      slug: 'sa-seed', title: 'seed', description: 'x', url: 'https://github.com/a/b',
      sourceId: 'a/b', contentHash: 'h', firstSeenAt: new Date(), lastSeenAt: new Date(),
      language: 'X', stars: 0, lastCommitAt: new Date(),
    });
    // Seed an embedded concept so merge-on-write has registry to compare against.
    await INSERT.into(Concepts).entries({
      ID: '00000000-0000-0000-0000-000000000010',
      slug: 'existing-concept', name: 'Existing',
      embedding: buf(1, 0, 0, 0),
      status: 'ACTIVE',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    });

    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/')) {
        return [{
          full_name: 'SAP-samples/new-sample',
          name: 'new-sample',
          archived: false, fork: false,
          pushed_at: new Date().toISOString(),
          stargazers_count: 10, language: 'X',
          topics: [], description: 'fresh',
          html_url: 'https://github.com/SAP-samples/new-sample',
        }];
      }
      return 'README';
    });

    // Near-dup is similar to existing → merges; genuinely-new is orthogonal → mints.
    const embed = vi.fn(async ([name]) => {
      if (name === 'Existing (near dup)') return [vec(0.99, 0.01, 0, 0)];
      if (name === 'Genuinely New') return [vec(0, 0, 1, 0)];
      throw new Error(`unexpected embed: ${name}`);
    });

    const summary = await runFetchSamples(null, {
      apiKeyOverride: 'fake-token',
      embed,
      extractFn: async () => ({
        concepts: [
          { slug: 'existing-concept', name: 'Existing', confidence: 0.95 },             // exact-match
          { slug: 'existing-concept-near-dup', name: 'Existing (near dup)', confidence: 0.85 }, // near-dup → merge
          { slug: 'genuinely-new', name: 'Genuinely New', confidence: 0.90 },           // novel mint
        ],
        promptTokens: 100, completionTokens: 20,
      }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    expect(summary.errors).toBe(0);
    expect(summary.mergedAtExtract).toBe(1);
    expect(summary.mintedAtExtract).toBe(1);
    // dedup-by-conceptId: exact + near-dup collapse to same conceptId → 2 distinct links.
    expect(summary.linksWritten).toBe(2);
  });

  it('lastExtractedHash skip on second consecutive run', async () => {
    const { Samples } = cds.entities('com.sap.developers.ims.external');
    // Seed a Sample row (bypass MAX-or-abort)
    await INSERT.into(Samples).entries({
      slug: 'sa-bootstrap', title: 'bootstrap', description: 'x',
      url: 'https://github.com/x/x', sourceId: 'x/x', contentHash: 'old',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      language: 'X', stars: 0, lastCommitAt: new Date(),
    });

    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/')) {
        return [{
          full_name: 'SAP-samples/stable',
          name: 'stable', archived: false, fork: false,
          pushed_at: '2026-01-01T00:00:00Z',
          stargazers_count: 5, language: 'X',
          topics: [], description: 'unchanged',
          html_url: 'https://github.com/SAP-samples/stable',
        }];
      }
      return 'README';
    });

    const opts = {
      apiKeyOverride: 'fake-token',
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    };
    await runFetchSamples(null, opts);
    const second = await runFetchSamples(null, opts);
    expect(second.skippedNoChange).toBeGreaterThanOrEqual(1);
    expect(second.extracted).toBe(0);
  });

  it('budget exhausted', async () => {
    const { Samples } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(Samples).entries({
      slug: 'sa-bootstrap2', title: 'bootstrap2', description: 'x',
      url: 'https://github.com/x/x2', sourceId: 'x/x2', contentHash: 'old',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      language: 'X', stars: 0, lastCommitAt: new Date(),
    });

    _setMockFetcher(async (url) => {
      if (url.includes('/orgs/')) {
        return [
          { full_name: 'SAP-samples/a', name: 'a', archived: false, fork: false,
            pushed_at: '2026-01-01T00:00:00Z', stargazers_count: 1, language: 'X',
            topics: [], description: 'a', html_url: 'https://github.com/SAP-samples/a' },
          { full_name: 'SAP-samples/b', name: 'b', archived: false, fork: false,
            pushed_at: '2026-01-01T00:00:00Z', stargazers_count: 1, language: 'X',
            topics: [], description: 'b', html_url: 'https://github.com/SAP-samples/b' },
        ];
      }
      return 'README';
    });

    const summary = await runFetchSamples(null, {
      apiKeyOverride: 'fake-token',
      budgetOverride: 1,
      embed: async () => new Float32Array(384),
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    expect(summary.upserted).toBe(2);
    expect(summary.extracted).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
  });

  it('GITHUB_TOKEN missing aborts cycle', async () => {
    // Clear env vars to ensure no fallback
    const savedGh = process.env.GITHUB_TOKEN;
    const savedTuts = process.env.TUTORIALS_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.TUTORIALS_GITHUB_TOKEN;
    try {
      const summary = await runFetchSamples(null, {
        // apiKeyOverride: undefined → falls through to resolver path
        embed: async () => new Float32Array(384),
        extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
        sinceIsoOverride: '1970-01-01T00:00:00Z',
      });
      expect(summary.errors).toBeGreaterThan(0);
      expect(summary.fetched).toBe(0);
    } finally {
      if (savedGh !== undefined) process.env.GITHUB_TOKEN = savedGh;
      if (savedTuts !== undefined) process.env.TUTORIALS_GITHUB_TOKEN = savedTuts;
    }
  });
});
