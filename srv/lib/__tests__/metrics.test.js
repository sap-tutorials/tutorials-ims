import { describe, it, expect, beforeEach, vi } from 'vitest';

// METRICS_ENABLED moved from an env var to the ImsConfig-backed feature flag
// (issue #2060). Mock the DB-flag resolver so tests toggle the kill switch
// without a DB. `state.metricsFlag` is read at call time by isFlagEnabled.
const state = vi.hoisted(() => ({ metricsFlag: true }));
vi.mock('../feature-flags/db-flags.js', () => ({
  isFlagEnabled: (key) => (key === 'METRICS_ENABLED' ? state.metricsFlag : true),
}));

import * as metrics from '../metrics.js';

describe('metrics module (counters + gauges)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    state.metricsFlag = true;
  });

  it('counter() increments a named counter starting from 0', () => {
    metrics.counter('foo');
    metrics.counter('foo');
    metrics.counter('bar');
    const snap = metrics.snapshot();
    expect(snap.counters).toEqual({ foo: 2, bar: 1 });
  });

  it('gauge() stores the latest value (overwrites)', () => {
    metrics.gauge('bytes', 100);
    metrics.gauge('bytes', 250);
    const snap = metrics.snapshot();
    expect(snap.gauges.bytes).toBe(250);
  });

  it('snapshot() returns a stable empty shape when nothing has been recorded', () => {
    const snap = metrics.snapshot();
    expect(snap).toEqual({ counters: {}, gauges: {}, histograms: {} });
  });

  it('is a no-op when the METRICS_ENABLED flag is off (still returns stable shape)', () => {
    state.metricsFlag = false;
    metrics.counter('foo');
    metrics.gauge('bar', 42);
    const snap = metrics.snapshot();
    expect(snap).toEqual({ counters: {}, gauges: {}, histograms: {} });
  });

  it('swallow-and-log: never throws on bad input, logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => metrics.counter(null)).not.toThrow();
    expect(() => metrics.gauge(null, 1)).not.toThrow();
    expect(() => metrics.observe(null, 1)).not.toThrow();
    warnSpy.mockRestore();
  });

  it('counter(name, n) increments by n', () => {
    metrics.counter('bulk', 5);
    metrics.counter('bulk', 3);
    expect(metrics.snapshot().counters.bulk).toBe(8);
  });

  it('counter(name) still defaults to +1', () => {
    metrics.counter('one');
    metrics.counter('one');
    expect(metrics.snapshot().counters.one).toBe(2);
  });

  it('counter(name, 0) records the series at 0', () => {
    metrics.counter('zeroed', 0);
    expect(metrics.snapshot().counters.zeroed).toBe(0);
  });

  it('counter with invalid n does not throw and leaves counter unset', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => metrics.counter('bad', Number.NaN)).not.toThrow();
    expect(() => metrics.counter('bad2', -3)).not.toThrow();
    expect(() => metrics.counter('bad3', 'x')).not.toThrow();
    const snap = metrics.snapshot();
    expect(snap.counters.bad).toBeUndefined();
    expect(snap.counters.bad2).toBeUndefined();
    expect(snap.counters.bad3).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('rejects a metric name longer than 64 chars (counter/gauge/observe) — no throw, absent from snapshot', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tooLong = 'x'.repeat(65);
    expect(() => metrics.counter(tooLong)).not.toThrow();
    expect(() => metrics.gauge(tooLong, 1)).not.toThrow();
    expect(() => metrics.observe(tooLong, 1)).not.toThrow();
    const snap = metrics.snapshot();
    expect(snap.counters[tooLong]).toBeUndefined();
    expect(snap.gauges[tooLong]).toBeUndefined();
    expect(snap.histograms[tooLong]).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('accepts a metric name of exactly 64 chars', () => {
    const exactly64 = 'y'.repeat(64);
    metrics.counter(exactly64);
    expect(metrics.snapshot().counters[exactly64]).toBe(1);
  });
});

describe('metrics module (histograms)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    state.metricsFlag = true;
  });

  it('observe() records samples and snapshot() returns count/p50/p95/p99/max', () => {
    for (let i = 1; i <= 100; i++) metrics.observe('latency', i);
    const h = metrics.snapshot().histograms.latency;
    expect(h.count).toBe(100);
    expect(h.max).toBe(100);
    expect(h.p50).toBeGreaterThanOrEqual(50);
    expect(h.p50).toBeLessThanOrEqual(51);
    expect(h.p95).toBeGreaterThanOrEqual(95);
    expect(h.p95).toBeLessThanOrEqual(96);
    expect(h.p99).toBeGreaterThanOrEqual(99);
    expect(h.p99).toBeLessThanOrEqual(100);
  });

  it('reservoir is bounded — 5000 samples still fit in 2000-slot reservoir', () => {
    for (let i = 1; i <= 5000; i++) metrics.observe('latency', i);
    const h = metrics.snapshot().histograms.latency;
    expect(h.count).toBe(5000);
    // p50 of uniform 1..5000 should be near 2500; Algorithm R sampling gives
    // wide but bounded tolerance — assert within ±20%.
    expect(h.p50).toBeGreaterThan(2000);
    expect(h.p50).toBeLessThan(3000);
  });

  it('empty histogram not in snapshot output', () => {
    const snap = metrics.snapshot();
    expect(snap.histograms).toEqual({});
  });

  it('observe() no-op when the METRICS_ENABLED flag is off', () => {
    state.metricsFlag = false;
    metrics.observe('latency', 42);
    expect(metrics.snapshot().histograms).toEqual({});
  });
});

describe('metrics module (rotate + emitLogLine)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    state.metricsFlag = true;
  });

  it('rotate() returns the current snapshot and drains state', () => {
    metrics.counter('foo');
    metrics.counter('foo');
    metrics.gauge('bytes', 100);
    metrics.observe('latency', 42);

    const rotated = metrics.rotate();
    expect(rotated.counters.foo).toBe(2);
    expect(rotated.gauges.bytes).toBe(100);
    expect(rotated.histograms.latency.count).toBe(1);

    // After rotate, snapshot counters + histograms are empty; gauges remain.
    const after = metrics.snapshot();
    expect(after.counters).toEqual({});
    expect(after.histograms).toEqual({});
    expect(after.gauges.bytes).toBe(100);
  });

  it('emitLogLine writes a structured JSON line to cds.log', () => {
    const infoSpy = vi.fn();
    const cds = { log: vi.fn().mockReturnValue({ info: infoSpy }) };
    metrics.emitLogLine(cds, 'foo', 42, { windowStart: '2026-07-02T14:00:00Z', kind: 'counter' });
    expect(cds.log).toHaveBeenCalledWith('jobs/metrics-rollup');
    expect(infoSpy).toHaveBeenCalledOnce();
    const payload = JSON.parse(infoSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({ metric: 'foo', value: 42, kind: 'counter' });
  });
});
