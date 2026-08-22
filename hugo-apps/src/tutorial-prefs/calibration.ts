import {
  CAL_PROFILE_VERSION, CAL_MIN_SAMPLES,
  CAL_EYE_TRIGGER_FRACTION, CAL_EYE_MIN_SPREAD,
  CAL_HAND_DX_FACTOR, CAL_HAND_V_FACTOR, CAL_HAND_MIN_REVERSALS, CAL_HAND_MIN_AMPLITUDE,
  CAL_HAND_DX_MIN, CAL_HAND_DX_MAX, CAL_HAND_V_MIN, CAL_HAND_V_MAX,
  type EyeProfile, type HandProfile
} from './constants';

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
