import { describe, it, expect } from 'vitest';
import { computePublishPlan, validateFlagCombo } from '../publish-content.js';

describe('validateFlagCombo', () => {
  it('rejects --force + --heal', () => {
    expect(() => validateFlagCombo({ force: true, heal: true, verifyOnly: false }))
      .toThrow(/mutually exclusive/i);
  });
  it('rejects --verify-only + --heal', () => {
    expect(() => validateFlagCombo({ force: false, heal: true, verifyOnly: true }))
      .toThrow(/mutually exclusive/i);
  });
  it('accepts a single mode flag', () => {
    expect(() => validateFlagCombo({ force: true,  heal: false, verifyOnly: false })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: true,  verifyOnly: false })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: true  })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: false })).not.toThrow();
  });
});

describe('computePublishPlan', () => {
  const local = new Map<string, string>([
    ['a', 'h_a'], ['b', 'h_b'], ['c', 'h_c'],
  ]);

  it('force mode publishes every local slug', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a' }, mode: 'force' });
    expect(out.targetSlugs.sort()).toEqual(['a', 'b', 'c']);
  });
  it('delta mode publishes only changed/missing slugs', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a', b: 'STALE' }, mode: 'delta' });
    expect(out.targetSlugs.sort()).toEqual(['b', 'c']);
  });
  it('heal mode is the same set as delta', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a', b: 'STALE' }, mode: 'heal' });
    expect(out.targetSlugs.sort()).toEqual(['b', 'c']);
  });
});
