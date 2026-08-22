// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GazeDetector, emaStep } from './eye-tracking';
import { GAZE_DWELL_MS, GAZE_FIRE_COOLDOWN_MS, NO_FACE_TIMEOUT_MS, GAZE_DWELL_GRACE_MS } from './constants';

describe('GazeDetector', () => {
  let now = 0; const tick = (ms: number) => { now += ms; };
  let onFire: ReturnType<typeof vi.fn>;
  let det: GazeDetector;

  beforeEach(() => {
    now = 0; onFire = vi.fn();
    det = new GazeDetector({ now: () => now, onGazeLow: onFire });
  });

  it('does not fire on a single low frame', () => {
    det.observe({ gazeY: 0.9, headForward: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('fires after sustained low gaze for DWELL ms', () => {
    for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('does not fire if head is tilted down', () => {
    for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) {
      det.observe({ gazeY: 0.9, headForward: false });
      tick(50);
    }
    expect(onFire).not.toHaveBeenCalled();
  });

  it('respects fire cooldown', () => {
    for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).toHaveBeenCalledTimes(1);
    for (let t = 0; t < GAZE_FIRE_COOLDOWN_MS - 100; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('does NOT break dwell on a single ineligible frame (grace window)', () => {
    for (let t = 0; t < GAZE_DWELL_MS - 200; t += 50) { det.observe({ gazeY: 0.9, headForward: true }); tick(50); }
    det.observe({ gazeY: 0.1, headForward: true }); tick(50);   // one blink-like dropout, inside grace
    for (let t = 0; t < 200; t += 50) { det.observe({ gazeY: 0.9, headForward: true }); tick(50); }
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('breaks dwell when gaze stays high past the grace window', () => {
    for (let t = 0; t < GAZE_DWELL_MS - 100; t += 50) { det.observe({ gazeY: 0.9, headForward: true }); tick(50); }
    for (let t = 0; t <= GAZE_DWELL_GRACE_MS + 100; t += 50) { det.observe({ gazeY: 0.1, headForward: true }); tick(50); }
    det.observe({ gazeY: 0.9, headForward: true }); tick(50);   // dwell restarted; not enough to fire
    expect(onFire).not.toHaveBeenCalled();
  });

  it('honours an injected threshold', () => {
    const d = new GazeDetector({ now: () => now, onGazeLow: onFire, threshold: 0.8 });
    for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) { d.observe({ gazeY: 0.7, headForward: true }); tick(50); }
    expect(onFire).not.toHaveBeenCalled();  // 0.7 < 0.8 injected → never eligible
  });

  it('observeNoFace clears the dwell window', () => {
    for (let t = 0; t < GAZE_DWELL_MS / 2; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    det.observeNoFace();
    tick(NO_FACE_TIMEOUT_MS + 50);
    for (let t = 0; t < GAZE_DWELL_MS / 2; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).not.toHaveBeenCalled();
  });
});

it('emaStep seeds on first sample then smooths', () => {
  expect(emaStep(null, 0.5, 0.4)).toBe(0.5);
  expect(emaStep(0.5, 1.0, 0.4)).toBeCloseTo(0.7, 6);
});
