// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GazeDetector, emaStep, type ScrollDir } from './eye-tracking';
import { GAZE_DWELL_MS, GAZE_FIRE_COOLDOWN_MS, NO_FACE_TIMEOUT_MS, GAZE_DWELL_GRACE_MS } from './constants';

// Calibrated pitch envelope for these tests: down fires at >= 1.0, up at <= 0.6,
// with a resting deadband around 0.8 (matches observed live telemetry).
const DOWN_TH = 1.0, UP_TH = 0.6;
const DOWN = 1.1, UP = 0.5, DEAD = 0.8;

describe('GazeDetector', () => {
  let now = 0; const tick = (ms: number) => { now += ms; };
  let onScroll: ReturnType<typeof vi.fn>;
  let det: GazeDetector;

  const feed = (pitch: number, ms: number) => {
    for (let t = 0; t <= ms; t += 50) { det.observe({ pitch }); tick(50); }
  };

  beforeEach(() => {
    now = 0; onScroll = vi.fn();
    det = new GazeDetector({
      now: () => now, onScroll: onScroll as (d: ScrollDir) => void,
      downThreshold: DOWN_TH, upThreshold: UP_TH
    });
  });

  it('does not fire on a single frame past threshold', () => {
    det.observe({ pitch: DOWN });
    expect(onScroll).not.toHaveBeenCalled();
  });

  it('fires "down" after sustained downward pitch for DWELL ms', () => {
    feed(DOWN, GAZE_DWELL_MS + 50);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onScroll).toHaveBeenCalledWith('down');
  });

  it('fires "up" after sustained upward pitch for DWELL ms', () => {
    feed(UP, GAZE_DWELL_MS + 50);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onScroll).toHaveBeenCalledWith('up');
  });

  it('does not fire while pitch stays in the resting deadband', () => {
    feed(DEAD, GAZE_DWELL_MS + 200);
    expect(onScroll).not.toHaveBeenCalled();
  });

  it('respects fire cooldown', () => {
    feed(DOWN, GAZE_DWELL_MS + 50);
    expect(onScroll).toHaveBeenCalledTimes(1);
    feed(DOWN, GAZE_FIRE_COOLDOWN_MS - 200);
    expect(onScroll).toHaveBeenCalledTimes(1);
  });

  it('does NOT break dwell on a single deadband frame (grace window)', () => {
    feed(DOWN, GAZE_DWELL_MS - 200);
    det.observe({ pitch: DEAD }); tick(50);   // one dropout, inside grace
    feed(DOWN, 200);
    expect(onScroll).toHaveBeenCalledTimes(1);
  });

  it('breaks dwell when pitch stays in the deadband past the grace window', () => {
    feed(DOWN, GAZE_DWELL_MS - 100);
    feed(DEAD, GAZE_DWELL_GRACE_MS + 100);
    det.observe({ pitch: DOWN }); tick(50);   // dwell restarted; not enough to fire
    expect(onScroll).not.toHaveBeenCalled();
  });

  it('restarts the dwell clock when direction flips', () => {
    feed(DOWN, GAZE_DWELL_MS - 150);   // almost fires down
    feed(UP, GAZE_DWELL_MS - 150);     // switch before either completes
    expect(onScroll).not.toHaveBeenCalled();
  });

  it('never fires when uncalibrated (no thresholds)', () => {
    const d = new GazeDetector({ now: () => now, onScroll: onScroll as (d: ScrollDir) => void });
    for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) { d.observe({ pitch: DOWN }); tick(50); }
    expect(onScroll).not.toHaveBeenCalled();
  });

  it('observeNoFace clears the dwell window', () => {
    feed(DOWN, GAZE_DWELL_MS / 2);
    det.observeNoFace();
    tick(NO_FACE_TIMEOUT_MS + 50);
    feed(DOWN, GAZE_DWELL_MS / 2);
    expect(onScroll).not.toHaveBeenCalled();
  });
});

it('emaStep seeds on first sample then smooths', () => {
  expect(emaStep(null, 0.5, 0.4)).toBe(0.5);
  expect(emaStep(0.5, 1.0, 0.4)).toBeCloseTo(0.7, 6);
});
