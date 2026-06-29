// test/unit/srv/fetch-api-docs-job.test.js
//
// Phase 4.5 (#746) PR-2: cron orchestration test for api.sap.com api-docs.
// Mirrors test/unit/srv/fetch-videos-job.test.js with the single-predicate
// shape: only ApiDocConceptLinks (no service-junction sibling).

import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

let runFetchApiDocs;
let _setMockFetcher;
let _resetForTests;

function vec(...nums) { return new Float32Array(nums); }
function buf(...nums) {
  const f = vec(...nums);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

describe('fetch-api-docs-job — merge-on-write (#707) + crash-safety (#708)', () => {
  beforeAll(async () => {
    await cds.deploy([
      path.join(process.cwd(), 'db'),
      path.join(process.cwd(), 'srv'),
    ]).to('sqlite::memory:');

    ({ runFetchApiDocs } = await import('../../../srv/jobs/fetch-api-docs-job.js'));
    ({ _setMockFetcher, _resetForTests } = await import('../../../srv/lib/api-sap-com-fetcher.js'));
  });

  afterAll(async () => {
    await cds.disconnect();
  });

  beforeEach(async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims');
    const { ApiDocs, ApiDocConceptLinks } =
      cds.entities('com.sap.developers.ims.external');
    await DELETE.from(ApiDocConceptLinks);
    await DELETE.from(ApiDocs);
    await DELETE.from(Concepts);

    const now = new Date().toISOString();
    await INSERT.into(Concepts).entries({
      slug: 'cap-cqn',
      name: 'CAP CQN',
      description: 'desc',
      embedding: buf(1, 0, 0, 0),
      status: 'ACTIVE',
      publishedAt: now,
      publishedBy: 'admin@sap.com',
    });

    _resetForTests();
    _setMockFetcher(null);
  });

  it('MAX-or-abort gate fires when ApiDocs is empty', async () => {
    _setMockFetcher(async () => { throw new Error('should not be reached'); });
    const summary = await runFetchApiDocs({
      embed: async () => [vec(0, 0, 0, 1)],
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
    });
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.fetched).toBe(0);
    expect(summary.upserted).toBe(0);
  });

  it('exact-match concept resolves end-to-end', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    // Seed an existing apiDoc so MAX(lastSeenAt) is set (avoid abort).
    await INSERT.into(ApiDocs).entries({
      slug: 'ad-existing', title: 'Existing', description: 'pre-seed',
      url: 'https://api.sap.com/x', sourceId: 'EXISTING', contentHash: 'old-hash',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      category: 'CAP', apiType: 'reference',
    });

    _setMockFetcher(async () => ({
      items: [{
        sourceId: 'CAP_CQN_Reference', title: 'CAP CQN Reference',
        description: 'fresh content', url: 'https://api.sap.com/cqn',
        category: 'CAP', apiType: 'reference',
      }],
      nextPage: null,
    }));

    const extractFn = vi.fn().mockResolvedValue({
      concepts: [{ slug: 'cap-cqn', name: 'CAP CQN', confidence: 0.95 }],
      promptTokens: 100, completionTokens: 20,
    });
    const embed = vi.fn();

    const summary = await runFetchApiDocs({
      embed, extractFn, sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    expect(summary.errors).toBe(0);
    expect(summary.upserted).toBeGreaterThanOrEqual(1);
    expect(summary.linksWritten).toBe(1);
    expect(embed).not.toHaveBeenCalled();
  });

  it('merge+mint+dedup-conceptId works', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(ApiDocs).entries({
      slug: 'ad-seed', title: 'seed', description: 'x',
      url: 'https://api.sap.com/seed', sourceId: 'SEED', contentHash: 'h',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      category: 'X', apiType: 'reference',
    });

    _setMockFetcher(async () => ({
      items: [{
        sourceId: 'NEW_API', title: 'New API', description: 'fresh',
        url: 'https://api.sap.com/new', category: 'X', apiType: 'reference',
      }],
      nextPage: null,
    }));

    const extractFn = vi.fn().mockResolvedValue({
      concepts: [
        { slug: 'cap-cqn', name: 'CAP CQN', confidence: 0.95 },            // exact
        { slug: 'cap-cqn-near-dup', name: 'CAP CQN (near-dup)', confidence: 0.85 }, // near-dup → merge
        { slug: 'odata-v4', name: 'OData v4', confidence: 0.90 },          // novel mint
      ],
      promptTokens: 100, completionTokens: 20,
    });

    const embed = vi.fn(async ([name]) => {
      if (name === 'CAP CQN (near-dup)') return [vec(0.99, 0.01, 0, 0)];
      if (name === 'OData v4') return [vec(0, 0, 1, 0)];
      throw new Error(`unexpected embed: ${name}`);
    });

    const summary = await runFetchApiDocs({
      embed, extractFn, sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    expect(summary.errors).toBe(0);
    expect(summary.mergedAtExtract).toBe(1);
    expect(summary.mintedAtExtract).toBe(1);
    // dedup-by-conceptId: cap-cqn (exact) + cap-cqn-near-dup (merged → same conceptId) collapse
    expect(summary.linksWritten).toBe(2);
  });

  it('lastExtractedHash skip on second consecutive run', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(ApiDocs).entries({
      slug: 'ad-seed-noskip', title: 'seed', description: 'x',
      url: 'https://api.sap.com/seed-noskip', sourceId: 'SEED2', contentHash: 'h',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      category: 'X', apiType: 'reference',
    });

    _setMockFetcher(async () => ({
      items: [{
        sourceId: 'STABLE_API', title: 'Stable', description: 'same',
        url: 'https://api.sap.com/stable', category: 'X', apiType: 'reference',
      }],
      nextPage: null,
    }));

    const opts = {
      embed: async () => [vec(0, 0, 0, 1)],
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    };

    await runFetchApiDocs(opts);
    _resetForTests();
    _setMockFetcher(async () => ({
      items: [{
        sourceId: 'STABLE_API', title: 'Stable', description: 'same',
        url: 'https://api.sap.com/stable', category: 'X', apiType: 'reference',
      }],
      nextPage: null,
    }));
    const second = await runFetchApiDocs(opts);
    expect(second.skippedNoChange).toBeGreaterThanOrEqual(1);
    expect(second.extracted).toBe(0);
  });

  it('budget exhausted: budgetOverride=1 with 2 packages', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(ApiDocs).entries({
      slug: 'ad-bootseed', title: 'bootseed', description: 'x',
      url: 'https://api.sap.com/bootseed', sourceId: 'BOOTSEED', contentHash: 'h',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      category: 'X', apiType: 'reference',
    });

    _setMockFetcher(async () => ({
      items: [
        { sourceId: 'A', title: 'A', description: 'x', url: 'https://api.sap.com/a', category: 'X', apiType: 'reference' },
        { sourceId: 'B', title: 'B', description: 'x', url: 'https://api.sap.com/b', category: 'X', apiType: 'reference' },
      ],
      nextPage: null,
    }));

    const summary = await runFetchApiDocs({
      budgetOverride: 1,
      embed: async () => [vec(0, 0, 0, 1)],
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    expect(summary.upserted).toBe(2);                          // upsert is NOT budget-gated
    expect(summary.extracted).toBe(1);                          // extract IS budget-gated
    expect(summary.budgetExhausted).toBe(true);
  });

  it('YAML-only fallback mode works when http throws', async () => {
    const { ApiDocs } = cds.entities('com.sap.developers.ims.external');
    await INSERT.into(ApiDocs).entries({
      slug: 'ad-yamlseed', title: 'YAMLseed', description: 'pre',
      url: 'https://api.sap.com/yamlseed', sourceId: 'YAMLSEED', contentHash: 'h',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      category: 'X', apiType: 'reference',
    });

    _setMockFetcher(async () => { throw new Error('http down'); });

    const summary = await runFetchApiDocs({
      yamlFallbackLoaderOverride: async () => [{
        sourceId: 'YAMLSRC', title: 'From YAML', description: 'from yaml',
        url: 'https://api.sap.com/from-yaml', category: 'X', apiType: 'reference',
      }],
      embed: async () => [vec(0, 0, 0, 1)],
      extractFn: async () => ({ concepts: [], promptTokens: 0, completionTokens: 0 }),
      sinceIsoOverride: '1970-01-01T00:00:00Z',
    });

    expect(summary.errors).toBe(0);
    expect(summary.fetched).toBe(1);
  });
});
