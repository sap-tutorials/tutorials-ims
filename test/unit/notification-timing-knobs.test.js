/**
 * Unit tests for resolveTimingKnobs in contributor-notifications.js (#545).
 *
 * The 3 knobs (staleDaysThreshold, resendIntervalDays, maxNotificationLevel)
 * are read from ImsConfig with hardcoded defaults as fallback. Invalid values
 * (non-numeric, missing rows) fall back to defaults and emit a WARN with the
 * bad value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';

// In-memory CDS bootstrap. db/schema.cds carries ImsConfig.
import { resolveTimingKnobs } from '../../srv/lib/contributor-notifications.js';

const DB = './db/schema.cds';

beforeEach(async () => {
  await cds.deploy(DB).to('sqlite::memory:');
});

afterEach(async () => {
  // Drop the in-memory connection so each test gets a fresh DB. Without this,
  // the global cds.db singleton can leak ImsConfig rows between tests when
  // Vitest reuses the same worker process. Same defensive pattern as other
  // unit tests in this project that touch CDS via cds.deploy().
  if (cds.db) {
    try { await cds.disconnect(); } catch { /* best-effort */ }
  }
});

async function seedImsConfig(rows) {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  await DELETE.from(ImsConfig);
  for (const [key, value] of Object.entries(rows)) {
    await INSERT.into(ImsConfig).entries({ key, value });
  }
}

describe('resolveTimingKnobs', () => {
  it('returns DB values when all three rows are valid integers', async () => {
    await seedImsConfig({
      staleDaysThreshold: '120',
      resendIntervalDays: '14',
      maxNotificationLevel: '5',
    });
    const knobs = await resolveTimingKnobs();
    expect(knobs).toEqual({ staleDays: 120, resendIntervalDays: 14, maxLevel: 5 });
  });

  it('falls back to hardcoded defaults when rows are missing', async () => {
    await seedImsConfig({});
    const knobs = await resolveTimingKnobs();
    expect(knobs).toEqual({ staleDays: 90, resendIntervalDays: 30, maxLevel: 3 });
  });

  it('falls back to defaults and logs WARN on unparseable values', async () => {
    await seedImsConfig({
      staleDaysThreshold: 'forty-two',
      resendIntervalDays: '14',
      maxNotificationLevel: '',
    });
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));

    const knobs = await resolveTimingKnobs();

    console.warn = origWarn;
    expect(knobs.staleDays).toBe(90);
    expect(knobs.resendIntervalDays).toBe(14);
    expect(knobs.maxLevel).toBe(3);
    expect(warns.some(w => w.includes('staleDaysThreshold') && w.includes('forty-two'))).toBe(true);
    expect(warns.some(w => w.includes('maxNotificationLevel'))).toBe(false);  // empty string is silent default — same as missing row
  });

  it('rejects negative or zero values, falling back to default', async () => {
    await seedImsConfig({
      staleDaysThreshold: '-5',
      resendIntervalDays: '0',
      maxNotificationLevel: '3',
    });
    const knobs = await resolveTimingKnobs();
    expect(knobs.staleDays).toBe(90);
    expect(knobs.resendIntervalDays).toBe(30);
    expect(knobs.maxLevel).toBe(3);
  });
});
