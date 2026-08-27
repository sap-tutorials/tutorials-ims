// test/unit/content-delta-flags.test.js
//
// Unit coverage for the ImsConfig-backed Content Option-B delta flags
// (srv/lib/content-delta-flags.js), which replaced the CONTENT_DELTA_* env vars.
//
// Asserts the fail-safe contract that guards a PROD content-serving hot path:
//   - default FALSE when the ImsConfig rows are unset (legacy ContentFiles path)
//   - reads true/false from ImsConfig
//   - synchronous getters return the CACHED value within the TTL (no re-read)
//   - bustContentDeltaFlagsCache() forces the next refresh to re-read the DB
//   - a DB read error keeps the last-known value (never throws, never flips on)

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import cds from '@sap/cds';
import {
  isDeltaWrite, isDeltaRead, isDeltaSkipCarryForward,
  refreshContentDeltaFlags, bustContentDeltaFlagsCache,
  DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY,
} from '../../srv/lib/content-delta-flags.js';

const NS = 'com.sap.developers.ims';
cds.test('serve', '--project', '.', '--in-memory');

let ImsConfig;
const ALL = [DELTA_WRITE_KEY, DELTA_READ_KEY, DELTA_SKIP_CARRYFORWARD_KEY];

async function setKey(key, value) {
  const existing = await SELECT.one.from(ImsConfig).where({ key });
  if (existing) await UPDATE(ImsConfig, existing.ID).set({ value: String(value) });
  else await INSERT.into(ImsConfig).entries({ key, value: String(value) });
}

describe('content-delta-flags (ImsConfig-backed)', () => {
  beforeAll(() => {
    ({ ImsConfig } = cds.entities(NS));
  });

  beforeEach(async () => {
    await DELETE.from(ImsConfig).where({ key: { in: ALL } });
    bustContentDeltaFlagsCache();
  });

  afterAll(() => { bustContentDeltaFlagsCache(); });

  it('defaults to false for every flag when ImsConfig rows are unset', async () => {
    await refreshContentDeltaFlags();
    expect(isDeltaWrite()).toBe(false);
    expect(isDeltaRead()).toBe(false);
    expect(isDeltaSkipCarryForward()).toBe(false);
  });

  it('reads true/false per flag from ImsConfig', async () => {
    await setKey(DELTA_WRITE_KEY, 'true');
    await setKey(DELTA_READ_KEY, 'false');
    await setKey(DELTA_SKIP_CARRYFORWARD_KEY, 'true');
    const snapshot = await refreshContentDeltaFlags();
    expect(snapshot).toEqual({ write: true, read: false, skipCarryForward: true });
    expect(isDeltaWrite()).toBe(true);
    expect(isDeltaRead()).toBe(false);
    expect(isDeltaSkipCarryForward()).toBe(true);
  });

  it('treats non-"true" values (including empty) as false', async () => {
    await setKey(DELTA_WRITE_KEY, 'yes');
    await setKey(DELTA_READ_KEY, '1');
    await setKey(DELTA_SKIP_CARRYFORWARD_KEY, '');
    await refreshContentDeltaFlags();
    expect(isDeltaWrite()).toBe(false);
    expect(isDeltaRead()).toBe(false);
    expect(isDeltaSkipCarryForward()).toBe(false);
  });

  it('is case-insensitive on the string value', async () => {
    await setKey(DELTA_READ_KEY, 'TRUE');
    await refreshContentDeltaFlags();
    expect(isDeltaRead()).toBe(true);
  });

  it('returns the cached value within the TTL (no re-read on DB change)', async () => {
    await setKey(DELTA_READ_KEY, 'true');
    await refreshContentDeltaFlags();
    expect(isDeltaRead()).toBe(true);

    // Change the DB out from under the cache; without a refresh/bust the getter
    // must keep returning the last-known (fresh) value.
    await setKey(DELTA_READ_KEY, 'false');
    expect(isDeltaRead()).toBe(true);
  });

  it('bustContentDeltaFlagsCache() forces the next refresh to re-read the DB', async () => {
    await setKey(DELTA_READ_KEY, 'true');
    await refreshContentDeltaFlags();
    expect(isDeltaRead()).toBe(true);

    await setKey(DELTA_READ_KEY, 'false');
    bustContentDeltaFlagsCache();
    // Cold cache after bust → synchronous getter reports the fail-safe default.
    expect(isDeltaRead()).toBe(false);
    // An explicit refresh re-reads and confirms the DB now says false.
    await refreshContentDeltaFlags();
    expect(isDeltaRead()).toBe(false);
  });

  it('keeps the last-known value when the DB read throws (never flips on/off)', async () => {
    await setKey(DELTA_WRITE_KEY, 'true');
    await refreshContentDeltaFlags();
    expect(isDeltaWrite()).toBe(true);

    // Force the next DB read to fail; the warm cache must survive intact.
    const db = await cds.connect.to('db');
    const spy = vi.spyOn(db, 'run').mockRejectedValueOnce(new Error('boom'));
    const snapshot = await refreshContentDeltaFlags();
    spy.mockRestore();

    expect(snapshot.write).toBe(true); // last-known preserved
    expect(isDeltaWrite()).toBe(true);
  });

  it('a DB read error on a COLD cache leaves the safe default (false)', async () => {
    bustContentDeltaFlagsCache();
    const db = await cds.connect.to('db');
    const spy = vi.spyOn(db, 'run').mockRejectedValueOnce(new Error('boom'));
    await refreshContentDeltaFlags();
    spy.mockRestore();
    expect(isDeltaWrite()).toBe(false);
    expect(isDeltaRead()).toBe(false);
    expect(isDeltaSkipCarryForward()).toBe(false);
  });
});
