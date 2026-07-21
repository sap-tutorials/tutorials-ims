import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as metrics from '../../srv/lib/metrics.js';

// Minimal cds stub — the job uses cds.log and cds.entities(NAMESPACE).
vi.mock('@sap/cds', () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return { default: { log, entities: () => ({ MetricSnapshots: { name: 'MetricSnapshots' } }) } };
});

let insertCalls;
function installInsert(behavior) {
  insertCalls = [];
  globalThis.INSERT = {
    into: () => ({
      entries: (rows) => {
        insertCalls.push(rows);
        return behavior(rows);
      },
    }),
  };
}

describe('#1257 rollup per-row fallback', () => {
  beforeEach(() => {
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
    metrics.counter('a.b.c', 1);
    metrics.counter('d.e.f', 1);
  });
  afterEach(() => { delete globalThis.INSERT; });

  it('salvages good rows when the batch insert throws a non-collision error', async () => {
    // Batch (array length > 1) throws; single-row inserts succeed.
    installInsert((rows) => {
      if (rows.length > 1) throw new Error('inserted value too large for column');
      return Promise.resolve();
    });
    const { runMetricsRollup } = await import('../../srv/jobs/metrics-rollup-job.js');
    const res = await runMetricsRollup({ instanceId: 'test-instance' });
    expect(res.degraded).toBe(true);
    expect(res.wrote).toBe(2);
    expect(res.dropped).toBe(0);
  });

  it('collision on the batch still returns skipped (regression)', async () => {
    installInsert(() => { throw new Error('unique constraint violated'); });
    const { runMetricsRollup } = await import('../../srv/jobs/metrics-rollup-job.js');
    const res = await runMetricsRollup({ instanceId: 'test-instance' });
    expect(res.skipped).toBe(true);
    expect(res.wrote).toBe(0);
  });
});
