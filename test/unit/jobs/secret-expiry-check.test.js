// test/unit/jobs/secret-expiry-check.test.js
// Unit tests for srv/jobs/secret-expiry-check.js (#464 + #1018).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import {
  classifySeverity,
  daysUntil,
  runSecretExpiryCheck,
} from '../../../srv/jobs/secret-expiry-check.js';
// #1018 — the cron now probes credstore presence per row via a DI param
// (`deps.checkSecretPresence`). Tests below stub the probe directly on
// the call; no module state to reset here for the pre-#1018 tests. The
// dedicated #1018 describe block asserts the new "missing value" path.

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
    const summary = await runSecretExpiryCheck({
      // Cron falls through to the probe for zero rows anyway; provide
      // a no-op stub to be explicit and avoid any accidental network in
      // vitest.
      checkSecretPresence: async () => true,
    });
    expect(summary).toEqual({
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
      missingValues: 0,
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
    // Prime presence=true via the DI seam so classification falls through
    // to expiry logic (this describe pre-dates #1018 and asserts the same
    // contract as before).
    const summary = await runSecretExpiryCheck({
      checkSecretPresence: async () => true,
    });
    expect(summary.total).toBe(10);
    expect(summary.critical).toBe(7);
    expect(summary.warning).toBe(1);
    expect(summary.info).toBe(1);
    expect(summary.missingValues).toBe(0);
    expect(summary.criticalKeys).toHaveLength(5);
  });
});

// #1018 — presence-probe tier. The cron now classifies any row whose
// credstore value is null/unreachable as CRITICAL with reason='missing-value',
// regardless of expiresAt. Regression canary for the 2026-07-06
// CONTENT_API_KEY silent-drift outage.
describe('runSecretExpiryCheck presence probe (#1018)', () => {
  it('missing-value rows count as CRITICAL and populate missingValues', async () => {
    const { Secrets } = cds.entities('com.sap.developers.ims');
    // Two rows, no expiresAt on either — the pre-#1018 cron would have
    // skipped both entirely (the WHERE clause filtered on `expiresAt !=
    // null`). Post-#1018 they must surface as CRITICAL missing-value.
    await INSERT.into(Secrets).entries([
      { key: 'MISSING_1', expiresAt: null },
      { key: 'MISSING_2', expiresAt: null },
    ]);
    const summary = await runSecretExpiryCheck({
      checkSecretPresence: async () => false,
    });
    expect(summary.total).toBe(2);
    expect(summary.missingValues).toBe(2);
    expect(summary.critical).toBe(2);
    expect(summary.criticalKeys).toEqual(expect.arrayContaining(['MISSING_1', 'MISSING_2']));
  });

  it('missing-value takes precedence over expiry classification', async () => {
    // A row with expiresAt 30 days out (silent under old rules) is
    // CRITICAL if the value is missing — the missing state is worse
    // than any expiry state.
    const { Secrets } = cds.entities('com.sap.developers.ims');
    const today = new Date();
    const in30 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 30)).toISOString().slice(0, 10);
    await INSERT.into(Secrets).entries({ key: 'SILENT_BUT_MISSING', expiresAt: in30 });
    const summary = await runSecretExpiryCheck({
      checkSecretPresence: async () => false,
    });
    expect(summary.total).toBe(1);
    expect(summary.missingValues).toBe(1);
    expect(summary.critical).toBe(1);
    expect(summary.info).toBe(0);
  });

  it('mixed present + missing: missing-value counted alongside expiry buckets', async () => {
    const { Secrets } = cds.entities('com.sap.developers.ims');
    const today = new Date();
    const ymd = (offset) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)).toISOString().slice(0, 10);
    await INSERT.into(Secrets).entries([
      { key: 'HAS_VALUE_EXPIRING', expiresAt: ymd(-1) },  // CRITICAL by expiry
      { key: 'MISSING_HEALTHY_EXPIRY', expiresAt: ymd(30) },  // CRITICAL by missing-value
      { key: 'HAS_VALUE_HEALTHY', expiresAt: ymd(30) },  // silent
    ]);
    const missingOnly = new Set(['MISSING_HEALTHY_EXPIRY']);
    const summary = await runSecretExpiryCheck({
      checkSecretPresence: async (alias) => !missingOnly.has(alias),
    });
    expect(summary.total).toBe(3);
    expect(summary.missingValues).toBe(1);
    expect(summary.critical).toBe(2);  // both expired-with-value AND missing-value
    expect(summary.criticalKeys).toEqual(expect.arrayContaining(['HAS_VALUE_EXPIRING', 'MISSING_HEALTHY_EXPIRY']));
  });
});
