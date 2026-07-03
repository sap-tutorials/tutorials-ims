import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as metrics from '../../srv/lib/metrics.js';
import { installDbWrap, _resetForTest as _resetWrap } from '../../srv/lib/metrics-db-wrap.js';

// Build a mock `cds` module surface: cds.db.run + cds.db.tx with runtime-like
// semantics — db.tx(fn) invokes fn with a tx object exposing tx.run(...) and
// returns a Promise resolving to fn's result.
function makeMockCds({ runImpl, txRunImpl } = {}) {
  const defaultRun = runImpl || (async () => 'ran');
  const defaultTxRun = txRunImpl || (async () => 'tx-ran');
  const db = {
    run: async (...args) => defaultRun(...args),
    tx: async (a, b) => {
      const fn = typeof a === 'function' ? a : b;
      // First positional (`a`) is ignored here — the wrapper preserves it via
      // originalDbTx(firstArg, wrappedFn), and this mock only observes fn.
      const tx = { run: async (...runArgs) => defaultTxRun(...runArgs) };
      return await fn(tx);
    },
  };
  return { db, log: () => ({ info: () => {}, warn: () => {}, error: () => {} }) };
}

describe('metrics-db-wrap installDbWrap (#909)', () => {
  const originalMetricsEnabled = process.env.METRICS_ENABLED;
  const originalDbWrap = process.env.METRICS_DB_WRAP;

  beforeEach(() => {
    _resetWrap();
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
    process.env.METRICS_DB_WRAP = 'true';
  });

  afterEach(() => {
    _resetWrap();
    process.env.METRICS_ENABLED = originalMetricsEnabled;
    process.env.METRICS_DB_WRAP = originalDbWrap;
  });

  it('does NOT install when METRICS_DB_WRAP !== "true"', () => {
    process.env.METRICS_DB_WRAP = 'false';
    const cds = makeMockCds();
    const originalRun = cds.db.run;
    expect(installDbWrap(cds)).toBe(false);
    expect(cds.db.run).toBe(originalRun);
  });

  it('does NOT install when METRICS_ENABLED === "false" (kill-switch)', () => {
    process.env.METRICS_ENABLED = 'false';
    process.env.METRICS_DB_WRAP = 'true';
    const cds = makeMockCds();
    const originalRun = cds.db.run;
    expect(installDbWrap(cds)).toBe(false);
    expect(cds.db.run).toBe(originalRun);
  });

  it('does NOT install when cds.db is unavailable', () => {
    const cds = { db: null };
    expect(installDbWrap(cds)).toBe(false);
  });

  it('installs exactly once — second call is a no-op even if served re-fires', () => {
    const cds = makeMockCds();
    expect(installDbWrap(cds)).toBe(true);
    const firstWrappedRun = cds.db.run;
    // Second call — matches cds.on('served') re-firing under cds.test().
    expect(installDbWrap(cds)).toBe(false);
    expect(cds.db.run).toBe(firstWrappedRun); // identity preserved
  });

  it('wraps cds.db.run and observes db.acquire.ms', async () => {
    const cds = makeMockCds();
    installDbWrap(cds);
    await cds.db.run('SELECT 1');
    await cds.db.run('SELECT 2');
    const snap = metrics.snapshot();
    expect(snap.histograms['db.acquire.ms']).toBeDefined();
    expect(snap.histograms['db.acquire.ms'].count).toBe(2);
  });

  it('wraps db.tx(fn) so BOTH db.tx.ms AND db.tx.run.ms record samples', async () => {
    const cds = makeMockCds();
    installDbWrap(cds);
    // Codebase-representative pattern (see srv/lib/kg-merge-pair.js etc.):
    // const db = await cds.connect.to('db'); await db.tx(async (tx) => await tx.run(...));
    await cds.db.tx(async (tx) => {
      await tx.run('SELECT 1');
      await tx.run('SELECT 2');
      return 'ok';
    });
    const snap = metrics.snapshot();
    expect(snap.histograms['db.tx.ms']?.count).toBe(1);
    expect(snap.histograms['db.tx.run.ms']?.count).toBe(2);
    // Bare cds.db.run should NOT have been touched by tx path.
    expect(snap.histograms['db.acquire.ms']).toBeUndefined();
  });

  it('increments db.pool.timeout when the rejected error matches /timeout|acquire/i', async () => {
    const cds = makeMockCds({
      runImpl: async () => { throw new Error('connection acquire timeout'); },
    });
    installDbWrap(cds);
    await expect(cds.db.run('SELECT 1')).rejects.toThrow(/timeout/);
    // Wait a microtask cycle — timing observer fires from .then/.catch,
    // which runs AFTER the caller's await resolves. Await a resolved promise
    // twice to drain the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    const snap = metrics.snapshot();
    expect(snap.counters['db.pool.timeout']).toBe(1);
    expect(snap.histograms['db.acquire.ms']?.count).toBe(1);
  });

  it('does NOT increment db.pool.timeout for unrelated errors', async () => {
    const cds = makeMockCds({
      runImpl: async () => { throw new Error('constraint violation'); },
    });
    installDbWrap(cds);
    await expect(cds.db.run('INSERT INTO x')).rejects.toThrow(/constraint/);
    await Promise.resolve();
    await Promise.resolve();
    const snap = metrics.snapshot();
    expect(snap.counters['db.pool.timeout']).toBeUndefined();
    expect(snap.histograms['db.acquire.ms']?.count).toBe(1);
  });

  it('preserves the caller-facing promise resolution (throw in observer does not poison)', async () => {
    // Force metrics.observe to throw and verify the outer await still resolves.
    const throwSpy = vi.spyOn(metrics, 'observe').mockImplementation(() => {
      throw new Error('injected — should be swallowed by wrapper');
    });
    const cds = makeMockCds();
    installDbWrap(cds);
    const result = await cds.db.run('SELECT 1');
    expect(result).toBe('ran');
    throwSpy.mockRestore();
  });

  it('object-form db.tx() falls through un-timed rather than throwing', async () => {
    // Simulate a hypothetical future runtime shape: db.tx() with no callback,
    // returning a tx-like object. Codebase has 0 sites of this today.
    const cds = makeMockCds();
    cds.db.tx = async (a) => {
      if (typeof a !== 'function' && a !== undefined) {
        return { objectForm: true, opts: a };
      }
      return 'callback-shape';
    };
    installDbWrap(cds);
    const result = await cds.db.tx({ some: 'opts' });
    expect(result).toEqual({ objectForm: true, opts: { some: 'opts' } });
    // No db.tx.ms sample because we intentionally fall through.
    const snap = metrics.snapshot();
    expect(snap.histograms['db.tx.ms']).toBeUndefined();
  });

  it('db.tx(req, fn) two-arg form still times both tx and tx.run', async () => {
    // Preserve the req/opts positional in the underlying call.
    let sawFirstArg;
    const cds = makeMockCds();
    cds.db.tx = async (a, b) => {
      sawFirstArg = a;
      const fn = typeof a === 'function' ? a : b;
      const tx = { run: async () => 'tx-ran' };
      return await fn(tx);
    };
    installDbWrap(cds);
    const fakeReq = { id: 'req-123' };
    await cds.db.tx(fakeReq, async (tx) => { await tx.run('SELECT 1'); });
    expect(sawFirstArg).toBe(fakeReq);
    const snap = metrics.snapshot();
    expect(snap.histograms['db.tx.ms']?.count).toBe(1);
    expect(snap.histograms['db.tx.run.ms']?.count).toBe(1);
  });
});
