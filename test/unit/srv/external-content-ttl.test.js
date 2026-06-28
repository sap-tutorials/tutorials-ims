import { describe, it, expect } from 'vitest';
import { isWithinTTL, PER_TYPE_TTL_DAYS } from '../../../srv/lib/external-content-ttl.js';

describe('PER_TYPE_TTL_DAYS', () => {
  it('has the 4.1-required entries', () => {
    expect(PER_TYPE_TTL_DAYS['learning-journey']).toBe(365);
    expect(PER_TYPE_TTL_DAYS['trial']).toBe(null);  // date-aware
  });
});

describe('isWithinTTL', () => {
  it('returns true for fresh learning-journey (within 365d)', () => {
    const now = new Date();
    const lastSeen = new Date(now.getTime() - 1000);  // 1 second ago
    expect(isWithinTTL('learning-journey', lastSeen)).toBe(true);
  });

  it('returns false for stale learning-journey (past 365d)', () => {
    const lastSeen = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000);
    expect(isWithinTTL('learning-journey', lastSeen)).toBe(false);
  });

  it('returns false for NaN lastSeenAt', () => {
    expect(isWithinTTL('learning-journey', 'not-a-date')).toBe(false);
  });

  it('returns false for null lastSeenAt', () => {
    expect(isWithinTTL('learning-journey', null)).toBe(false);
  });

  it('trial: returns true when endDate is in future', () => {
    const lastSeen = new Date();
    const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(isWithinTTL('trial', lastSeen, endDate)).toBe(true);
  });

  it('trial: returns false when endDate is past + 30d grace', () => {
    const lastSeen = new Date();
    const endDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(isWithinTTL('trial', lastSeen, endDate)).toBe(false);
  });

  it('trial: returns true when endDate is past but within 30d grace', () => {
    const lastSeen = new Date();
    const endDate = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    expect(isWithinTTL('trial', lastSeen, endDate)).toBe(true);
  });

  it('unknown content type falls back to false', () => {
    expect(isWithinTTL('unknown-type', new Date())).toBe(false);
  });
});
