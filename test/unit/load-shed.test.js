// test/unit/load-shed.test.js
// Unit coverage for the origin-side load-shedding guard (PR4, #2271): the
// in-flight concurrency guard (acquireServeSlot) and its numeric config
// resolver. Pure logic — no cds runtime. The config resolver is primed
// deterministically via _primeForTest so the guard tests control the ceiling
// without a DB, and the flag is toggled via db-flags' test seams.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';

// Wrap the settings resolver in a vi.fn that delegates to the real logic, so a
// single test can force it to reject (proving the guard's own fail-open)
// without disturbing the config-defaulting tests. vi.mock is hoisted and
// applies to load-shed.js's own static import too.
vi.mock('../../srv/lib/runtime-config/load-shed-settings.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, resolveLoadShedConfig: vi.fn(actual.resolveLoadShedConfig) };
});

import {
  acquireServeSlot,
  _inFlightForTest,
  _resetForTest as _resetGuard,
} from '../../srv/lib/load-shed.js';
import {
  resolveLoadShedConfig,
  DEFAULT_CONFIG,
  _resetForTest as _resetCfg,
  _primeForTest as _primeCfg,
} from '../../srv/lib/runtime-config/load-shed-settings.js';
import { __setFlagForTest, __resetFlagsForTest } from '../../srv/lib/feature-flags/db-flags.js';

describe('load-shed: acquireServeSlot', () => {
  beforeEach(() => {
    _resetGuard();
    _resetCfg();
    __resetFlagsForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetGuard();
    _resetCfg();
    __resetFlagsForTest();
  });

  it('is inert when the flag is off: admits without counting', async () => {
    __setFlagForTest('LOADSHED_ENABLED', false);
    _primeCfg({ maxConcurrent: 1 }); // even a ceiling of 1 must not bite
    const a = await acquireServeSlot();
    const b = await acquireServeSlot();
    expect(a.admitted).toBe(true);
    expect(b.admitted).toBe(true);
    expect(_inFlightForTest()).toBe(0); // nothing counted while off
  });

  it('admits below the ceiling and increments the in-flight count', async () => {
    __setFlagForTest('LOADSHED_ENABLED', true);
    _primeCfg({ maxConcurrent: 2 });
    const a = await acquireServeSlot();
    expect(a.admitted).toBe(true);
    expect(_inFlightForTest()).toBe(1);
    const b = await acquireServeSlot();
    expect(b.admitted).toBe(true);
    expect(_inFlightForTest()).toBe(2);
  });

  it('sheds at the ceiling with a Retry-After hint and takes no slot', async () => {
    __setFlagForTest('LOADSHED_ENABLED', true);
    _primeCfg({ maxConcurrent: 2, retryAfterSeconds: 7 });
    await acquireServeSlot();
    await acquireServeSlot(); // at ceiling now
    const shed = await acquireServeSlot();
    expect(shed.admitted).toBe(false);
    expect(shed.retryAfter).toBe(7);
    expect(_inFlightForTest()).toBe(2); // shed request did NOT take a slot
  });

  it('release() decrements the count and frees a slot for the next request', async () => {
    __setFlagForTest('LOADSHED_ENABLED', true);
    _primeCfg({ maxConcurrent: 1 });
    const a = await acquireServeSlot();
    expect((await acquireServeSlot()).admitted).toBe(false); // full
    a.release();
    expect(_inFlightForTest()).toBe(0);
    expect((await acquireServeSlot()).admitted).toBe(true); // slot freed
  });

  it('release() is idempotent — a double call cannot under-count', async () => {
    __setFlagForTest('LOADSHED_ENABLED', true);
    _primeCfg({ maxConcurrent: 4 });
    const a = await acquireServeSlot();
    const b = await acquireServeSlot();
    expect(_inFlightForTest()).toBe(2);
    a.release();
    a.release(); // second call is a no-op
    expect(_inFlightForTest()).toBe(1); // only b remains, not -1 or 0
    b.release();
    expect(_inFlightForTest()).toBe(0);
  });

  it('fails open when config resolution throws: admits as a no-op', async () => {
    __setFlagForTest('LOADSHED_ENABLED', true);
    // resolveLoadShedConfig never throws on its own (it catches read errors),
    // so force it to reject once to exercise the guard's OWN fail-open catch.
    resolveLoadShedConfig.mockRejectedValueOnce(new Error('cfg down'));
    const r = await acquireServeSlot();
    expect(r.admitted).toBe(true);
    expect(_inFlightForTest()).toBe(0); // no slot taken on the fail-open path
    r.release(); // must be a safe no-op
    expect(_inFlightForTest()).toBe(0);
  });
});

describe('load-shed-settings: resolveLoadShedConfig', () => {
  beforeEach(() => {
    _resetCfg();
    vi.spyOn(cds.connect, 'to').mockRejectedValue(new Error('no db in unit'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetCfg();
  });

  it('falls back to hardcoded defaults on read failure', async () => {
    const cfg = await resolveLoadShedConfig();
    expect(cfg.maxConcurrent).toBe(DEFAULT_CONFIG.maxConcurrent);
    expect(cfg.retryAfterSeconds).toBe(DEFAULT_CONFIG.retryAfterSeconds);
  });

  it('returns a mutable clone, not the frozen default', async () => {
    const cfg = await resolveLoadShedConfig();
    expect(() => {
      cfg.maxConcurrent = 999;
    }).not.toThrow();
    expect(DEFAULT_CONFIG.maxConcurrent).not.toBe(999);
  });
});
