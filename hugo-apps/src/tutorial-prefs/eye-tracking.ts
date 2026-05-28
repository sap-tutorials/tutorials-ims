import { GAZE_BOTTOM_THRESHOLD, GAZE_DWELL_MS, GAZE_FIRE_COOLDOWN_MS } from './constants';

export interface GazeFrame { gazeY: number; headForward: boolean; }

export interface GazeDetectorOpts {
  now: () => number;
  onGazeLow: () => void;
}

export class GazeDetector {
  private dwellStart: number | null = null;
  private cooldownUntil = 0;
  constructor(private opts: GazeDetectorOpts) {}

  observe(f: GazeFrame): void {
    const t = this.opts.now();
    if (t < this.cooldownUntil) return;
    const eligible = f.gazeY > GAZE_BOTTOM_THRESHOLD && f.headForward;
    if (!eligible) { this.dwellStart = null; return; }
    if (this.dwellStart === null) this.dwellStart = t;
    if (t - this.dwellStart >= GAZE_DWELL_MS) {
      this.opts.onGazeLow();
      this.cooldownUntil = t + GAZE_FIRE_COOLDOWN_MS;
      this.dwellStart = null;
    }
  }

  observeNoFace(): void { this.dwellStart = null; }
}

// MediaPipe wiring is appended in Task 9.
