// test/unit/jobs/secret-expiry-check.test.js
// Unit tests for srv/jobs/secret-expiry-check.js (#464).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  classifySeverity,
  daysUntil,
  runSecretExpiryCheck,
} from '../../../srv/jobs/secret-expiry-check.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { Secrets } = cds.entities('com.sap.developers.ims');
  await DELETE.from(Secrets);
});

describe('classifySeverity (#464)', () => {
  it('returns null for daysRemaining > 14', () => {
    expect(classifySeverity(15)).toBe(null);
    expect(classifySeverity(100)).toBe(null);
  });

  it('returns INFO for 7 < days <= 14', () => {
    expect(classifySeverity(8)).toBe('INFO');
    expect(classifySeverity(14)).toBe('INFO');
  });

  it('returns WARNING for 0 < days <= 7', () => {
    expect(classifySeverity(1)).toBe('WARNING');
    expect(classifySeverity(7)).toBe('WARNING');
  });

  it('returns CRITICAL for days <= 0 (including negative = expired)', () => {
    expect(classifySeverity(0)).toBe('CRITICAL');
    expect(classifySeverity(-1)).toBe('CRITICAL');
    expect(classifySeverity(-90)).toBe('CRITICAL');
  });

  it('returns null for null input (no expiry tracked)', () => {
    expect(classifySeverity(null)).toBe(null);
    expect(classifySeverity(undefined)).toBe(null);
  });
});

describe('runSecretExpiryCheck (#464)', () => {
  it('returns zeroes for empty Secrets table', async () => {
    const summary = await runSecretExpiryCheck();
    expect(summary).toEqual({
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
      criticalKeys: [],
    });
  });

  it('classifies mixed-severity rows + truncates criticalKeys to 5', async () => {
    const { Secrets } = cds.entities('com.sap.developers.ims');
    const today = new Date();
    const ymd = (offset) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
      return d.toISOString().slice(0, 10);
    };
    // 7 critical rows (test the truncate-to-5), 1 warning, 1 info, 1 silent (>14)
    await INSERT.into(Secrets).entries([
      { key: 'C1', expiresAt: ymd(-10) },
      { key: 'C2', expiresAt: ymd(-5) },
      { key: 'C3', expiresAt: ymd(-1) },
      { key: 'C4', expiresAt: ymd(0) },
      { key: 'C5', expiresAt: ymd(0) },
      { key: 'C6', expiresAt: ymd(0) },
      { key: 'C7', expiresAt: ymd(0) },
      { key: 'W1', expiresAt: ymd(3) },
      { key: 'I1', expiresAt: ymd(10) },
      { key: 'S1', expiresAt: ymd(30) },
    ]);

    const summary = await runSecretExpiryCheck();
    expect(summary.total).toBe(10);
    expect(summary.critical).toBe(7);
    expect(summary.warning).toBe(1);
    expect(summary.info).toBe(1);
    expect(summary.criticalKeys).toHaveLength(5);
  });
});
