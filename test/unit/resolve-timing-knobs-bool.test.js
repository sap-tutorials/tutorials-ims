/**
 * Unit tests for type-aware resolveTimingKnobs in contributor-notifications.js (#622).
 *
 * Task 4: extends TIMING_KNOBS with bool support + 3 new keys:
 *   - useDigestNotifications (bool, default true)
 *   - lastChanceMinLevel (int, default 3)
 *   - lastChanceDormancyDays (int, default 60)
 *
 * Bool knobs accept only "true"/"false" (case-insensitive); anything else
 * WARNs and falls back to default. Missing rows fall back silently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';
import { resolveTimingKnobs } from '../../srv/lib/contributor-notifications.js';

const DB = './db/schema.cds';

describe('resolveTimingKnobs — bool + new int knobs', () => {
  let warnSpy;

  beforeEach(async () => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cds.deploy(DB).to('sqlite::memory:');
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    // Drop the in-memory connection so each test gets a fresh DB. Mirrors the
    // defensive pattern in notification-timing-knobs.test.js — without this the
    // global cds.db singleton can leak rows between tests when Vitest reuses
    // the same worker process.
    if (cds.db) {
      try { await cds.disconnect(); } catch { /* best-effort */ }
    }
  });

  async function seed(rows) {
    const { ImsConfig } = cds.entities('com.sap.developers.ims');
    await DELETE.from(ImsConfig);
    for (const r of rows) {
      await INSERT.into(ImsConfig).entries({ key: r.key, value: r.value });
    }
  }

  it('useDigestNotifications "true" → true', async () => {
    await seed([{ key: 'useDigestNotifications', value: 'true' }]);
    const k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(true);
  });

  it('useDigestNotifications "false" → false', async () => {
    await seed([{ key: 'useDigestNotifications', value: 'false' }]);
    const k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(false);
  });

  it('useDigestNotifications "TRUE" / "False" (case-insensitive)', async () => {
    await seed([{ key: 'useDigestNotifications', value: 'TRUE' }]);
    let k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(true);
    await seed([{ key: 'useDigestNotifications', value: 'False' }]);
    k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(false);
  });

  it('useDigestNotifications "yes" → default true + WARN', async () => {
    await seed([{ key: 'useDigestNotifications', value: 'yes' }]);
    const k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(true); // default
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('useDigestNotifications'));
  });

  it('missing row → default true + NO warn', async () => {
    await seed([]);
    const k = await resolveTimingKnobs();
    expect(k.useDigest).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('lastChanceMinLevel + lastChanceDormancyDays default to 3 / 60', async () => {
    await seed([]);
    const k = await resolveTimingKnobs();
    expect(k.lastChanceMinLevel).toBe(3);
    expect(k.lastChanceDormancyDays).toBe(60);
  });

  it('lastChanceDormancyDays negative → WARN + default 60', async () => {
    await seed([{ key: 'lastChanceDormancyDays', value: '-10' }]);
    const k = await resolveTimingKnobs();
    expect(k.lastChanceDormancyDays).toBe(60);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lastChanceDormancyDays'));
  });

  it('existing knobs still work', async () => {
    await seed([{ key: 'staleDaysThreshold', value: '45' }]);
    const k = await resolveTimingKnobs();
    expect(k.staleDays).toBe(45);
  });
});
