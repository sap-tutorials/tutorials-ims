import {
  CAL_PROFILE_VERSION, CAL_MIN_SAMPLES,
  CAL_EYE_TRIGGER_FRACTION, CAL_EYE_MIN_SPREAD,
  CAL_HAND_DX_FACTOR, CAL_HAND_V_FACTOR, CAL_HAND_MIN_REVERSALS, CAL_HAND_MIN_AMPLITUDE,
  CAL_HAND_DX_MIN, CAL_HAND_DX_MAX, CAL_HAND_V_MIN, CAL_HAND_V_MAX,
  FRAME_INTERVAL_MS, CAL_DURATION_MS, MEDIAPIPE_WASM_BASE, MODEL_FACE, MODEL_HAND,
  type EyeProfile, type HandProfile, type FeatureId
} from './constants';
import { acquire, release } from './camera-session';
import { setCal } from './prefs-store';
import { computeGazeFrame } from './eye-tracking';
import { computeHandFrame } from './hand-gestures';

export interface Sample { t: number; v: number; }

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function computeEyeProfile(samples: Sample[]): EyeProfile | null {
  if (samples.length < CAL_MIN_SAMPLES) return null;
  const sorted = samples.map((s) => s.v).sort((a, b) => a - b);
  const gazeMin = percentile(sorted, 5);
  const gazeMax = percentile(sorted, 95);
  if (gazeMax - gazeMin < CAL_EYE_MIN_SPREAD) return null;
  return { v: CAL_PROFILE_VERSION, gazeMin, gazeMax };
}

export function deriveEyeThreshold(p: EyeProfile): number {
  return p.gazeMin + CAL_EYE_TRIGGER_FRACTION * (p.gazeMax - p.gazeMin);
}

export function computeHandProfile(samples: Sample[]): HandProfile | null {
  if (samples.length < CAL_MIN_SAMPLES) return null;
  const sorted = samples.map((s) => s.v).sort((a, b) => a - b);
  const amplitude = percentile(sorted, 95) - percentile(sorted, 5);

  let peakV = 0, reversals = 0, lastDir = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    const dx = samples[i].v - samples[i - 1].v;
    if (dt > 0) peakV = Math.max(peakV, Math.abs(dx) / dt);
    const dir = Math.sign(dx);
    if (dir !== 0) { if (lastDir !== 0 && dir !== lastDir) reversals++; lastDir = dir; }
  }
  if (reversals < CAL_HAND_MIN_REVERSALS || amplitude < CAL_HAND_MIN_AMPLITUDE) return null;

  return {
    v: CAL_PROFILE_VERSION,
    dxFraction: clamp(CAL_HAND_DX_FACTOR * amplitude, CAL_HAND_DX_MIN, CAL_HAND_DX_MAX),
    minVelocity: clamp(CAL_HAND_V_FACTOR * peakV, CAL_HAND_V_MIN, CAL_HAND_V_MAX)
  };
}

export async function captureSamples(opts: {
  now: () => number;
  durationMs: number;
  intervalMs: number;
  sample: () => number | null;
  onProgress?: (fraction: number) => void;
  isCancelled?: () => boolean;
}): Promise<Sample[]> {
  return new Promise((resolve) => {
    const start = opts.now();
    const out: Sample[] = [];
    const id = setInterval(() => {
      if (opts.isCancelled?.()) { clearInterval(id); resolve(out); return; }
      const t = opts.now();
      const elapsed = t - start;
      const v = opts.sample();
      if (v !== null && Number.isFinite(v)) out.push({ t, v });
      opts.onProgress?.(Math.min(1, elapsed / opts.durationMs));
      if (elapsed >= opts.durationMs) { clearInterval(id); resolve(out); }
    }, opts.intervalMs);
  });
}

// Production glue: sets up the feature's landmarker over the shared stream, runs
// the capture, reduces to a profile, persists on success, always releases.
// MediaPipe cannot run under happy-dom, so this function is verified live via
// ?debug-cam; captureSamples + the reducers carry the unit coverage.
export async function runCalibrationCapture(
  feature: FeatureId,
  opts: { onProgress?: (f: number) => void; isCancelled?: () => boolean } = {}
): Promise<EyeProfile | HandProfile | null> {
  const { FaceLandmarker, HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);

  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let landmarker: any = null;
  try {
    stream = await acquire(feature);
    video = document.createElement('video');
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    await video.play();

    let sample: () => number | null;
    if (feature === 'eye') {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_FACE }, runningMode: 'VIDEO', numFaces: 1
      });
      sample = () => {
        const lm = landmarker.detectForVideo(video, performance.now()).faceLandmarks?.[0];
        return lm ? computeGazeFrame(lm).gazeY : null;
      };
    } else {
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_HAND }, runningMode: 'VIDEO', numHands: 1
      });
      sample = () => {
        const lm = landmarker.detectForVideo(video, performance.now()).landmarks?.[0];
        const f = lm ? computeHandFrame(lm) : null;
        return f && f.palmOpen ? f.x : null;   // only sample while the palm gate passes
      };
    }

    const samples = await captureSamples({
      now: () => performance.now(), durationMs: CAL_DURATION_MS,
      intervalMs: FRAME_INTERVAL_MS, sample, onProgress: opts.onProgress,
      isCancelled: opts.isCancelled
    });
    if (opts.isCancelled?.()) return null;
    const profile = feature === 'eye' ? computeEyeProfile(samples) : computeHandProfile(samples);
    if (profile) setCal(feature, profile);
    return profile;
  } finally {
    try { landmarker?.close(); } catch {}
    if (video) { video.pause(); video.srcObject = null; }
    if (stream) release(feature);
  }
}
