import { describe, it, expect } from 'vitest';
import { deriveConfidence } from '../../srv/lib/provenance-freshness.js';

const DAY = 86400000;
const now = Date.UTC(2026, 8, 11);
const ago = d => new Date(now - d * DAY).toISOString();

describe('deriveConfidence', () => {
  it('unknown when no report', () => {
    expect(deriveConfidence({ report: null, now })).toBe('unknown');
  });
  it('unknown when report not DONE', () => {
    expect(deriveConfidence({ report: { status: 'FAILED', openHighCount: 0, openMediumCount: 0, runAt: ago(1) }, now })).toBe('unknown');
  });
  it('high: fresh scan, no high, no medium', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: ago(10) }, now })).toBe('high');
  });
  it('medium: clean but aging (30-90d)', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: ago(45) }, now })).toBe('medium');
  });
  it('medium: fresh scan but only medium findings', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 0, openMediumCount: 2, runAt: ago(5) }, now })).toBe('medium');
  });
  it('low: any open high finding', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 1, openMediumCount: 0, runAt: ago(1) }, now })).toBe('low');
  });
  it('low: scan older than 90d even if clean', () => {
    expect(deriveConfidence({ report: { status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: ago(120) }, now })).toBe('low');
  });
});
