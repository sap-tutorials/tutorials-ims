import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import * as metrics from '../../srv/lib/metrics.js';
import { installDbWrap, _resetForTest as _resetWrap } from '../../srv/lib/metrics-db-wrap.js';

// #909 — Hybrid test for the passive DB wrapper against real HANA.
//
// Read-only. No __TEST__ prefix / writes, so no _guard.js involvement.
//
// Asserts: with METRICS_DB_WRAP enabled, the histograms' `count` field
// increases in proportion to observed queries. Deliberately NOT asserting
// absolute latency numbers — timing against real HANA is flaky. Per the
// spec, "when wrapping is enabled, the db.acquire.ms histogram's count
// increases in proportion to observed queries; we do not assert absolute
// latency numbers."

const originalEnabled = process.env.METRICS_ENABLED;
const originalWrap = process.env.METRICS_DB_WRAP;
process.env.METRICS_ENABLED = 'true';
process.env.METRICS_DB_WRAP = 'true';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

describe('metrics-db-wrap on real HANA (#909)', () => {
  beforeAll(() => {
    // Ensure clean sentinel + reservoir state — under cds.test() the served
    // hook may already have fired. Reset the sentinel so installDbWrap can
    // (re-)wrap the DB service we now have.
    _resetWrap();
    metrics._resetForTest();
    const installed = installDbWrap(cds);
    if (!installed) {
      // Not fatal — if cds.on('served') already installed via server.js the
      // wrapper is present, just under the earlier sentinel. Force reset.
      _resetWrap();
      metrics._resetForTest();
      installDbWrap(cds);
    }
  });

  afterAll(() => {
    _resetWrap();
    if (originalEnabled === undefined) delete process.env.METRICS_ENABLED;
    else process.env.METRICS_ENABLED = originalEnabled;
    if (originalWrap === undefined) delete process.env.METRICS_DB_WRAP;
    else process.env.METRICS_DB_WRAP = originalWrap;
  });

  it('db.acquire.ms count grows in proportion to cds.db.run(...) calls', async () => {
    const before = metrics.snapshot().histograms['db.acquire.ms']?.count || 0;
    // Three cheap SELECTs — no table dependency, works on HANA.
    await cds.db.run('SELECT 1 FROM DUMMY');
    await cds.db.run('SELECT 1 FROM DUMMY');
    await cds.db.run('SELECT 1 FROM DUMMY');
    const after = metrics.snapshot().histograms['db.acquire.ms']?.count || 0;
    expect(after - before).toBeGreaterThanOrEqual(3);
  });

  it('db.tx(fn) records BOTH db.tx.ms AND db.tx.run.ms', async () => {
    const beforeTx = metrics.snapshot().histograms['db.tx.ms']?.count || 0;
    const beforeTxRun = metrics.snapshot().histograms['db.tx.run.ms']?.count || 0;
    await cds.db.tx(async (tx) => {
      await tx.run('SELECT 1 FROM DUMMY');
      await tx.run('SELECT 1 FROM DUMMY');
    });
    const afterTx = metrics.snapshot().histograms['db.tx.ms']?.count || 0;
    const afterTxRun = metrics.snapshot().histograms['db.tx.run.ms']?.count || 0;
    expect(afterTx - beforeTx).toBeGreaterThanOrEqual(1);
    expect(afterTxRun - beforeTxRun).toBeGreaterThanOrEqual(2);
  });
});
