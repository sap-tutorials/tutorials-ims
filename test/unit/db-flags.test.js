// test/unit/db-flags.test.js
//
// Unit coverage for the generic ImsConfig-backed feature-flag resolver
// (srv/lib/feature-flags/db-flags.js, issue #2060), which replaced the 14
// on/off kind:'env' feature flags. Mirrors content-delta-flags.test.js but the
// fail-safe default is PER-FLAG (the declared registry default), NOT a blanket
// false — a `false-disables` kill switch (e.g. METRICS_ENABLED) stays ON through
// a cold cache or DB error, while a `true-enables` flag (e.g. KG_PAGERANK_ENABLED)
// stays OFF.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import cds from '@sap/cds';
import {
  isFlagEnabled, refreshFeatureFlags, bustFeatureFlagsCache,
  ensureFeatureFlagDefaults, managedFlagKeys, flagMeta,
} from '../../srv/lib/feature-flags/db-flags.js';

const NS = 'com.sap.developers.ims';
cds.test('serve', '--project', '.', '--in-memory');

let ImsConfig;

// Representative flags: two default-true kill switches + two default-false flags.
const METRICS = 'METRICS_ENABLED';           // default true
const MCP_AUTH = 'MCP_AUTH_ENABLED';         // default true
const PAGERANK = 'KG_PAGERANK_ENABLED';      // default false
const FRESHNESS = 'FRESHNESS_SCAN_ENABLED';  // default false

const imsKey = (registryKey) => flagMeta(registryKey).imsConfigKey;

async function setKey(registryKey, value) {
  const key = imsKey(registryKey);
  const existing = await SELECT.one.from(ImsConfig).where({ key });
  if (existing) await UPDATE(ImsConfig, existing.ID).set({ value: String(value) });
  else await INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key, value: String(value) });
}

async function clearAllManaged() {
  const keys = managedFlagKeys().map(imsKey);
  await DELETE.from(ImsConfig).where({ key: { in: keys } });
}

describe('db-flags (ImsConfig-backed generic feature flags, #2060)', () => {
  beforeAll(() => { ({ ImsConfig } = cds.entities(NS)); });

  beforeEach(async () => {
    await clearAllManaged();
    bustFeatureFlagsCache();
  });

  afterAll(() => { bustFeatureFlagsCache(); });

  it('manages the 14 migrated flags but NOT the content.delta.* keys', () => {
    const keys = managedFlagKeys();
    expect(keys).toContain(METRICS);
    expect(keys).toContain(PAGERANK);
    expect(keys.length).toBe(14);
    // content-delta flags keep their own dedicated module.
    const imsKeys = keys.map(imsKey);
    expect(imsKeys).not.toContain('content.delta.write');
    expect(imsKeys).not.toContain('content.delta.read');
    expect(imsKeys).not.toContain('content.delta.skipCarryForward');
  });

  it('returns each flag\'s DECLARED default when its ImsConfig row is unset', async () => {
    await refreshFeatureFlags();
    expect(isFlagEnabled(METRICS)).toBe(true);    // false-disables → default ON
    expect(isFlagEnabled(MCP_AUTH)).toBe(true);
    expect(isFlagEnabled(PAGERANK)).toBe(false);  // true-enables → default OFF
    expect(isFlagEnabled(FRESHNESS)).toBe(false);
  });

  it('reads true/false per flag from ImsConfig', async () => {
    await setKey(METRICS, 'false');   // disable the default-ON kill switch
    await setKey(PAGERANK, 'true');   // enable the default-OFF flag
    await refreshFeatureFlags();
    expect(isFlagEnabled(METRICS)).toBe(false);
    expect(isFlagEnabled(PAGERANK)).toBe(true);
    // Untouched flags still report their declared defaults.
    expect(isFlagEnabled(MCP_AUTH)).toBe(true);
    expect(isFlagEnabled(FRESHNESS)).toBe(false);
  });

  it('is case-insensitive and treats non-"true" values by their string', async () => {
    await setKey(PAGERANK, 'TRUE');
    await setKey(METRICS, 'FALSE');
    await refreshFeatureFlags();
    expect(isFlagEnabled(PAGERANK)).toBe(true);
    expect(isFlagEnabled(METRICS)).toBe(false);
  });

  it('returns the cached value within the TTL (no re-read on DB change)', async () => {
    await setKey(PAGERANK, 'true');
    await refreshFeatureFlags();
    expect(isFlagEnabled(PAGERANK)).toBe(true);
    // Change the DB out from under the fresh cache — getter keeps last-known.
    await setKey(PAGERANK, 'false');
    expect(isFlagEnabled(PAGERANK)).toBe(true);
  });

  it('bustFeatureFlagsCache() drops to cold → declared default until next refresh', async () => {
    await setKey(PAGERANK, 'true');
    await refreshFeatureFlags();
    expect(isFlagEnabled(PAGERANK)).toBe(true);

    await setKey(PAGERANK, 'false');
    bustFeatureFlagsCache();
    // Cold cache → declared default (false for PAGERANK).
    expect(isFlagEnabled(PAGERANK)).toBe(false);
    await refreshFeatureFlags();
    expect(isFlagEnabled(PAGERANK)).toBe(false);
  });

  it('keeps the last-known value when a WARM-cache DB read throws', async () => {
    await setKey(PAGERANK, 'true');
    await refreshFeatureFlags();
    expect(isFlagEnabled(PAGERANK)).toBe(true);

    const db = await cds.connect.to('db');
    const spy = vi.spyOn(db, 'run').mockRejectedValueOnce(new Error('boom'));
    await refreshFeatureFlags();
    spy.mockRestore();
    expect(isFlagEnabled(PAGERANK)).toBe(true); // last-known preserved
  });

  it('a DB read error on a COLD cache leaves each flag at its declared default', async () => {
    bustFeatureFlagsCache();
    const db = await cds.connect.to('db');
    const spy = vi.spyOn(db, 'run').mockRejectedValueOnce(new Error('boom'));
    await refreshFeatureFlags();
    spy.mockRestore();
    expect(isFlagEnabled(METRICS)).toBe(true);   // default ON survives the outage
    expect(isFlagEnabled(PAGERANK)).toBe(false); // default OFF survives the outage
  });

  it('unknown flag key returns false (defensive)', () => {
    expect(isFlagEnabled('NOT_A_REAL_FLAG')).toBe(false);
  });

  it('ensureFeatureFlagDefaults() seeds every absent flag to its declared default', async () => {
    const seeded = await ensureFeatureFlagDefaults();
    expect(seeded.length).toBe(14);
    await refreshFeatureFlags();
    expect(isFlagEnabled(METRICS)).toBe(true);
    expect(isFlagEnabled(MCP_AUTH)).toBe(true);
    expect(isFlagEnabled(PAGERANK)).toBe(false);
    expect(isFlagEnabled(FRESHNESS)).toBe(false);
    // The rows now physically carry the declared default strings.
    const metricsRow = await SELECT.one.from(ImsConfig).where({ key: imsKey(METRICS) });
    expect(metricsRow.value).toBe('true');
    const prRow = await SELECT.one.from(ImsConfig).where({ key: imsKey(PAGERANK) });
    expect(prRow.value).toBe('false');
  });

  it('ensureFeatureFlagDefaults() leaves an admin-set value untouched (override survives deploy)', async () => {
    await setKey(METRICS, 'false'); // admin disabled the default-ON kill switch
    const seeded = await ensureFeatureFlagDefaults();
    expect(seeded).not.toContain(imsKey(METRICS)); // present → not re-seeded
    await refreshFeatureFlags();
    expect(isFlagEnabled(METRICS)).toBe(false); // override preserved
  });

  it('ensureFeatureFlagDefaults() is idempotent (no duplicate rows on re-run)', async () => {
    await ensureFeatureFlagDefaults();
    const second = await ensureFeatureFlagDefaults();
    expect(second).toEqual([]);
    const keys = managedFlagKeys().map(imsKey);
    const rows = await SELECT.from(ImsConfig).where({ key: { in: keys } });
    expect(rows.length).toBe(14);
  });
});
