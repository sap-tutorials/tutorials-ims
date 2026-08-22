import {
  SWIPE_MIN_DX_FRACTION, SWIPE_MIN_VELOCITY,
  SWIPE_COOLDOWN_MS, PALM_LOST_RESET_MS,
  FRAME_INTERVAL_MS, MEDIAPIPE_WASM_BASE, MODEL_HAND,
  SLOW_FRAME_MS, SLOW_FRAME_RUN, PALM_MIN_FINGERS
} from './constants';
import { acquire, release } from './camera-session';
import { dispatchNav } from './nav-dispatch';
import type { CamReport } from './cam-debug';

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

  // Read-only state for the debug overlay — no behaviour change.
  // Caller computes dx/velocity by combining startX/startT with the live frame.
  inspect(): { state: State; startX: number; startT: number } {
    return { state: this.state, startX: this.startX, startT: this.startT };
  }
}

interface HandRuntime { stop: () => void; }
interface RunOpts {
  onError: (e: Error) => void;
  onSlow: () => void;
  onDebug?: (r: CamReport) => void;
}

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
      let frame: HandFrame;
      if (!lm) { frame = { palmOpen: false, x: 0 }; det.observe(frame); }
      else { frame = computeHandFrame(lm); det.observe(frame); }

      if (opts.onDebug) {
        const now = performance.now();
        const insp = det.inspect();
        const armed = insp.state === 'ARMED';
        const dx = armed ? frame.x - insp.startX : 0;
        const dtMs = armed ? Math.max(0, now - insp.startT) : 0;
        const velocity = armed && dtMs > 0 ? Math.abs(dx) / (dtMs / 1000) : 0;
        opts.onDebug({
          kind: 'hand',
          palmSeen: !!lm,
          palmOpen: frame.palmOpen,
          x: frame.x,
          dxFromArmed: dx,
          dtMs,
          velocity,
          state: insp.state
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
    release('hand');
  }
  return { stop };
}

// Radial open-palm test: a finger is "extended" when its tip is farther from the
// wrist (0) than its PIP joint. This is tilt-invariant — unlike a strict
// tip.y < mcp.y comparison it survives a hand held at any angle. Tips 8/12/16/20,
// PIPs 6/10/14/18. Palm x is mirrored (1 − center) so a rightward sweep (to the
// user's right) produces increasing x → 'right' → Next.
export function computeHandFrame(lm: Array<{ x: number; y: number; z: number }>): HandFrame {
  const wrist = lm[0];
  const tips = [8, 12, 16, 20], pips = [6, 10, 14, 18];
  const dist = (a: { x: number; y: number }) => Math.hypot(a.x - wrist.x, a.y - wrist.y);
  let extended = 0;
  for (let i = 0; i < 4; i++) if (dist(lm[tips[i]]) > dist(lm[pips[i]])) extended++;
  const palmOpen = extended >= PALM_MIN_FINGERS;
  const palmCenterX = (lm[0].x + lm[9].x) / 2;
  return { palmOpen, x: 1 - palmCenterX };
}
