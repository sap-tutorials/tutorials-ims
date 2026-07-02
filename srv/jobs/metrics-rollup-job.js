// srv/jobs/metrics-rollup-job.js
//
// Every 5 minutes: rotate the in-memory metrics module and write one
// MetricSnapshots row per named metric. No job-lock — both CF instances
// write independently under composite PRIMARY KEY (windowStart, metric, instanceId).
//
// See docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md
// § Rollout for the design rationale.

import cds from '@sap/cds';
import * as metrics from '../lib/metrics.js';

const NAMESPACE = 'com.sap.developers.ims';
const INSTANCE_ID = process.env.CF_INSTANCE_GUID || `local-${process.pid}`;
const LOG = cds.log('jobs/metrics-rollup');

function alignedWindowStart() {
  return new Date(Math.floor(Date.now() / 300_000) * 300_000).toISOString();
}

/**
 * @param {{ instanceId?: string }} [opts] — instanceId override for tests.
 */
export async function runMetricsRollup(opts = {}) {
  if (process.env.METRICS_ENABLED === 'false') return { skipped: true };

  const instanceId = opts.instanceId || INSTANCE_ID;
  const windowStart = alignedWindowStart();
  const rotated = metrics.rotate();
  const { MetricSnapshots } = cds.entities(NAMESPACE);

  const rows = [];

  for (const [metric, value] of Object.entries(rotated.counters)) {
    rows.push({ windowStart, metric, instanceId, kind: 'counter', count: value, value });
    metrics.emitLogLine(cds, metric, value, { kind: 'counter', windowStart, instanceId });
  }
  for (const [metric, value] of Object.entries(rotated.gauges)) {
    rows.push({ windowStart, metric, instanceId, kind: 'gauge', count: 1, value });
    metrics.emitLogLine(cds, metric, value, { kind: 'gauge', windowStart, instanceId });
  }
  for (const [metric, h] of Object.entries(rotated.histograms)) {
    rows.push({
      windowStart, metric, instanceId, kind: 'histogram',
      count: h.count, value: 0,
      p50: h.p50, p95: h.p95, p99: h.p99, max: h.max,
    });
    metrics.emitLogLine(cds, metric, h.p95, {
      kind: 'histogram', count: h.count, p50: h.p50, p95: h.p95, p99: h.p99, max: h.max,
      windowStart, instanceId,
    });
  }

  if (rows.length === 0) return { wrote: 0 };

  try {
    // INSERT (not UPSERT) — composite-key UPSERT semantics on HANA via CDS QL
    // are not exercised anywhere else in the codebase and would complicate
    // regression debugging. Same-tick re-runs are rare (would need a manual
    // trigger); primary-key violation is caught and logged as a warning
    // rather than retrying, since same-window same-instance would produce
    // identical rows anyway.
    await INSERT.into(MetricSnapshots).entries(rows);
    return { wrote: rows.length };
  } catch (err) {
    // Primary-key collision (same window re-run) is expected on manual re-fires.
    if (/uniqu|primary|duplicate/i.test(err.message || '')) {
      LOG.info(`rollup already written for ${windowStart} on ${instanceId} — skipping`);
      return { wrote: 0, skipped: true };
    }
    LOG.warn(`rollup write failed: ${err.message}`);
    return { wrote: 0, error: err.message };
  }
}
