// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwipeDetector } from './hand-gestures';
import { SWIPE_COOLDOWN_MS, PALM_LOST_RESET_MS } from './constants';

describe('SwipeDetector', () => {
  let now = 0; const tick = (ms: number) => { now += ms; };
  let onSwipe: ReturnType<typeof vi.fn>;
  let det: SwipeDetector;

  beforeEach(() => {
    now = 0; onSwipe = vi.fn();
    det = new SwipeDetector({ now: () => now, frameWidth: 1, onSwipe });
  });

  it('emits "right" on a fast positive sweep', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.55 });
    expect(onSwipe).toHaveBeenCalledWith('right');
  });

  it('emits "left" on a fast negative sweep', () => {
    det.observe({ palmOpen: true, x: 0.9 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.45 });
    expect(onSwipe).toHaveBeenCalledWith('left');
  });

  it('does not fire below dx threshold', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.25 });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('does not fire below velocity threshold', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(2000);
    det.observe({ palmOpen: true, x: 0.55 });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('resets when palm lost beyond reset window', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(PALM_LOST_RESET_MS + 100);
    det.observe({ palmOpen: false, x: 0 });
    tick(50);
    det.observe({ palmOpen: true, x: 0.55 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.6 });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('respects cooldown', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.55 });
    expect(onSwipe).toHaveBeenCalledTimes(1);
    tick(SWIPE_COOLDOWN_MS - 100);
    det.observe({ palmOpen: true, x: 0.1 });
    tick(100);
    det.observe({ palmOpen: true, x: 0.55 });
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });
});
