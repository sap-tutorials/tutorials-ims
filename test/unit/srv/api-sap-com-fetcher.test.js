// test/unit/srv/api-sap-com-fetcher.test.js
//
// Phase 4.5 (#746) Task 1: unit tests for the api.sap.com corpus fetcher.
//
// PROBE_FAILURE branch (§1.2-B) — the probe at
// docs/superpowers/plans/2026-06-29-746-api-sap-com-probe-results.md
// concluded no usable public discovery endpoint exists. Fetcher operates
// in YAML-only mode. _setMockFetcher remains as a test seam for a future
// PROBE_SUCCESS retrofit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchApiSapComCorpus,
  _setMockFetcher,
  _resetForTests,
} from '../../../srv/lib/api-sap-com-fetcher.js';

describe('api-sap-com-fetcher (YAML-only mode)', () => {
  beforeEach(() => {
    _setMockFetcher(null);
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  it('returns YAML rows when no HTTP mock is set (default mode)', async () => {
    const yamlRows = [
      {
        sourceId: 'YAML_1',
        title: 'API 1',
        url: 'https://api.sap.com/y1',
        description: 'x',
        category: 'CAP',
        apiType: 'reference',
      },
    ];
    const rows = await fetchApiSapComCorpus({ yamlFallbackLoader: async () => yamlRows });
    expect(rows).toEqual(yamlRows);
  });

  it('skips packages whose sourceId is in seenSourceIds (YAML mode)', async () => {
    const yamlRows = [
      { sourceId: 'A', title: 'A', url: 'https://api.sap.com/a', description: 'x', category: 'X', apiType: 'reference' },
      { sourceId: 'B', title: 'B', url: 'https://api.sap.com/b', description: 'x', category: 'X', apiType: 'reference' },
    ];
    const rows = await fetchApiSapComCorpus({
      seenSourceIds: new Set(['A']),
      yamlFallbackLoader: async () => yamlRows,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe('B');
  });

  it('limits results to `limit` parameter', async () => {
    const manyRows = Array.from({ length: 20 }, (_, i) => ({
      sourceId: `R${i}`,
      title: `R${i}`,
      url: `https://api.sap.com/r${i}`,
      description: 'x',
      category: 'X',
      apiType: 'reference',
    }));
    const rows = await fetchApiSapComCorpus({ limit: 5, yamlFallbackLoader: async () => manyRows });
    expect(rows).toHaveLength(5);
  });

  it('HTTP probe stub is documented for future retrofit', () => {
    // YAML-only mode: this test asserts that _setMockFetcher exists
    // (so a future PROBE_SUCCESS retrofit can use it without rewriting the contract).
    expect(typeof _setMockFetcher).toBe('function');
  });
});
