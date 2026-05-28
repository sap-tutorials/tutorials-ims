import {
  SWIPE_MIN_DX_FRACTION, SWIPE_MIN_VELOCITY,
  SWIPE_COOLDOWN_MS, PALM_LOST_RESET_MS
} from './constants';

export interface HandFrame { palmOpen: boolean; x: number; }
export type SwipeDir = 'left' | 'right';

export interface SwipeDetectorOpts {
  now: () => number;
  frameWidth: number;
  onSwipe: (dir: SwipeDir) => void;
}

type State = 'IDLE' | 'ARMED' | 'COOLDOWN';

export class SwipeDetector {
  private state: State = 'IDLE';
  private startX = 0;
  private startT = 0;
  private lastSeen = 0;
  private cooldownUntil = 0;

  constructor(private opts: SwipeDetectorOpts) {}

  observe(f: HandFrame): void {
    const t = this.opts.now();
    if (t < this.cooldownUntil) { this.state = 'COOLDOWN'; return; }
    if (this.state === 'COOLDOWN') this.state = 'IDLE';

    if (!f.palmOpen) {
      if (t - this.lastSeen > PALM_LOST_RESET_MS) this.state = 'IDLE';
      return;
    }
    this.lastSeen = t;

    if (this.state === 'IDLE') {
      this.state = 'ARMED'; this.startX = f.x; this.startT = t; return;
    }
    const dx = f.x - this.startX;
    const dt = (t - this.startT) / 1000;
    if (dt <= 0) return;
    const absDx = Math.abs(dx);
    const v = absDx / dt;
    if (absDx >= SWIPE_MIN_DX_FRACTION * this.opts.frameWidth && v >= SWIPE_MIN_VELOCITY) {
      this.opts.onSwipe(dx > 0 ? 'right' : 'left');
      this.cooldownUntil = t + SWIPE_COOLDOWN_MS;
      this.state = 'COOLDOWN';
    }
  }
}
