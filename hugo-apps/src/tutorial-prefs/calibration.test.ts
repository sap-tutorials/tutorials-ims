import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeEyeProfile, computeHandProfile, deriveEyeThreshold, percentile, captureSamples } from './calibration';
import { CAL_PROFILE_VERSION, CAL_EYE_TRIGGER_FRACTION } from './constants';

const eyeSamples = (vals: number[]) => vals.map((v, i) => ({ t: i * 66, v }));

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([0, 10], 50)).toBeCloseTo(5, 6);
  });
});

describe('computeEyeProfile', () => {
  it('returns a p5/p95 envelope from a wide scan', () => {
    const vals = Array.from({ length: 50 }, (_, i) => i / 49); // 0..1 spread
    const p = computeEyeProfile(eyeSamples(vals))!;
    expect(p.v).toBe(CAL_PROFILE_VERSION);
    expect(p.gazeMin).toBeLessThan(0.1);
    expect(p.gazeMax).toBeGreaterThan(0.9);
  });

  it('rejects blink outliers via percentiles', () => {
    const vals = [...Array.from({ length: 48 }, (_, i) => 0.4 + (i / 48) * 0.2), 99, -99]; // sweep 0.4→0.6 + spikes
    const p = computeEyeProfile(eyeSamples(vals))!;
    expect(p.gazeMin).toBeGreaterThan(-1);   // −99 outlier excluded by p5
    expect(p.gazeMax).toBeLessThan(2);       // 99 outlier excluded by p95
  });

  it('returns null when too few samples', () => {
    expect(computeEyeProfile(eyeSamples([0.1, 0.9]))).toBeNull();
  });

  it('returns null when spread is too small', () => {
    const vals = Array.from({ length: 50 }, () => 0.5);
    expect(computeEyeProfile(eyeSamples(vals))).toBeNull();
  });
});

describe('deriveEyeThreshold', () => {
  it('sits CAL_EYE_TRIGGER_FRACTION into the envelope', () => {
    const th = deriveEyeThreshold({ v: CAL_PROFILE_VERSION, gazeMin: 0, gazeMax: 1 });
    expect(th).toBeCloseTo(CAL_EYE_TRIGGER_FRACTION, 6);
  });
});

describe('computeHandProfile', () => {
  it('derives clamped dxFraction/minVelocity from multi-sweep samples', () => {
    // Simulate 3 left-right sweeps: x oscillates 0.2↔0.8 every 5 frames @66ms.
    const samples = [];
    let x = 0.2, dir = 1;
    for (let i = 0; i < 60; i++) {
      samples.push({ t: i * 66, v: x });
      x += dir * 0.12; if (x >= 0.8 || x <= 0.2) dir *= -1;
    }
    const p = computeHandProfile(samples)!;
    expect(p.v).toBe(CAL_PROFILE_VERSION);
    expect(p.dxFraction).toBeGreaterThan(0);
    expect(p.minVelocity).toBeGreaterThan(0);
  });

  it('returns null when the hand never reverses direction', () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ t: i * 66, v: 0.2 + i * 0.005 }));
    expect(computeHandProfile(samples)).toBeNull();
  });
});

describe('captureSamples', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collects non-null samples until the duration elapses and reports progress', async () => {
    let clock = 0;
    const now = () => clock;
    const script = [0.1, null, 0.3, 0.4, 0.5, 0.6];  // one dropped frame
    let i = 0;
    const progress: number[] = [];
    const p = captureSamples({
      now, durationMs: 300, intervalMs: 66,
      sample: () => script[Math.min(i++, script.length - 1)],
      onProgress: (f) => progress.push(f)
    });
    // Advance fake time + the interval callback in lockstep.
    for (let step = 0; step < 6; step++) { clock += 66; await vi.advanceTimersByTimeAsync(66); }
    const out = await p;
    expect(out.every((s) => s.v !== null)).toBe(true);   // nulls dropped
    expect(out.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);        // reached 100%
  });
});
