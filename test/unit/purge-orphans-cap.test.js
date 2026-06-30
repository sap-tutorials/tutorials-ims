/**
 * Tests for scripts/lib/purge-orphans.ts pure helpers.
 * No HTTP, no DB.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §CLI-mode-cap-design
 */
import { describe, it, expect } from 'vitest';
import { computeOrphans, enforceCap, formatStepSummary } from '../../scripts/lib/purge-orphans.js';

describe('computeOrphans', () => {
  it('returns slugs in server but not in local', () => {
    expect(computeOrphans(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['b']);
  });
  it('returns [] when local is a superset', () => {
    expect(computeOrphans(['a', 'b'], new Set(['a', 'b', 'c']))).toEqual([]);
  });
  it('returns full server set when local is empty', () => {
    expect(computeOrphans(['a', 'b'], new Set())).toEqual(['a', 'b']);
  });
  it('returns [] when server is empty', () => {
    expect(computeOrphans([], new Set(['a']))).toEqual([]);
  });
});

describe('enforceCap', () => {
  it('passes when count below cap', () => {
    expect(enforceCap(22, 50)).toBeNull();
  });
  it('passes at exactly the cap (at-cap is OK; spec "refuse > N")', () => {
    expect(enforceCap(50, 50)).toBeNull();
  });
  it('fails when count exceeds cap by one', () => {
    const msg = enforceCap(51, 50);
    expect(msg).toMatch(/exceeds cap/);
    expect(msg).toMatch(/51 > 50 abs/);
  });
  it('fails when count is very large', () => {
    expect(enforceCap(500, 50)).toMatch(/500 > 50/);
  });
  it('with capAbs=0 only zero orphans passes', () => {
    expect(enforceCap(0, 0)).toBeNull();
    expect(enforceCap(1, 0)).toMatch(/1 > 0 abs/);
  });
});

describe('formatStepSummary', () => {
  it('dry-run mode renders "would have purged" line', () => {
    const out = formatStepSummary({ mode: 'dry-run', serverCount: 1396, orphanCount: 22 });
    expect(out).toMatch(/Dry run/);
    expect(out).toMatch(/would have purged 22 slug/);
  });
  it('committed mode lists soft-deleted + redirect samples', () => {
    const out = formatStepSummary({
      mode: 'committed', serverCount: 1396, orphanCount: 24,
      purged: 21, alreadyInactive: 0, redirected: 3,
      redirectedSamples: ['btp-ea-onboard-04-subm', 'btp-ea-onboard-06-abapm'],
      version: 218
    });
    expect(out).toMatch(/Soft-deleted:\s+21/);
    expect(out).toMatch(/Preserved \(redirect\): 3 — btp-ea-onboard-04-subm/);
    expect(out).toMatch(/Manifest version:\s+218/);
  });
  it('failed mode includes error message', () => {
    const out = formatStepSummary({
      mode: 'failed', serverCount: 1396, orphanCount: 24,
      errorMessage: 'Auth failure — check CONTENT_API_KEY'
    });
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/Auth failure/);
  });
  it('committed mode warns on notFound > 0', () => {
    const out = formatStepSummary({
      mode: 'committed', serverCount: 1, orphanCount: 1,
      purged: 0, notFound: 1, version: 218
    });
    expect(out).toMatch(/⚠️.*Not found.*1.*operator action/);
  });
});
