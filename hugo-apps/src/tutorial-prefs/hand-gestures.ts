import {
  SWIPE_MIN_DX_FRACTION, SWIPE_MIN_VELOCITY,
  SWIPE_COOLDOWN_MS, PALM_LOST_RESET_MS,
  FRAME_INTERVAL_MS, MEDIAPIPE_WASM_BASE, MODEL_HAND,
  SLOW_FRAME_MS, SLOW_FRAME_RUN
} from './constants';
import { acquire, release } from './camera-session';
import { dispatchNav } from './nav-dispatch';

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

interface HandRuntime { stop: () => void; }
interface RunOpts { onError: (e: Error) => void; onSlow: () => void; }

export async function runHandGestures(opts: RunOpts): Promise<HandRuntime> {
  const { HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_HAND },
    runningMode: 'VIDEO',
    numHands: 1
  });

  const stream = await acquire('hand');
  const video = document.createElement('video');
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();

  let lastFrame = 0;
  let slowStreak = 0;
  let stopped = false;

  const det = new SwipeDetector({
    now: () => performance.now(),
    frameWidth: 1,
    onSwipe: (dir) => dispatchNav(dir === 'right' ? 'next' : 'prev')
  });

  const loop = (ts: number) => {
    if (stopped) return;
    if (ts - lastFrame < FRAME_INTERVAL_MS) { requestAnimationFrame(loop); return; }
    const frameStart = performance.now();
    lastFrame = ts;
    try {
      const res = landmarker.detectForVideo(video, performance.now());
      const lm = res.landmarks?.[0];
      if (!lm) det.observe({ palmOpen: false, x: 0 });
      else det.observe(computeHandFrame(lm));
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
    release('hand');
  }
  return { stop };
}

// Open palm: index/middle/ring/pinky tips above their MCP knuckles.
// Tips 8/12/16/20; MCPs 5/9/13/17. Lower y == higher on screen.
function computeHandFrame(lm: Array<{ x: number; y: number; z: number }>): HandFrame {
  const tips = [8, 12, 16, 20], mcps = [5, 9, 13, 17];
  const palmOpen = tips.every((tip, i) => lm[tip].y < lm[mcps[i]].y);
  const palmCenter = (lm[0].x + lm[9].x) / 2;
  return { palmOpen, x: palmCenter };
}
