import {
  GAZE_BOTTOM_THRESHOLD, GAZE_DWELL_MS, GAZE_FIRE_COOLDOWN_MS,
  FRAME_INTERVAL_MS, NO_FACE_TIMEOUT_MS, SCROLL_VIEWPORT_FRACTION,
  MEDIAPIPE_WASM_BASE, MODEL_FACE, SLOW_FRAME_MS, SLOW_FRAME_RUN
} from './constants';
import { acquire, release } from './camera-session';
import type { CamReport } from './cam-debug';

export interface GazeFrame { gazeY: number; headForward: boolean; pitch?: number; }

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

  // For the debug overlay only — read-only snapshot, no behaviour change.
  dwellMs(): number {
    return this.dwellStart === null ? 0 : Math.max(0, this.opts.now() - this.dwellStart);
  }
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

  const det = new GazeDetector({
    now: () => performance.now(),
    onGazeLow: () => {
      const max = (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight - 4;
      if (window.scrollY >= max) return;
      window.scrollBy({
        top: window.innerHeight * SCROLL_VIEWPORT_FRACTION,
        behavior: opts.reducedMotion ? 'auto' : 'smooth'
      });
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
          kind: 'eye', gazeY: 0, pitch: 0, headForward: false,
          dwellMs: det.dwellMs(), faceSeen: false
        });
      } else {
        lastFace = performance.now();
        const frame = computeGazeFrame(lm);
        det.observe(frame);
        if (opts.onDebug) opts.onDebug({
          kind: 'eye', gazeY: frame.gazeY, pitch: frame.pitch ?? 0,
          headForward: frame.headForward, dwellMs: det.dwellMs(), faceSeen: true
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

// Iris centers: 468 (right), 473 (left); right-eye top/bottom 159/145;
// left-eye top/bottom 386/374. Documented in MediaPipe Face Landmarker model card.
function computeGazeFrame(lm: Array<{ x: number; y: number; z: number }>): GazeFrame {
  const irisR = lm[468], irisL = lm[473];
  const rTop = lm[159], rBot = lm[145], lTop = lm[386], lBot = lm[374];
  const yR = (irisR.y - rTop.y) / Math.max(rBot.y - rTop.y, 1e-6);
  const yL = (irisL.y - lTop.y) / Math.max(lBot.y - lTop.y, 1e-6);
  const gazeY = Math.min(1, Math.max(0, (yR + yL) / 2));

  const nose = lm[1];
  const eyeMidY = (lm[33].y + lm[263].y) / 2;
  const pitch = nose.y - eyeMidY;
  const headForward = pitch < 0.06;

  return { gazeY, headForward, pitch };
}
