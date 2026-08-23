import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeEyeProfile, computeHandProfile, deriveEyeThresholds, percentile, captureSamples } from './calibration';
import { CAL_PROFILE_VERSION, CAL_EYE_DOWN_FRACTION, CAL_EYE_UP_FRACTION } from './constants';

const eyeSamples = (vals: number[]) => vals.map((v, i) => ({ t: i * 66, v }));

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([0, 10], 50)).toBeCloseTo(5, 6);
  });
});

describe('computeEyeProfile', () => {
  it('returns a p5/p95 pitch envelope from a wide scan', () => {
    const vals = Array.from({ length: 50 }, (_, i) => i / 49); // 0..1 spread
    const p = computeEyeProfile(eyeSamples(vals))!;
    expect(p.v).toBe(CAL_PROFILE_VERSION);
    expect(p.pitchMin).toBeLessThan(0.1);
    expect(p.pitchMax).toBeGreaterThan(0.9);
  });

  it('rejects blink outliers via percentiles', () => {
    const vals = [...Array.from({ length: 48 }, (_, i) => 0.4 + (i / 48) * 0.2), 99, -99]; // sweep 0.4→0.6 + spikes
    const p = computeEyeProfile(eyeSamples(vals))!;
    expect(p.pitchMin).toBeGreaterThan(-1);   // −99 outlier excluded by p5
    expect(p.pitchMax).toBeLessThan(2);       // 99 outlier excluded by p95
  });

  it('returns null when too few samples', () => {
    expect(computeEyeProfile(eyeSamples([0.1, 0.9]))).toBeNull();
  });

  it('returns null when spread is too small', () => {
    const vals = Array.from({ length: 50 }, () => 0.5);
    expect(computeEyeProfile(eyeSamples(vals))).toBeNull();
  });
});

describe('deriveEyeThresholds', () => {
  it('places down/up at the configured fractions of the envelope', () => {
    const { down, up } = deriveEyeThresholds({ v: CAL_PROFILE_VERSION, pitchMin: 0, pitchMax: 1 });
    expect(down).toBeCloseTo(CAL_EYE_DOWN_FRACTION, 6);
    expect(up).toBeCloseTo(CAL_EYE_UP_FRACTION, 6);
    expect(down).toBeGreaterThan(up);   // deadband between up and down
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

  it('stops early when isCancelled returns true', async () => {
    let clock = 0;
    const now = () => clock;
    let cancelled = false;
    const p = captureSamples({
      now, durationMs: 600, intervalMs: 66,
      sample: () => 0.5,
      isCancelled: () => cancelled
    });
    // Run 2 normal ticks (samples collected)
    for (let step = 0; step < 2; step++) { clock += 66; await vi.advanceTimersByTimeAsync(66); }
    // Cancel before the 3rd tick fires
    cancelled = true;
    clock += 66; await vi.advanceTimersByTimeAsync(66);
    const out = await p;
    // Tick 3 bailed at the top (before sampling), so only 2 samples
    expect(out.length).toBe(2);
    // A full 600ms run would yield ~9 ticks — we stopped far short
    expect(out.length).toBeLessThan(9);
  });
});
