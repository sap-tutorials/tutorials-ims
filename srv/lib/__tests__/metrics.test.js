import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as metrics from '../metrics.js';

describe('metrics module (counters + gauges)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
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

  it('is a no-op when METRICS_ENABLED=false (still returns stable shape)', () => {
    process.env.METRICS_ENABLED = 'false';
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
});

describe('metrics module (histograms)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
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

  it('observe() no-op when METRICS_ENABLED=false', () => {
    process.env.METRICS_ENABLED = 'false';
    metrics.observe('latency', 42);
    expect(metrics.snapshot().histograms).toEqual({});
  });
});

describe('metrics module (rotate + emitLogLine)', () => {
  beforeEach(() => {
    metrics._resetForTest();
    delete process.env.METRICS_ENABLED;
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
