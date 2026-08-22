import {
  SWIPE_MIN_DX_FRACTION, SWIPE_MIN_VELOCITY, SWIPE_COOLDOWN_MS, PALM_LOST_RESET_MS,
  SWIPE_WINDOW_MS, PALM_MIN_FINGERS,
  FRAME_INTERVAL_MS, MEDIAPIPE_WASM_BASE, MODEL_HAND, SLOW_FRAME_MS, SLOW_FRAME_RUN
} from './constants';
import { acquire, release } from './camera-session';
import { dispatchNav } from './nav-dispatch';
import { getCal } from './prefs-store';
import type { CamReport } from './cam-debug';
import type { HandProfile } from './constants';

export interface HandFrame { palmOpen: boolean; x: number; }
export type SwipeDir = 'left' | 'right';

export interface SwipeDetectorOpts {
  now: () => number;
  onSwipe: (dir: SwipeDir) => void;
  dxFraction?: number;    // default SWIPE_MIN_DX_FRACTION; overridden by calibration
  minVelocity?: number;   // default SWIPE_MIN_VELOCITY; overridden by calibration
}

type State = 'IDLE' | 'ARMED' | 'COOLDOWN';

export class SwipeDetector {
  private state: State = 'IDLE';
  private lastSeen = 0;
  private cooldownUntil = 0;
  private buf: Array<{ t: number; x: number }> = [];
  private readonly dxFraction: number;
  private readonly minVelocity: number;

  constructor(private opts: SwipeDetectorOpts) {
    this.dxFraction = opts.dxFraction ?? SWIPE_MIN_DX_FRACTION;
    this.minVelocity = opts.minVelocity ?? SWIPE_MIN_VELOCITY;
  }

  observe(f: HandFrame): void {
    const t = this.opts.now();
    if (t < this.cooldownUntil) { this.state = 'COOLDOWN'; return; }
    if (this.state === 'COOLDOWN') { this.state = 'IDLE'; this.buf = []; }

    if (!f.palmOpen) {
      if (t - this.lastSeen > PALM_LOST_RESET_MS) { this.state = 'IDLE'; this.buf = []; }
      return;
    }
    this.lastSeen = t;

    if (this.state === 'IDLE') { this.state = 'ARMED'; this.buf = [{ t, x: f.x }]; return; }

    // ARMED: maintain a trailing window and evaluate net displacement + peak velocity.
    this.buf.push({ t, x: f.x });
    const cutoff = t - SWIPE_WINDOW_MS;
    while (this.buf.length > 1 && this.buf[0].t < cutoff) this.buf.shift();

    const net = f.x - this.buf[0].x;
    const peakV = this.peakVelocity();
    if (Math.abs(net) >= this.dxFraction && peakV >= this.minVelocity) {
      this.opts.onSwipe(net > 0 ? 'right' : 'left');
      this.cooldownUntil = t + SWIPE_COOLDOWN_MS;
      this.state = 'COOLDOWN';
      this.buf = [];
    }
  }

  private peakVelocity(): number {
    let peak = 0;
    for (let i = 1; i < this.buf.length; i++) {
      const dt = (this.buf[i].t - this.buf[i - 1].t) / 1000;
      if (dt > 0) peak = Math.max(peak, Math.abs(this.buf[i].x - this.buf[i - 1].x) / dt);
    }
    return peak;
  }

  // Read-only snapshot for the debug overlay.
  inspect(): { state: State; dx: number; velocity: number } {
    const dx = this.buf.length > 1 ? this.buf[this.buf.length - 1].x - this.buf[0].x : 0;
    return { state: this.state, dx, velocity: this.peakVelocity() };
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

  const cal = getCal('hand') as HandProfile | null;
  const dxThreshold = cal?.dxFraction ?? SWIPE_MIN_DX_FRACTION;
  const vThreshold = cal?.minVelocity ?? SWIPE_MIN_VELOCITY;
  const det = new SwipeDetector({
    now: () => performance.now(),
    dxFraction: cal?.dxFraction,
    minVelocity: cal?.minVelocity,
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
        const insp = det.inspect();
        opts.onDebug({
          kind: 'hand',
          palmSeen: !!lm,
          palmOpen: frame.palmOpen,
          x: frame.x,
          dxFromArmed: insp.dx,
          dtMs: 0,               // window-based now; kept for CamReport shape compatibility
          velocity: insp.velocity,
          state: insp.state,
          dxThreshold,
          vThreshold,
          calibrated: !!cal
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
