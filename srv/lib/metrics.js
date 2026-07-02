// srv/lib/metrics.js
//
// Shared in-memory metrics producer. See
// docs/superpowers/specs/2026-07-02-805-observability-instrumentation-design.md
// and docs/developers/architecture/observability.md.
//
// Public surface:
//   counter(name)         — increment integer counter
//   gauge(name, value)    — overwrite (latest wins)
//   observe(name, value)  — push into a Vitter Algorithm R reservoir
//   snapshot()            — { counters, gauges, histograms } — safe to call any time
//   rotate()              — snapshot + zero counters + drain reservoirs
//   emitLogLine(...)      — one structured cds.log line per rollup boundary
//
// Behavior contract:
//   - No public call ever throws to the caller. All wrapped in try/catch
//     that funnels to a rate-limited warn.
//   - When METRICS_ENABLED === 'false', all writes are no-ops and snapshot()
//     returns the stable empty shape { counters:{}, gauges:{}, histograms:{} }.
//   - The module owns in-memory state only. Persistence is the rollup job.

const counters = new Map();
const gauges = new Map();
const RESERVOIR_SIZE = 2000;
const histograms = new Map();
// Each histogram: { count: number, samples: number[] (length ≤ RESERVOIR_SIZE) }

let lastWarnAt = 0;
function warn(msg) {
  const now = Date.now();
  if (now - lastWarnAt > 60_000) {
    lastWarnAt = now;
    console.warn(`[metrics] ${msg}`);
  }
}

function isDisabled() {
  return process.env.METRICS_ENABLED === 'false';
}

export function counter(name) {
  try {
    if (isDisabled()) return;
    if (typeof name !== 'string' || !name) throw new Error(`invalid counter name: ${name}`);
    counters.set(name, (counters.get(name) || 0) + 1);
  } catch (err) { warn(err.message); }
}

export function gauge(name, value) {
  try {
    if (isDisabled()) return;
    if (typeof name !== 'string' || !name) throw new Error(`invalid gauge name: ${name}`);
    if (typeof value !== 'number' || !isFinite(value)) throw new Error(`invalid gauge value: ${value}`);
    gauges.set(name, value);
  } catch (err) { warn(err.message); }
}

// Vitter's Algorithm R — uniform reservoir sampling.
// For the first RESERVOIR_SIZE samples, fill the reservoir directly.
// For the (n+1)-th sample where n >= RESERVOIR_SIZE, replace a random slot
// with probability RESERVOIR_SIZE/(n+1). Result is a uniform sample of
// the entire stream regardless of length.
function reservoirPush(h, value) {
  h.count += 1;
  if (h.samples.length < RESERVOIR_SIZE) {
    h.samples.push(value);
    return;
  }
  const j = Math.floor(Math.random() * h.count); // 0..count-1
  if (j < RESERVOIR_SIZE) h.samples[j] = value;
}

export function observe(name, value) {
  try {
    if (isDisabled()) return;
    if (typeof name !== 'string' || !name) throw new Error(`invalid histogram name: ${name}`);
    if (typeof value !== 'number' || !isFinite(value)) throw new Error(`invalid observe value: ${value}`);
    let h = histograms.get(name);
    if (!h) { h = { count: 0, samples: [] }; histograms.set(name, h); }
    reservoirPush(h, value);
  } catch (err) { warn(err.message); }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function summarizeHistogram(h) {
  const sorted = [...h.samples].sort((a, b) => a - b);
  return {
    count: h.count,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

export function snapshot() {
  try {
    if (isDisabled()) return { counters: {}, gauges: {}, histograms: {} };
    const histogramsOut = {};
    for (const [name, h] of histograms) histogramsOut[name] = summarizeHistogram(h);
    return {
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      histograms: histogramsOut,
    };
  } catch (err) {
    warn(err.message);
    return { counters: {}, gauges: {}, histograms: {} };
  }
}

export function rotate() {
  try {
    if (isDisabled()) return { counters: {}, gauges: {}, histograms: {} };
    const out = snapshot();
    counters.clear();
    histograms.clear();
    // gauges are NOT cleared on rotate — they represent latest value.
    // The rollup job records the current gauge value, then the producer
    // continues overwriting; there is no "reset" for a gauge.
    return out;
  } catch (err) {
    warn(err.message);
    return { counters: {}, gauges: {}, histograms: {} };
  }
}

/**
 * Emit one structured JSON log line for a metric at a rollup boundary.
 * The rollup job calls this once per metric per tick.
 * `cds` is passed in so tests can inject a mock (module is import-free of cds).
 */
export function emitLogLine(cds, metric, value, extra = {}) {
  try {
    if (isDisabled()) return;
    const payload = { metric, value, ...extra };
    cds.log('jobs/metrics-rollup').info(JSON.stringify(payload));
  } catch (err) { warn(err.message); }
}

// Test-only helper — reset in-memory state between tests. Not exported for prod use.
export function _resetForTest() {
  counters.clear();
  gauges.clear();
  histograms.clear();
  lastWarnAt = 0;
}
