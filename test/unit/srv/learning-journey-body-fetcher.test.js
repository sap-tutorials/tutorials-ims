// test/unit/srv/learning-journey-body-fetcher.test.js
//
// Phase 4.1 (#447): unit tests for tiered HTML body-fetcher.
// Synthetic HTML fixtures only — no real network call.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchJourneyBody, _setMockFetcher } from '../../../srv/lib/learning-journey-body-fetcher.js';

const TIER1 = readFileSync(join(import.meta.dirname, '__fixtures__/learning-journey-html-tier1.html'), 'utf8');
const TIER2 = readFileSync(join(import.meta.dirname, '__fixtures__/learning-journey-html-tier2.html'), 'utf8');
const TIER3 = readFileSync(join(import.meta.dirname, '__fixtures__/learning-journey-html-tier3.html'), 'utf8');

describe('fetchJourneyBody', () => {
  beforeEach(() => { _setMockFetcher(null); });

  it('tier 1: structured selector returns the .lj-description content', async () => {
    _setMockFetcher(vi.fn().mockResolvedValue(TIER1));
    const result = await fetchJourneyBody('https://learning.sap.com/learning-journeys/test');
    expect(result.source).toBe('structured');
    expect(result.body).toContain('structured description block');
  });

  it('tier 2: no selector, readability falls back to longest paragraphs', async () => {
    _setMockFetcher(vi.fn().mockResolvedValue(TIER2));
    const result = await fetchJourneyBody('https://learning.sap.com/learning-journeys/test');
    expect(result.source).toBe('readability');
    expect(result.body).toContain('CAP service handlers');
    expect(result.body.length).toBeGreaterThan(200);
  });

  it('tier 3: empty body falls back to metadata source with empty string', async () => {
    _setMockFetcher(vi.fn().mockResolvedValue(TIER3));
    const result = await fetchJourneyBody('https://learning.sap.com/learning-journeys/test');
    expect(result.source).toBe('metadata');
    expect(result.body).toBe('');
  });

  it('retries on transient error then succeeds', async () => {
    const mock = vi.fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(TIER1);
    _setMockFetcher(mock);
    const result = await fetchJourneyBody('https://learning.sap.com/learning-journeys/test');
    expect(result.source).toBe('structured');
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('falls back to metadata after 3 failed attempts', async () => {
    const mock = vi.fn().mockRejectedValue(new Error('persistent network failure'));
    _setMockFetcher(mock);
    const result = await fetchJourneyBody('https://learning.sap.com/learning-journeys/test');
    expect(result.source).toBe('metadata');
    expect(result.body).toBe('');
    expect(mock).toHaveBeenCalledTimes(3);
  });
});
