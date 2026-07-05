// test/unit/kg-community-fingerprint.test.js
//
// Unit tests for the fingerprint helper used by both the promote handler
// and the nightly job (#985). The invariant that matters: fingerprint
// depends on the tutorial-slug SET, not the input order — so a curator
// promoting a community after a Louvain re-run (which shuffles both the
// row order and the numeric communityId) gets the same fingerprint as
// the original promotion for the same tutorial cluster.

import { describe, it, expect } from 'vitest';
import { computeKgCommunityFingerprint } from '../../srv/lib/kg-community-fingerprint.js';

describe('computeKgCommunityFingerprint', () => {
  it('produces a 64-char lowercase hex digest', () => {
    const fp = computeKgCommunityFingerprint(['a', 'b', 'c']);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across input order — the core #985 invariant', () => {
    const fpA = computeKgCommunityFingerprint(['alpha', 'beta', 'gamma']);
    const fpB = computeKgCommunityFingerprint(['gamma', 'alpha', 'beta']);
    const fpC = computeKgCommunityFingerprint(['beta', 'gamma', 'alpha']);
    expect(fpA).toBe(fpB);
    expect(fpB).toBe(fpC);
  });

  it('is sensitive to set membership — dropping any slug changes the hash', () => {
    const full = computeKgCommunityFingerprint(['alpha', 'beta', 'gamma']);
    const drop = computeKgCommunityFingerprint(['alpha', 'beta']);
    expect(full).not.toBe(drop);
  });

  it('is sensitive to slug spelling — case-sensitive, no trimming', () => {
    const lower = computeKgCommunityFingerprint(['alpha']);
    const upper = computeKgCommunityFingerprint(['ALPHA']);
    expect(lower).not.toBe(upper);
  });

  it('rejects empty input — callers must gate promotion on ≥1 tutorial', () => {
    expect(() => computeKgCommunityFingerprint([])).toThrow(TypeError);
    expect(() => computeKgCommunityFingerprint(null)).toThrow(TypeError);
    expect(() => computeKgCommunityFingerprint(undefined)).toThrow(TypeError);
  });

  it('rejects non-string entries', () => {
    expect(() => computeKgCommunityFingerprint(['a', null])).toThrow(TypeError);
    expect(() => computeKgCommunityFingerprint(['a', 42])).toThrow(TypeError);
    expect(() => computeKgCommunityFingerprint(['a', ''])).toThrow(TypeError);
  });

  it('does not mutate the input array', () => {
    const slugs = ['zebra', 'apple', 'mango'];
    computeKgCommunityFingerprint(slugs);
    expect(slugs).toEqual(['zebra', 'apple', 'mango']);
  });
});
