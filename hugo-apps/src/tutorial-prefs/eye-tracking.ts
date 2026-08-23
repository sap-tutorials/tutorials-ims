import {
  CAL_EYE_DOWN_FRACTION, CAL_EYE_UP_FRACTION,
  GAZE_DWELL_MS, GAZE_FIRE_COOLDOWN_MS, GAZE_DWELL_GRACE_MS, GAZE_EMA_ALPHA,
  FRAME_INTERVAL_MS, NO_FACE_TIMEOUT_MS, SCROLL_VIEWPORT_FRACTION,
  MEDIAPIPE_WASM_BASE, MODEL_FACE, SLOW_FRAME_MS, SLOW_FRAME_RUN
} from './constants';
import { acquire, release } from './camera-session';
import { getCal } from './prefs-store';
import type { EyeProfile } from './constants';
import type { CamReport } from './cam-debug';

// pitch drives the trigger; gazeY is diagnostic-only (kept for the overlay).
export interface GazeFrame { pitch: number; gazeY?: number; }
export type ScrollDir = 'up' | 'down';

export function emaStep(prev: number | null, sample: number, alpha: number): number {
  return prev === null ? sample : alpha * sample + (1 - alpha) * prev;
}

// Runtime thresholds from the calibrated pitch envelope. Down fires high in the
// range (looking down), up fires low (looking up). Mirrors calibration.ts's
// deriveEyeThresholds — inlined here to avoid an eye-tracking↔calibration import
// cycle (calibration already imports computeGazeFrame from this module).
function eyeThresholds(p: EyeProfile): { down: number; up: number } {
  const range = p.pitchMax - p.pitchMin;
  return {
    down: p.pitchMin + CAL_EYE_DOWN_FRACTION * range,
    up: p.pitchMin + CAL_EYE_UP_FRACTION * range
  };
}

export interface GazeDetectorOpts {
  now: () => number;
  onScroll: (dir: ScrollDir) => void;
  downThreshold?: number;   // pitch >= this → scroll down
  upThreshold?: number;     // pitch <= this → scroll up
}

export class GazeDetector {
  private dwellStart: number | null = null;
  private dwellDir: ScrollDir | null = null;
  private lastEligible = 0;
  private cooldownUntil = 0;
  private readonly downThreshold: number | null;
  private readonly upThreshold: number | null;

  constructor(private opts: GazeDetectorOpts) {
    this.downThreshold = opts.downThreshold ?? null;
    this.upThreshold = opts.upThreshold ?? null;
  }

  observe(f: GazeFrame): void {
    const t = this.opts.now();
    if (t < this.cooldownUntil) return;

    const dir = this.direction(f.pitch);
    if (dir === null) {
      // One dropout inside the grace window does not reset the dwell.
      if (this.dwellStart !== null && t - this.lastEligible > GAZE_DWELL_GRACE_MS) {
        this.dwellStart = null; this.dwellDir = null;
      }
      return;
    }
    this.lastEligible = t;
    // A flip to the other direction restarts the dwell clock for that direction.
    if (dir !== this.dwellDir) { this.dwellDir = dir; this.dwellStart = t; }
    if (this.dwellStart !== null && t - this.dwellStart >= GAZE_DWELL_MS) {
      this.opts.onScroll(dir);
      this.cooldownUntil = t + GAZE_FIRE_COOLDOWN_MS;
      this.dwellStart = null; this.dwellDir = null;
    }
  }

  // Uncalibrated (both thresholds null) → never eligible; the feature waits for
  // a calibration profile rather than guessing an absolute pitch baseline.
  private direction(pitch: number): ScrollDir | null {
    if (this.downThreshold !== null && pitch >= this.downThreshold) return 'down';
    if (this.upThreshold !== null && pitch <= this.upThreshold) return 'up';
    return null;
  }

  observeNoFace(): void { this.dwellStart = null; this.dwellDir = null; }

  // Read-only snapshots for the debug overlay — no behaviour change.
  dwellMs(): number {
    return this.dwellStart === null ? 0 : Math.max(0, this.opts.now() - this.dwellStart);
  }
  activeDir(): ScrollDir | null { return this.dwellDir; }
}

interface EyeRuntime { stop: () => void; }
interface RunOpts {
  reducedMotion: boolean;
  onError: (e: Error) => void;
  onSlow: () => void;
  onDebug?: (r: CamReport) => void;
}

export async function runEyeTracking(opts: RunOpts): Promise<EyeRuntime> {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_FACE },
    runningMode: 'VIDEO',
    numFaces: 1
  });

  const stream = await acquire('eye');
  const video = document.createElement('video');
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();

  let lastFrame = 0;
  let lastFace = performance.now();
  let slowStreak = 0;
  let stopped = false;

  const cal = getCal('eye') as EyeProfile | null;
  const thresholds = cal ? eyeThresholds(cal) : null;
  let pitchEma: number | null = null;

  const det = new GazeDetector({
    now: () => performance.now(),
    downThreshold: thresholds?.down,
    upThreshold: thresholds?.up,
    onScroll: (dir) => {
      const el = document.scrollingElement;
      const amount = window.innerHeight * SCROLL_VIEWPORT_FRACTION;
      const behavior = opts.reducedMotion ? 'auto' : 'smooth';
      if (dir === 'down') {
        const max = (el?.scrollHeight ?? 0) - window.innerHeight - 4;
        if (window.scrollY >= max) return;
        window.scrollBy({ top: amount, behavior });
      } else {
        if (window.scrollY <= 4) return;
        window.scrollBy({ top: -amount, behavior });
      }
    }
  });

  const loop = (ts: number) => {
    if (stopped) return;
    if (ts - lastFrame < FRAME_INTERVAL_MS) { requestAnimationFrame(loop); return; }
    const frameStart = performance.now();
    lastFrame = ts;
    try {
      const res = landmarker.detectForVideo(video, performance.now());
      const lm = res.faceLandmarks?.[0];
      if (!lm) {
        if (performance.now() - lastFace > NO_FACE_TIMEOUT_MS) det.observeNoFace();
        if (opts.onDebug) opts.onDebug({
          kind: 'eye', faceSeen: false, pitch: 0, gazeY: 0,
          downThreshold: thresholds?.down ?? null, upThreshold: thresholds?.up ?? null,
          calibrated: !!cal, dwellMs: det.dwellMs(), dir: det.activeDir()
        });
      } else {
        lastFace = performance.now();
        const frame = computeGazeFrame(lm);
        pitchEma = emaStep(pitchEma, frame.pitch, GAZE_EMA_ALPHA);
        det.observe({ pitch: pitchEma, gazeY: frame.gazeY });
        if (opts.onDebug) opts.onDebug({
          kind: 'eye', faceSeen: true, pitch: pitchEma, gazeY: frame.gazeY ?? 0,
          downThreshold: thresholds?.down ?? null, upThreshold: thresholds?.up ?? null,
          calibrated: !!cal, dwellMs: det.dwellMs(), dir: det.activeDir()
        });
      }
    } catch (err) {
      opts.onError(err as Error); stop(); return;
    }
    const dur = performance.now() - frameStart;
    slowStreak = dur > SLOW_FRAME_MS ? slowStreak + 1 : 0;
    if (slowStreak === SLOW_FRAME_RUN) opts.onSlow();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  function stop() {
    if (stopped) return;
    stopped = true;
    try { landmarker.close(); } catch {}
    video.pause(); video.srcObject = null;
    release('eye');
  }
  return { stop };
}

// pitch = vertical offset of the nose tip below the eye-corner midline, normalized
// by inter-ocular distance (distance-invariant). It rises as the user looks/tilts
// down and falls as they look up — the signal the calibrated detector keys on.
// gazeY (iris offset from the corner line) is kept only for the ?debug-cam overlay;
// it proved unreliable (near-zero, inverted) across real cameras.
// Iris centers 468 (right) / 473 (left); right corners 33 (outer) / 133 (inner);
// left corners 263 (outer) / 362 (inner).
export function computeGazeFrame(lm: Array<{ x: number; y: number; z: number }>): GazeFrame {
  const irisR = lm[468], irisL = lm[473];
  const rOut = lm[33], rIn = lm[133], lIn = lm[362], lOut = lm[263];

  const rMidX = (rOut.x + rIn.x) / 2, rMidY = (rOut.y + rIn.y) / 2;
  const lMidX = (lOut.x + lIn.x) / 2, lMidY = (lOut.y + lIn.y) / 2;
  const rW = Math.abs(rOut.x - rIn.x), lW = Math.abs(lOut.x - lIn.x);

  const offR = (irisR.y - rMidY) / Math.max(rW, 1e-6);
  const offL = (irisL.y - lMidY) / Math.max(lW, 1e-6);
  const gazeY = (offR + offL) / 2;  // signed: >0 iris below corner line ≈ looking down

  const nose = lm[1];
  const eyeMidY = (rMidY + lMidY) / 2;
  const interOcular = Math.hypot(lMidX - rMidX, lMidY - rMidY);
  const pitch = (nose.y - eyeMidY) / Math.max(interOcular, 1e-6);

  return { pitch, gazeY };
}
