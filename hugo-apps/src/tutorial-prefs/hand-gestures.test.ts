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
    det = new SwipeDetector({ now: () => now, onSwipe, dxFraction: 0.3, minVelocity: 0.4 });
  });
  const feed = (x: number, palmOpen = true) => { det.observe({ palmOpen, x }); };

  it('fires on a slow approach then fast flick (peak velocity, not average)', () => {
    feed(0.2); tick(50);                       // ARMED
    for (let i = 0; i < 8; i++) { feed(0.2); tick(200); }   // long dwell, no motion (avg would be ~0)
    feed(0.35); tick(30); feed(0.55); tick(30);             // fast flick within the window
    expect(onSwipe).toHaveBeenCalledWith('right');
  });

  it('does not fire on slow steady drift below the velocity threshold', () => {
    feed(0.2); tick(50);
    for (let i = 0; i < 20; i++) { feed(0.2 + i * 0.01); tick(200); }  // creeps across but slow
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('fires left for a leftward flick', () => {
    feed(0.8); tick(50); feed(0.6); tick(30); feed(0.4); tick(30);
    expect(onSwipe).toHaveBeenCalledWith('left');
  });

  it('enforces cooldown after firing', () => {
    feed(0.2); tick(50); feed(0.4); tick(30); feed(0.6); tick(30);
    expect(onSwipe).toHaveBeenCalledTimes(1);
    feed(0.2); tick(SWIPE_COOLDOWN_MS - 100); feed(0.4); tick(30); feed(0.6); tick(30);
    expect(onSwipe).toHaveBeenCalledTimes(1);  // still in cooldown
  });

  it('honours an injected dxFraction (large threshold suppresses a small swipe)', () => {
    const d = new SwipeDetector({ now: () => now, onSwipe, dxFraction: 0.9, minVelocity: 0.4 });
    d.observe({ palmOpen: true, x: 0.4 }); tick(50);
    d.observe({ palmOpen: true, x: 0.55 }); tick(30);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('resets when palm lost beyond reset window', () => {
    // Arm the detector at x=0.1, then lose palm for > PALM_LOST_RESET_MS.
    // After re-arming with a small subsequent move, no swipe should fire because
    // the buffer was cleared on palm-lost reset.
    feed(0.1); tick(PALM_LOST_RESET_MS + 100);
    feed(0.1, false);  // palm gone — triggers reset
    tick(50);
    feed(0.55);        // re-arms (IDLE → ARMED), x=0.55
    tick(200);
    feed(0.6);         // only 0.05 net from re-arm start, below dxFraction=0.3
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
