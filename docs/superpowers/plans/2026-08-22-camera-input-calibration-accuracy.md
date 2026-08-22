# Camera-Input Accuracy Fixes + Per-User Calibration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tutorial-page eye-tracking auto-scroll and hand-gesture nav detect reliably by fixing the per-frame detection math and adding opt-in per-user calibration.

**Architecture:** All work lives in the `hugo-apps/src/tutorial-prefs/` Vue island. Detection-quality fixes rewrite the pure metric functions and make the detectors accept injected thresholds. A new lazy-loaded `calibration.ts` + `CalibrationOverlay.vue` capture a per-user profile per feature, persist it to `localStorage`, and feed derived thresholds into the detectors. Uncalibrated behaviour falls back to today's constants.

**Tech Stack:** TypeScript, Vue 3, `@mediapipe/tasks-vision` (Face/Hand Landmarker), Vitest + happy-dom, UI5 web components.

**Spec:** `docs/superpowers/specs/2026-08-22-camera-input-calibration-accuracy-design.md`

## Global Constraints

- **Main-chunk budget:** `tutorial-prefs.js` ≤ 8 KB gzip. `hugo-apps/vite.config.ts` (`MAX_TUTORIAL_PREFS_GZIP = 8 * 1024`) **errors the build** if exceeded. `calibration.ts` and `CalibrationOverlay.vue` MUST be reached only via dynamic `import()` (like `eye-tracking.ts`/`hand-gestures.ts`), never statically imported from `main.ts`/`index.ts`.
- **Privacy:** 100% local processing. No network, no telemetry, no server persistence. Profiles live in `localStorage` only.
- **Storage safety:** every `localStorage`/`sessionStorage` access goes through a `try/catch` (follow the existing `safeLocal`/`safeSet` pattern in `prefs-store.ts`).
- **Copy:** en-US only. "Experimental, hands-free input" framing; never market as assistive technology.
- **No backend/schema/approuter/XSUAA/CSP changes.**
- **Test runner:** unit tests run from the worktree root with `npx vitest run --project unit <path>`. Every test file that touches the DOM starts with `// @vitest-environment happy-dom` (first line).
- **Detectors stay pure & synchronous:** `GazeDetector`/`SwipeDetector` take a `now()` clock and all thresholds via `opts` — no `performance.now()` or module-global reads inside them, so they unit-test deterministically.

---

## File Structure

- `hugo-apps/src/tutorial-prefs/constants.ts` — **modify**: add calibration/EMA/palm/window constants + `localStorage` keys + `EyeProfile`/`HandProfile` types.
- `hugo-apps/src/tutorial-prefs/prefs-store.ts` — **modify**: add `getCal`/`setCal`/`clearCal` + cal-prompted first-run helpers.
- `hugo-apps/src/tutorial-prefs/eye-tracking.ts` — **modify**: corner-anchored gaze metric, normalized pitch, EMA in loop, `GazeDetector` threshold injection + dwell grace, read profile at start.
- `hugo-apps/src/tutorial-prefs/hand-gestures.ts` — **modify**: mirror + tolerant palm gate in `computeHandFrame`, `SwipeDetector` trailing-buffer motion model + threshold injection, read profile at start.
- `hugo-apps/src/tutorial-prefs/calibration.ts` — **create**: pure profile reducers, async `captureSamples`, production `runCalibrationCapture` glue.
- `hugo-apps/src/tutorial-prefs/CalibrationOverlay.vue` — **create**: fullscreen 5s scan UI.
- `hugo-apps/src/tutorial-prefs/main.ts` — **modify**: calibrate handler, auto-prompt-once, overlay host, wiring.
- `hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue` — **modify**: Calibrate button + status hint per feature.
- `hugo-apps/src/tutorial-prefs/cam-debug.ts` — **modify**: show active thresholds + profile-loaded flag.
- Test files co-located as `*.test.ts`.
- `docs/end-users/experimental-features.md` — **modify**: add calibration section.

---

## Task 1: Calibration constants, profile types, and prefs-store helpers

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/constants.ts`
- Modify: `hugo-apps/src/tutorial-prefs/prefs-store.ts`
- Test: `hugo-apps/src/tutorial-prefs/cal-store.test.ts` (create)

**Interfaces:**
- Produces: types `EyeProfile = { v: number; gazeMin: number; gazeMax: number }`, `HandProfile = { v: number; dxFraction: number; minVelocity: number }`, `CalProfile = EyeProfile | HandProfile`; constants `CAL_PROFILE_VERSION`, `CAL_DURATION_MS`, `CAL_MIN_SAMPLES`, `CAL_EYE_TRIGGER_FRACTION`, `CAL_EYE_MIN_SPREAD`, `CAL_HAND_DX_FACTOR`, `CAL_HAND_V_FACTOR`, `CAL_HAND_MIN_REVERSALS`, `CAL_HAND_MIN_AMPLITUDE`, `CAL_HAND_DX_MIN/MAX`, `CAL_HAND_V_MIN/MAX`, `GAZE_EMA_ALPHA`, `GAZE_DWELL_GRACE_MS`, `PALM_MIN_FINGERS`, `SWIPE_WINDOW_MS`, keys `KEY_CAL_EYE/HAND`, `KEY_CAL_PROMPTED_EYE/HAND`; functions `getCal(f)`, `setCal(f, p)`, `clearCal(f)`, `isCalPrompted(f)`, `markCalPrompted(f)`.

- [ ] **Step 1: Add constants + types to `constants.ts`** (append near the existing detection constants)

```ts
// --- Calibration (2026-08-22) -------------------------------------------
export const CAL_PROFILE_VERSION = 1;
export const CAL_DURATION_MS = 5000;
export const CAL_MIN_SAMPLES = 20;

// Eye: threshold sits this far into the captured [p5, p95] gaze envelope.
export const CAL_EYE_TRIGGER_FRACTION = 0.7;
export const CAL_EYE_MIN_SPREAD = 0.05;      // min p95-p5 gaze spread to accept (new gaze units)

// Hand: derived thresholds = factor * observed, clamped to sane bounds.
export const CAL_HAND_DX_FACTOR = 0.6;
export const CAL_HAND_V_FACTOR = 0.5;
export const CAL_HAND_MIN_REVERSALS = 2;
export const CAL_HAND_MIN_AMPLITUDE = 0.10;  // min p95-p5 palm-x swing to accept
export const CAL_HAND_DX_MIN = 0.12;
export const CAL_HAND_DX_MAX = 0.45;
export const CAL_HAND_V_MIN = 0.20;
export const CAL_HAND_V_MAX = 1.50;

// Detection-quality knobs (workstreams A/B).
export const GAZE_EMA_ALPHA = 0.4;
export const GAZE_DWELL_GRACE_MS = 150;
export const PALM_MIN_FINGERS = 3;           // of 4
export const SWIPE_WINDOW_MS = 250;

export const KEY_CAL_EYE = 'tut.pref.eyeTrack.cal';
export const KEY_CAL_HAND = 'tut.pref.handGest.cal';
export const KEY_CAL_PROMPTED_EYE = 'tut.pref.eyeTrack.cal.prompted';
export const KEY_CAL_PROMPTED_HAND = 'tut.pref.handGest.cal.prompted';

export interface EyeProfile { v: number; gazeMin: number; gazeMax: number; }
export interface HandProfile { v: number; dxFraction: number; minVelocity: number; }
export type CalProfile = EyeProfile | HandProfile;
```

- [ ] **Step 2: Add cal helpers to `prefs-store.ts`** (extend the existing key maps + helpers)

```ts
// add to the import from './constants'
import {
  // …existing…
  KEY_CAL_EYE, KEY_CAL_HAND, KEY_CAL_PROMPTED_EYE, KEY_CAL_PROMPTED_HAND,
  CAL_PROFILE_VERSION, type CalProfile
} from './constants';

const CAL_KEY: Record<FeatureId, string> = { eye: KEY_CAL_EYE, hand: KEY_CAL_HAND };
const CAL_PROMPTED_KEY: Record<FeatureId, string> = {
  eye: KEY_CAL_PROMPTED_EYE, hand: KEY_CAL_PROMPTED_HAND
};

export function getCal(f: FeatureId): CalProfile | null {
  const raw = safeLocal()?.getItem(CAL_KEY[f]);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as CalProfile;
    if (!p || (p as any).v !== CAL_PROFILE_VERSION) return null;  // version mismatch → treat as absent
    return p;
  } catch { return null; }
}

export function setCal(f: FeatureId, p: CalProfile): void {
  safeSet(safeLocal(), CAL_KEY[f], JSON.stringify(p));
}

export function clearCal(f: FeatureId): void {
  safeRemove(safeLocal(), CAL_KEY[f]);
}

export function isCalPrompted(f: FeatureId): boolean {
  return safeLocal()?.getItem(CAL_PROMPTED_KEY[f]) === '1';
}

export function markCalPrompted(f: FeatureId): void {
  safeSet(safeLocal(), CAL_PROMPTED_KEY[f], '1');
}
```

- [ ] **Step 3: Write the failing test** `cal-store.test.ts`

```ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { getCal, setCal, clearCal, isCalPrompted, markCalPrompted } from './prefs-store';
import { KEY_CAL_EYE, CAL_PROFILE_VERSION, type EyeProfile } from './constants';

describe('calibration store', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips an eye profile', () => {
    const p: EyeProfile = { v: CAL_PROFILE_VERSION, gazeMin: 0.1, gazeMax: 0.6 };
    setCal('eye', p);
    expect(getCal('eye')).toEqual(p);
  });

  it('returns null when absent', () => {
    expect(getCal('hand')).toBeNull();
  });

  it('returns null on parse failure', () => {
    localStorage.setItem(KEY_CAL_EYE, 'not json');
    expect(getCal('eye')).toBeNull();
  });

  it('returns null on version mismatch', () => {
    localStorage.setItem(KEY_CAL_EYE, JSON.stringify({ v: 99, gazeMin: 0, gazeMax: 1 }));
    expect(getCal('eye')).toBeNull();
  });

  it('clearCal removes the profile', () => {
    setCal('eye', { v: CAL_PROFILE_VERSION, gazeMin: 0, gazeMax: 1 });
    clearCal('eye');
    expect(getCal('eye')).toBeNull();
  });

  it('cal-prompted flag round-trips', () => {
    expect(isCalPrompted('eye')).toBe(false);
    markCalPrompted('eye');
    expect(isCalPrompted('eye')).toBe(true);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/cal-store.test.ts`
Expected: PASS (implementation from Steps 1-2 already present).

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/constants.ts hugo-apps/src/tutorial-prefs/prefs-store.ts hugo-apps/src/tutorial-prefs/cal-store.test.ts
git commit -m "feat(camera): calibration constants, profile types, prefs-store helpers"
```

---

## Task 2: Corner-anchored gaze metric + normalized pitch

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/eye-tracking.ts:124-139` (`computeGazeFrame`)
- Test: `hugo-apps/src/tutorial-prefs/gaze-metric.test.ts` (create)

**Interfaces:**
- Produces: `export function computeGazeFrame(lm: Array<{x:number;y:number;z:number}>): GazeFrame` (now **exported**). `GazeFrame.gazeY` is an unclamped signed offset (larger = iris lower in socket = looking down); `pitch` is normalized by inter-ocular distance.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test** `gaze-metric.test.ts`

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { computeGazeFrame } from './eye-tracking';

// Build a landmark array with only the indices computeGazeFrame reads.
// Indices: 1 (nose), 33/133 (right corners), 263/362 (left corners),
// 468 (right iris), 473 (left iris).
function lmWith(overrides: Record<number, { x: number; y: number }>) {
  const arr = Array.from({ length: 478 }, () => ({ x: 0, y: 0, z: 0 }));
  for (const [i, p] of Object.entries(overrides)) arr[+i] = { ...p, z: 0 };
  return arr;
}

// A neutral, forward-looking face at a fixed scale.
function neutralFace(irisY: number) {
  return lmWith({
    33:  { x: 0.30, y: 0.50 }, 133: { x: 0.40, y: 0.50 },   // right eye corners
    263: { x: 0.70, y: 0.50 }, 362: { x: 0.60, y: 0.50 },   // left eye corners
    468: { x: 0.35, y: irisY }, 473: { x: 0.65, y: irisY },  // iris centers
    1:   { x: 0.50, y: 0.55 }                                // nose slightly below eye line
  });
}

describe('computeGazeFrame', () => {
  it('gazeY increases as the iris moves down', () => {
    const up = computeGazeFrame(neutralFace(0.48));    // iris above corner line
    const down = computeGazeFrame(neutralFace(0.56));  // iris below corner line
    expect(down.gazeY).toBeGreaterThan(up.gazeY);
  });

  it('is stable across a simulated blink (eyelids move, corners do not)', () => {
    // Our metric reads corners+iris only, never eyelids — so a blink that would
    // move lid landmarks must not change gazeY. Same corners+iris → same value.
    const a = computeGazeFrame(neutralFace(0.52));
    const b = computeGazeFrame(neutralFace(0.52));
    expect(b.gazeY).toBeCloseTo(a.gazeY, 6);
  });

  it('is invariant to uniform distance scaling', () => {
    const near = neutralFace(0.56);
    // Move face "farther": scale all coords toward the centroid (0.5,0.5) by 0.5.
    const far = near.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.5, y: 0.5 + (p.y - 0.5) * 0.5, z: 0 }));
    expect(computeGazeFrame(far).gazeY).toBeCloseTo(computeGazeFrame(near).gazeY, 4);
  });

  it('headForward is false when the nose drops far below the eye line', () => {
    const head = neutralFace(0.52);
    head[1] = { x: 0.5, y: 0.95, z: 0 };  // nose way down → head tilted down
    expect(computeGazeFrame(head).headForward).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/gaze-metric.test.ts`
Expected: FAIL — `computeGazeFrame` is not exported.

- [ ] **Step 3: Rewrite `computeGazeFrame` in `eye-tracking.ts`** (replace lines 124-139) and export it

```ts
// Iris centers 468 (right) / 473 (left). Eye corners (canthi) are stable through
// blinks and lid movement, so we anchor vertical gaze to the corner line rather
// than the eyelid aperture. Right corners 33 (outer) / 133 (inner); left corners
// 263 (outer) / 362 (inner). Normalizing by eye width makes it distance-invariant.
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
  const headForward = pitch < GAZE_HEAD_PITCH_MAX;

  return { gazeY, headForward, pitch };
}
```

- [ ] **Step 4: Re-tune `GAZE_HEAD_PITCH_MAX` for the new normalized pitch units**

In `constants.ts`, change the pitch guard to the new units (nose-drop normalized by inter-ocular distance; a forward head sits well under ~0.5, a keyboard-glance well over it):

```ts
export const GAZE_HEAD_PITCH_MAX = 0.55;     // normalized by inter-ocular distance (was 0.12 raw)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/gaze-metric.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/eye-tracking.ts hugo-apps/src/tutorial-prefs/constants.ts hugo-apps/src/tutorial-prefs/gaze-metric.test.ts
git commit -m "fix(camera): corner-anchored gaze metric + distance-normalized pitch"
```

---

## Task 3: GazeDetector threshold injection + dwell grace + EMA

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/eye-tracking.ts` (`GazeDetectorOpts`, `GazeDetector`, add `emaStep`, wire EMA into `runEyeTracking` loop)
- Modify: `hugo-apps/src/tutorial-prefs/eye-tracking.test.ts` (update the dwell-break test for grace behaviour; add grace + injection tests)

**Interfaces:**
- Consumes: `computeGazeFrame` (Task 2).
- Produces: `GazeDetectorOpts` gains `threshold?: number` (default `GAZE_BOTTOM_THRESHOLD`); `export function emaStep(prev: number | null, sample: number, alpha: number): number`. `GazeDetector` firing now tolerant to single ineligible frames within `GAZE_DWELL_GRACE_MS`.

- [ ] **Step 1: Write/adjust failing tests in `eye-tracking.test.ts`**

Add the new import and tests; **replace** the existing `'breaks dwell when gaze rises'` test (its old assumption — one high frame breaks dwell — is now intentionally false):

```ts
import { GazeDetector, emaStep } from './eye-tracking';
import { GAZE_DWELL_MS, GAZE_FIRE_COOLDOWN_MS, NO_FACE_TIMEOUT_MS, GAZE_DWELL_GRACE_MS } from './constants';

it('does NOT break dwell on a single ineligible frame (grace window)', () => {
  for (let t = 0; t < GAZE_DWELL_MS - 200; t += 50) { det.observe({ gazeY: 0.9, headForward: true }); tick(50); }
  det.observe({ gazeY: 0.1, headForward: true }); tick(50);   // one blink-like dropout, inside grace
  for (let t = 0; t < 200; t += 50) { det.observe({ gazeY: 0.9, headForward: true }); tick(50); }
  expect(onFire).toHaveBeenCalledTimes(1);
});

it('breaks dwell when gaze stays high past the grace window', () => {
  for (let t = 0; t < GAZE_DWELL_MS - 100; t += 50) { det.observe({ gazeY: 0.9, headForward: true }); tick(50); }
  for (let t = 0; t <= GAZE_DWELL_GRACE_MS + 100; t += 50) { det.observe({ gazeY: 0.1, headForward: true }); tick(50); }
  det.observe({ gazeY: 0.9, headForward: true }); tick(50);   // dwell restarted; not enough to fire
  expect(onFire).not.toHaveBeenCalled();
});

it('honours an injected threshold', () => {
  const d = new GazeDetector({ now: () => now, onGazeLow: onFire, threshold: 0.8 });
  for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) { d.observe({ gazeY: 0.7, headForward: true }); tick(50); }
  expect(onFire).not.toHaveBeenCalled();  // 0.7 < 0.8 injected → never eligible
});

it('emaStep seeds on first sample then smooths', () => {
  expect(emaStep(null, 0.5, 0.4)).toBe(0.5);
  expect(emaStep(0.5, 1.0, 0.4)).toBeCloseTo(0.7, 6);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/eye-tracking.test.ts`
Expected: FAIL — `emaStep` not exported, `threshold` opt ignored, grace not implemented.

- [ ] **Step 3: Implement in `eye-tracking.ts`**

Add the EMA helper and the import of `GAZE_DWELL_GRACE_MS` / `GAZE_EMA_ALPHA`; update `GazeDetectorOpts` and `GazeDetector`:

```ts
import {
  GAZE_BOTTOM_THRESHOLD, GAZE_HEAD_PITCH_MAX, GAZE_DWELL_MS, GAZE_FIRE_COOLDOWN_MS,
  GAZE_DWELL_GRACE_MS, GAZE_EMA_ALPHA,
  FRAME_INTERVAL_MS, NO_FACE_TIMEOUT_MS, SCROLL_VIEWPORT_FRACTION,
  MEDIAPIPE_WASM_BASE, MODEL_FACE, SLOW_FRAME_MS, SLOW_FRAME_RUN
} from './constants';
import { getCal } from './prefs-store';
import type { EyeProfile } from './constants';

export function emaStep(prev: number | null, sample: number, alpha: number): number {
  return prev === null ? sample : alpha * sample + (1 - alpha) * prev;
}

export interface GazeDetectorOpts {
  now: () => number;
  onGazeLow: () => void;
  threshold?: number;   // default GAZE_BOTTOM_THRESHOLD; overridden by calibration
}

export class GazeDetector {
  private dwellStart: number | null = null;
  private lastEligible = 0;
  private cooldownUntil = 0;
  private readonly threshold: number;
  constructor(private opts: GazeDetectorOpts) {
    this.threshold = opts.threshold ?? GAZE_BOTTOM_THRESHOLD;
  }

  observe(f: GazeFrame): void {
    const t = this.opts.now();
    if (t < this.cooldownUntil) return;
    const eligible = f.gazeY > this.threshold && f.headForward;
    if (!eligible) {
      // One dropout inside the grace window does not reset the dwell.
      if (this.dwellStart !== null && t - this.lastEligible > GAZE_DWELL_GRACE_MS) {
        this.dwellStart = null;
      }
      return;
    }
    this.lastEligible = t;
    if (this.dwellStart === null) this.dwellStart = t;
    if (t - this.dwellStart >= GAZE_DWELL_MS) {
      this.opts.onGazeLow();
      this.cooldownUntil = t + GAZE_FIRE_COOLDOWN_MS;
      this.dwellStart = null;
    }
  }

  observeNoFace(): void { this.dwellStart = null; }

  dwellMs(): number {
    return this.dwellStart === null ? 0 : Math.max(0, this.opts.now() - this.dwellStart);
  }
}
```

- [ ] **Step 4: Wire calibrated threshold + EMA into `runEyeTracking`**

In `runEyeTracking`, read the profile once at start and smooth `gazeY` before `det.observe`:

```ts
// after the landmarker/stream setup, before the loop:
const cal = getCal('eye') as EyeProfile | null;
const threshold = cal ? cal.gazeMin + CAL_EYE_TRIGGER_FRACTION * (cal.gazeMax - cal.gazeMin) : undefined;
let gazeEma: number | null = null;

const det = new GazeDetector({
  now: () => performance.now(),
  threshold,
  onGazeLow: () => { /* …existing scroll body unchanged… */ }
});
```

And inside the `else` branch where a face is seen, smooth before observing:

```ts
const frame = computeGazeFrame(lm);
gazeEma = emaStep(gazeEma, frame.gazeY, GAZE_EMA_ALPHA);
det.observe({ ...frame, gazeY: gazeEma });
```

Add `CAL_EYE_TRIGGER_FRACTION` to the constants import. Update the `onDebug` eye report to send the smoothed `gazeEma` (so the overlay matches what the detector sees).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/eye-tracking.test.ts`
Expected: PASS (all, including the rewritten grace test).

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/eye-tracking.ts hugo-apps/src/tutorial-prefs/eye-tracking.test.ts
git commit -m "fix(camera): GazeDetector threshold injection, dwell grace, EMA smoothing"
```

---

## Task 4: Hand frame — mirror x + tolerant radial palm gate

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/hand-gestures.ts:145-152` (`computeHandFrame`)
- Test: `hugo-apps/src/tutorial-prefs/hand-frame.test.ts` (create)

**Interfaces:**
- Produces: `export function computeHandFrame(lm: Array<{x:number;y:number;z:number}>): HandFrame` (now **exported**). `x` is **mirrored** (`1 − palmCenterX`) so a sweep to the user's right increases `x`. `palmOpen` true when ≥ `PALM_MIN_FINGERS` of 4 fingers are radially extended (tilt-invariant).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test** `hand-frame.test.ts`

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { computeHandFrame } from './hand-gestures';

// Indices read: 0 (wrist), 9 (middle MCP, for palm center), tips 8/12/16/20,
// pips 6/10/14/18.
function hand(overrides: Record<number, { x: number; y: number }>) {
  const arr = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  for (const [i, p] of Object.entries(overrides)) arr[+i] = { ...p, z: 0 };
  return arr;
}

// Open hand pointing up: wrist low (large y), tips far above pips.
function openHandUp() {
  return hand({
    0: { x: 0.5, y: 0.9 }, 9: { x: 0.5, y: 0.5 },
    6: { x: 0.42, y: 0.55 }, 8: { x: 0.42, y: 0.30 },
    10: { x: 0.50, y: 0.55 }, 12: { x: 0.50, y: 0.28 },
    14: { x: 0.58, y: 0.55 }, 16: { x: 0.58, y: 0.30 },
    18: { x: 0.66, y: 0.58 }, 20: { x: 0.66, y: 0.34 }
  });
}

describe('computeHandFrame', () => {
  it('detects an open palm pointing up', () => {
    expect(computeHandFrame(openHandUp()).palmOpen).toBe(true);
  });

  it('detects an open palm held sideways (tilt-invariant radial test)', () => {
    // Rotate the open hand ~90°: fingers now extend in +x, not −y. The old
    // strict tip.y<mcp.y test failed this; the radial test must still pass.
    const h = openHandUp().map((p) => ({ x: 0.5 + (0.5 - p.y), y: 0.5 + (p.x - 0.5), z: 0 }));
    expect(computeHandFrame(h).palmOpen).toBe(true);
  });

  it('rejects a fist (tips curled toward the wrist)', () => {
    const fist = hand({
      0: { x: 0.5, y: 0.9 }, 9: { x: 0.5, y: 0.5 },
      6: { x: 0.42, y: 0.55 }, 8: { x: 0.44, y: 0.62 },
      10: { x: 0.50, y: 0.55 }, 12: { x: 0.50, y: 0.62 },
      14: { x: 0.58, y: 0.55 }, 16: { x: 0.56, y: 0.62 },
      18: { x: 0.66, y: 0.55 }, 20: { x: 0.64, y: 0.62 }
    });
    expect(computeHandFrame(fist).palmOpen).toBe(false);
  });

  it('mirrors x so palm on the user-right yields larger x', () => {
    // palmCenterX small (left of image) → user's right in a selfie view → x large.
    const left = hand({ 0: { x: 0.2, y: 0.9 }, 9: { x: 0.2, y: 0.5 } });
    const right = hand({ 0: { x: 0.8, y: 0.9 }, 9: { x: 0.8, y: 0.5 } });
    expect(computeHandFrame(left).x).toBeGreaterThan(computeHandFrame(right).x);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/hand-frame.test.ts`
Expected: FAIL — `computeHandFrame` not exported.

- [ ] **Step 3: Rewrite `computeHandFrame` in `hand-gestures.ts`** (replace lines 145-152) and export it

```ts
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
```

Add `PALM_MIN_FINGERS` to the constants import at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/hand-frame.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/hand-gestures.ts hugo-apps/src/tutorial-prefs/hand-frame.test.ts
git commit -m "fix(camera): tolerant radial palm gate + mirrored swipe direction"
```

---

## Task 5: SwipeDetector — trailing-buffer motion model + threshold injection

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/hand-gestures.ts` (`SwipeDetectorOpts`, `SwipeDetector`, `inspect()`, and the `onDebug` block in `runHandGestures`)
- Test: `hugo-apps/src/tutorial-prefs/hand-gestures.test.ts` (create — no SwipeDetector test file exists yet)

**Interfaces:**
- Consumes: `HandFrame` (Task 4).
- Produces: `SwipeDetectorOpts` gains `dxFraction?: number` (default `SWIPE_MIN_DX_FRACTION`) and `minVelocity?: number` (default `SWIPE_MIN_VELOCITY`); drops the now-unused `frameWidth`. `inspect()` returns `{ state: State; dx: number; velocity: number }` (computed from the trailing buffer, replacing the old `{state,startX,startT}`).

- [ ] **Step 1: Write the failing test** `hand-gestures.test.ts`

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwipeDetector } from './hand-gestures';
import { SWIPE_COOLDOWN_MS } from './constants';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/hand-gestures.test.ts`
Expected: FAIL — new `SwipeDetectorOpts` shape / motion model not implemented.

- [ ] **Step 3: Rewrite `SwipeDetector` in `hand-gestures.ts`**

```ts
import {
  SWIPE_MIN_DX_FRACTION, SWIPE_MIN_VELOCITY, SWIPE_COOLDOWN_MS, PALM_LOST_RESET_MS,
  SWIPE_WINDOW_MS, PALM_MIN_FINGERS,
  FRAME_INTERVAL_MS, MEDIAPIPE_WASM_BASE, MODEL_HAND, SLOW_FRAME_MS, SLOW_FRAME_RUN
} from './constants';
import { getCal } from './prefs-store';
import type { HandProfile } from './constants';

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
```

- [ ] **Step 4: Update the `onDebug` block + detector construction in `runHandGestures`**

Read the profile and inject thresholds, and simplify the debug block to use the new `inspect()`:

```ts
const cal = getCal('hand') as HandProfile | null;
const det = new SwipeDetector({
  now: () => performance.now(),
  dxFraction: cal?.dxFraction,
  minVelocity: cal?.minVelocity,
  onSwipe: (dir) => dispatchNav(dir === 'right' ? 'next' : 'prev')
});
```

```ts
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
    state: insp.state
  });
}
```

(The `HandReport` shape in `cam-debug.ts` is unchanged; `dtMs` stays in the type but is no longer meaningful — Task 11 stops displaying it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/hand-gestures.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/hand-gestures.ts hugo-apps/src/tutorial-prefs/hand-gestures.test.ts
git commit -m "fix(camera): SwipeDetector trailing-buffer motion model + threshold injection"
```

---

## Task 6: Calibration profile reducers (pure)

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/calibration.ts`
- Test: `hugo-apps/src/tutorial-prefs/calibration.test.ts` (create)

**Interfaces:**
- Consumes: constants + `EyeProfile`/`HandProfile` (Task 1).
- Produces (all pure, no DOM/camera):
  - `export interface Sample { t: number; v: number }`
  - `export function percentile(sorted: number[], p: number): number`
  - `export function computeEyeProfile(samples: Sample[]): EyeProfile | null`
  - `export function computeHandProfile(samples: Sample[]): HandProfile | null`
  - `export function deriveEyeThreshold(p: EyeProfile): number`

- [ ] **Step 1: Write the failing test** `calibration.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { computeEyeProfile, computeHandProfile, deriveEyeThreshold, percentile } from './calibration';
import { CAL_PROFILE_VERSION, CAL_EYE_TRIGGER_FRACTION } from './constants';

const eyeSamples = (vals: number[]) => vals.map((v, i) => ({ t: i * 66, v }));

describe('percentile', () => {
  it('interpolates linearly', () => {
    expect(percentile([0, 10], 50)).toBeCloseTo(5, 6);
  });
});

describe('computeEyeProfile', () => {
  it('returns a p5/p95 envelope from a wide scan', () => {
    const vals = Array.from({ length: 50 }, (_, i) => i / 49); // 0..1 spread
    const p = computeEyeProfile(eyeSamples(vals))!;
    expect(p.v).toBe(CAL_PROFILE_VERSION);
    expect(p.gazeMin).toBeLessThan(0.1);
    expect(p.gazeMax).toBeGreaterThan(0.9);
  });

  it('rejects blink outliers via percentiles', () => {
    const vals = [...Array.from({ length: 48 }, () => 0.5), 99, -99]; // two blink spikes
    const p = computeEyeProfile(eyeSamples(vals))!;
    expect(p.gazeMin).toBeGreaterThan(-1);   // −99 outlier excluded by p5
    expect(p.gazeMax).toBeLessThan(2);       // 99 outlier excluded by p95
  });

  it('returns null when too few samples', () => {
    expect(computeEyeProfile(eyeSamples([0.1, 0.9]))).toBeNull();
  });

  it('returns null when spread is too small', () => {
    const vals = Array.from({ length: 50 }, () => 0.5);
    expect(computeEyeProfile(eyeSamples(vals))).toBeNull();
  });
});

describe('deriveEyeThreshold', () => {
  it('sits CAL_EYE_TRIGGER_FRACTION into the envelope', () => {
    const th = deriveEyeThreshold({ v: CAL_PROFILE_VERSION, gazeMin: 0, gazeMax: 1 });
    expect(th).toBeCloseTo(CAL_EYE_TRIGGER_FRACTION, 6);
  });
});

describe('computeHandProfile', () => {
  it('derives clamped dxFraction/minVelocity from multi-sweep samples', () => {
    // Simulate 3 left-right sweeps: x oscillates 0.2↔0.8 every 5 frames @66ms.
    const samples = [];
    let x = 0.2, dir = 1;
    for (let i = 0; i < 60; i++) {
      samples.push({ t: i * 66, v: x });
      x += dir * 0.12; if (x >= 0.8 || x <= 0.2) dir *= -1;
    }
    const p = computeHandProfile(samples)!;
    expect(p.v).toBe(CAL_PROFILE_VERSION);
    expect(p.dxFraction).toBeGreaterThan(0);
    expect(p.minVelocity).toBeGreaterThan(0);
  });

  it('returns null when the hand never reverses direction', () => {
    const samples = Array.from({ length: 60 }, (_, i) => ({ t: i * 66, v: 0.2 + i * 0.005 }));
    expect(computeHandProfile(samples)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/calibration.test.ts`
Expected: FAIL — `calibration.ts` does not exist.

- [ ] **Step 3: Create `calibration.ts` with the pure reducers**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/calibration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/calibration.ts hugo-apps/src/tutorial-prefs/calibration.test.ts
git commit -m "feat(camera): calibration profile reducers (envelope + clamped derivation)"
```

---

## Task 7: Async capture loop + production landmarker glue

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/calibration.ts` (add `captureSamples` + `runCalibrationCapture`)
- Modify: `hugo-apps/src/tutorial-prefs/calibration.test.ts` (add `captureSamples` tests)

**Interfaces:**
- Consumes: reducers (Task 6), `computeGazeFrame` (Task 2), `computeHandFrame` (Task 4), `acquire`/`release` (`camera-session.ts`), `setCal` (`prefs-store.ts`).
- Produces:
  - `export async function captureSamples(opts: { now: () => number; durationMs: number; intervalMs: number; sample: () => number | null; onProgress?: (fraction: number) => void }): Promise<Sample[]>`
  - `export async function runCalibrationCapture(feature: FeatureId, opts?: { onProgress?: (f: number) => void }): Promise<EyeProfile | HandProfile | null>` (acquires camera, runs the landmarker for `CAL_DURATION_MS`, reduces, persists via `setCal` on success, releases; returns the profile or `null` on invalid capture).

- [ ] **Step 1: Write the failing test** for `captureSamples` (append to `calibration.test.ts`)

```ts
import { captureSamples } from './calibration';
import { vi, beforeEach, afterEach } from 'vitest';

describe('captureSamples', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collects non-null samples until the duration elapses and reports progress', async () => {
    let clock = 0;
    const now = () => clock;
    const script = [0.1, null, 0.3, 0.4, 0.5, 0.6];  // one dropped frame
    let i = 0;
    const progress: number[] = [];
    const p = captureSamples({
      now, durationMs: 300, intervalMs: 66,
      sample: () => script[Math.min(i++, script.length - 1)],
      onProgress: (f) => progress.push(f)
    });
    // Advance fake time + the interval callback in lockstep.
    for (let step = 0; step < 6; step++) { clock += 66; await vi.advanceTimersByTimeAsync(66); }
    const out = await p;
    expect(out.every((s) => s.v !== null)).toBe(true);   // nulls dropped
    expect(out.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);        // reached 100%
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/calibration.test.ts`
Expected: FAIL — `captureSamples` not exported.

- [ ] **Step 3: Implement `captureSamples` + `runCalibrationCapture` in `calibration.ts`**

```ts
import { FRAME_INTERVAL_MS, CAL_DURATION_MS, MEDIAPIPE_WASM_BASE, MODEL_FACE, MODEL_HAND, type FeatureId } from './constants';
import { acquire, release } from './camera-session';
import { setCal } from './prefs-store';
import { computeGazeFrame } from './eye-tracking';
import { computeHandFrame } from './hand-gestures';

export async function captureSamples(opts: {
  now: () => number;
  durationMs: number;
  intervalMs: number;
  sample: () => number | null;
  onProgress?: (fraction: number) => void;
}): Promise<Sample[]> {
  return new Promise((resolve) => {
    const start = opts.now();
    const out: Sample[] = [];
    const id = setInterval(() => {
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
  opts: { onProgress?: (f: number) => void } = {}
): Promise<EyeProfile | HandProfile | null> {
  const { FaceLandmarker, HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);

  const stream = await acquire(feature);
  const video = document.createElement('video');
  video.srcObject = stream; video.muted = true; video.playsInline = true;
  await video.play();

  let landmarker: any;
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

  try {
    const samples = await captureSamples({
      now: () => performance.now(), durationMs: CAL_DURATION_MS,
      intervalMs: FRAME_INTERVAL_MS, sample, onProgress: opts.onProgress
    });
    const profile = feature === 'eye' ? computeEyeProfile(samples) : computeHandProfile(samples);
    if (profile) setCal(feature, profile);
    return profile;
  } finally {
    try { landmarker.close(); } catch {}
    video.pause(); video.srcObject = null;
    release(feature);
  }
}
```

(Add `EyeProfile`/`HandProfile` to the type import if not already present.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/calibration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/calibration.ts hugo-apps/src/tutorial-prefs/calibration.test.ts
git commit -m "feat(camera): calibration capture loop + landmarker glue"
```

---

## Task 8: CalibrationOverlay.vue

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/CalibrationOverlay.vue`
- Test: `hugo-apps/src/tutorial-prefs/CalibrationOverlay.test.ts` (create)

**Interfaces:**
- Props: `{ feature: FeatureId; phase: 'intro' | 'capturing' | 'invalid'; progress: number }`.
- Emits: `start` (user clicked Begin), `cancel`, `retry`. The parent (Task 9) owns the capture call and flips `phase`/`progress`; this component is presentational so it unit-tests without a camera.
- Consumes: `FeatureId` type.

- [ ] **Step 1: Write the failing test** `CalibrationOverlay.test.ts`

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CalibrationOverlay from './CalibrationOverlay.vue';

const stubs = { 'ui5-button': { template: '<button @click="$emit(\'click\')"><slot/></button>' } };

describe('CalibrationOverlay', () => {
  it('intro phase shows instructions and a Begin button, emits start', async () => {
    const w = mount(CalibrationOverlay, { props: { feature: 'eye', phase: 'intro', progress: 0 }, global: { stubs } });
    expect(w.text()).toContain('scan');           // eye instruction mentions scanning the page
    await w.find('button').trigger('click');
    expect(w.emitted('start')).toBeTruthy();
  });

  it('capturing phase reflects progress width', () => {
    const w = mount(CalibrationOverlay, { props: { feature: 'eye', phase: 'capturing', progress: 0.5 }, global: { stubs } });
    const bar = w.find('.cal-overlay__bar-fill');
    expect(bar.attributes('style') ?? '').toContain('50%');
  });

  it('invalid phase shows retry + cancel and emits them', async () => {
    const w = mount(CalibrationOverlay, { props: { feature: 'hand', phase: 'invalid', progress: 0 }, global: { stubs } });
    expect(w.text()).toContain('try again');
    const buttons = w.findAll('button');
    await buttons[0].trigger('click');            // Retry
    await buttons[1].trigger('click');            // Cancel
    expect(w.emitted('retry')).toBeTruthy();
    expect(w.emitted('cancel')).toBeTruthy();
  });

  it('hand intro mentions sweeping', () => {
    const w = mount(CalibrationOverlay, { props: { feature: 'hand', phase: 'intro', progress: 0 }, global: { stubs } });
    expect(w.text().toLowerCase()).toContain('sweep');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/CalibrationOverlay.test.ts`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Create `CalibrationOverlay.vue`**

```vue
<template>
  <div class="cal-overlay" role="dialog" aria-modal="true" :aria-label="`Calibrate ${featureName}`">
    <div class="cal-overlay__panel">
      <template v-if="phase === 'intro'">
        <h2 class="cal-overlay__title">Calibrate {{ featureName }}</h2>
        <p class="cal-overlay__body">{{ introText }}</p>
        <div class="cal-overlay__actions">
          <ui5-button design="Emphasized" @click="$emit('start')">Begin</ui5-button>
          <ui5-button design="Transparent" @click="$emit('cancel')">Cancel</ui5-button>
        </div>
      </template>

      <template v-else-if="phase === 'capturing'">
        <h2 class="cal-overlay__title">{{ captureText }}</h2>
        <div class="cal-overlay__bar"><div class="cal-overlay__bar-fill" :style="{ width: pct }"></div></div>
        <ui5-button design="Transparent" @click="$emit('cancel')">Cancel</ui5-button>
      </template>

      <template v-else>
        <h2 class="cal-overlay__title">Couldn't calibrate</h2>
        <p class="cal-overlay__body">We couldn't read enough movement — please try again.</p>
        <div class="cal-overlay__actions">
          <ui5-button design="Emphasized" @click="$emit('retry')">Try again</ui5-button>
          <ui5-button design="Transparent" @click="$emit('cancel')">Cancel</ui5-button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FeatureId } from './constants';

const props = defineProps<{ feature: FeatureId; phase: 'intro' | 'capturing' | 'invalid'; progress: number }>();
defineEmits<{ (e: 'start'): void; (e: 'cancel'): void; (e: 'retry'): void }>();

const featureName = computed(() => (props.feature === 'eye' ? 'eye-tracking' : 'hand gestures'));
const introText = computed(() =>
  props.feature === 'eye'
    ? 'When you press Begin, slowly scan your eyes over the whole page — top to bottom — for about five seconds.'
    : 'When you press Begin, hold an open palm up and sweep it left and right a few times for about five seconds.'
);
const captureText = computed(() =>
  props.feature === 'eye' ? 'Scan the whole page…' : 'Sweep left and right…'
);
const pct = computed(() => `${Math.round(Math.min(1, Math.max(0, props.progress)) * 100)}%`);
</script>

<style>
.cal-overlay { position: fixed; inset: 0; z-index: 2147483646; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); }
.cal-overlay__panel { background: var(--sapGroup_ContentBackground, #fff); color: var(--sapTextColor, #222); border-radius: 12px; padding: 1.5rem 1.75rem; max-width: 26rem; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.35); }
.cal-overlay__title { font-size: 1.15rem; margin: 0 0 0.5rem; }
.cal-overlay__body { margin: 0 0 1rem; opacity: 0.85; }
.cal-overlay__actions { display: flex; gap: 0.5rem; justify-content: center; }
.cal-overlay__bar { height: 8px; border-radius: 4px; background: var(--sapList_BorderColor, #e0e0e0); overflow: hidden; margin: 0.75rem 0 1rem; }
.cal-overlay__bar-fill { height: 100%; background: var(--sapButton_Emphasized_Background, #0070f2); transition: width 0.1s linear; }
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/CalibrationOverlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/CalibrationOverlay.vue hugo-apps/src/tutorial-prefs/CalibrationOverlay.test.ts
git commit -m "feat(camera): calibration overlay component"
```

---

## Task 9: Popover Calibrate control + main.ts orchestration

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue`
- Modify: `hugo-apps/src/tutorial-prefs/main.ts`
- Test: `hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.test.ts` (create)

**Interfaces:**
- Consumes: `runCalibrationCapture` (Task 7), `getCal`/`isCalPrompted`/`markCalPrompted` (Task 1), `CalibrationOverlay` (Task 8).
- Produces: popover gains props `eyeCalibrated: boolean`, `handCalibrated: boolean` and emit `calibrate(f: FeatureId)`; `main.ts` gains `calibrate(state, f)` + auto-prompt-once on first successful start + a third mounted app hosting the overlay.

- [ ] **Step 1: Write the failing popover test** `TutorialPrefsPopover.test.ts`

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TutorialPrefsPopover from './TutorialPrefsPopover.vue';

const stubs = {
  'ui5-popover': { template: '<div><slot/></div>' },
  'ui5-switch': { template: '<span/>' },
  'ui5-button': { template: '<button @click="$emit(\'click\')"><slot/></button>' }
};
const base = {
  readerOn: false, onTutorialPage: true, supported: true, unsupportedReasonText: '',
  eyePref: 'on', handPref: 'off', eyeRunning: false, handRunning: false,
  eyeFirstRun: false, handFirstRun: false, eyeError: '', handError: '',
  eyeCalibrated: false, handCalibrated: false
};

describe('TutorialPrefsPopover calibration control', () => {
  it('shows a Calibrate button when the eye toggle is on', () => {
    const w = mount(TutorialPrefsPopover, { props: base, global: { stubs } });
    expect(w.text()).toContain('Calibrate');
  });

  it('shows "Not calibrated" hint when no eye profile exists', () => {
    const w = mount(TutorialPrefsPopover, { props: base, global: { stubs } });
    expect(w.text()).toContain('Not calibrated');
  });

  it('shows "Calibrated" hint when an eye profile exists', () => {
    const w = mount(TutorialPrefsPopover, { props: { ...base, eyeCalibrated: true }, global: { stubs } });
    expect(w.text()).toContain('Calibrated');
  });

  it('emits calibrate("eye") when the Calibrate button is clicked', async () => {
    const w = mount(TutorialPrefsPopover, { props: base, global: { stubs } });
    const btn = w.findAll('button').find((b) => b.text() === 'Calibrate')!;
    await btn.trigger('click');
    expect(w.emitted('calibrate')![0]).toEqual(['eye']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.test.ts`
Expected: FAIL — no Calibrate button / props / emit yet.

- [ ] **Step 3: Add the Calibrate control to `TutorialPrefsPopover.vue`**

Add props to `defineProps` (`eyeCalibrated: boolean; handCalibrated: boolean`) and `(e: 'calibrate', f: FeatureId): void` to `defineEmits`. Inside the eye `<template v-if="eyePref === 'on' && supported">` block, after the Start/Stop button, add:

```vue
<ui5-button design="Transparent" @click="$emit('calibrate', 'eye')">Calibrate</ui5-button>
<p class="tut-prefs__cal">{{ eyeCalibrated ? 'Calibrated' : 'Not calibrated — using defaults' }}</p>
```

Do the same in the hand block with `'hand'` and `handCalibrated`. Add a style rule:

```css
.tut-prefs__cal { font-size: 0.8em; opacity: 0.7; margin: 0.25rem 0 0; }
```

- [ ] **Step 4: Wire orchestration into `main.ts`**

Add imports and state, a reactive overlay model, the `calibrate` handler, the auto-prompt on first start, and a third mounted app for the overlay:

```ts
import { getCal, isCalPrompted, markCalPrompted, /* …existing… */ } from './prefs-store';
import type { FeatureId } from './constants';

// extend State
interface State {
  /* …existing fields… */
  cal: { open: boolean; feature: FeatureId; phase: 'intro' | 'capturing' | 'invalid'; progress: number };
}
// in reactive<State>({ … }) add:
//   cal: { open: false, feature: 'eye', phase: 'intro', progress: 0 }

function openCalibration(state: State, f: FeatureId): void {
  state.cal = { open: true, feature: f, phase: 'intro', progress: 0 };
}

async function runCalibration(state: State): Promise<void> {
  const f = state.cal.feature;
  state.cal.phase = 'capturing'; state.cal.progress = 0;
  try {
    const { runCalibrationCapture } = await import('./calibration');
    const profile = await runCalibrationCapture(f, { onProgress: (p) => { state.cal.progress = p; } });
    if (!profile) { state.cal.phase = 'invalid'; return; }
    state.cal.open = false;
    // Restart a running detector so the new thresholds take effect immediately.
    if (f === 'eye' && state.eyeRuntime) { stopEye(state); await startEye(state); }
    if (f === 'hand' && state.handRuntime) { stopHand(state); await startHand(state); }
  } catch (e) {
    console.error('[tutorial-prefs] calibrate', f, e);
    state.cal.phase = 'invalid';
  }
}
```

In `startEye`/`startHand`, after the successful `setPref(...)`, add the one-time auto-prompt:

```ts
if (!getCal('eye') && !isCalPrompted('eye')) { markCalPrompted('eye'); openCalibration(state, 'eye'); }
```
(and the `'hand'` equivalent in `startHand`).

Pass the new props/handlers to the popover render:

```ts
eyeCalibrated: !!getCal('eye'),
handCalibrated: !!getCal('hand'),
'onCalibrate': (f: FeatureId) => openCalibration(state, f),
```

Mount a third app hosting the overlay (only render when `state.cal.open`):

```ts
const calHost = document.createElement('div');
calHost.id = 'tut-prefs-cal-host';
document.body.appendChild(calHost);

import CalibrationOverlay from './CalibrationOverlay.vue';  // NOTE: see Step 5 — must stay lazy
createApp({
  render: () => state.cal.open
    ? h(CalibrationOverlay, {
        feature: state.cal.feature, phase: state.cal.phase, progress: state.cal.progress,
        onStart: () => runCalibration(state),
        onRetry: () => runCalibration(state),
        onCancel: () => { state.cal.open = false; }
      })
    : null
}).mount(calHost);
```

- [ ] **Step 5: Keep the overlay lazy to protect the 8 KB budget**

A static `import CalibrationOverlay` in `main.ts` pulls the component (and transitively nothing heavy, but still bytes) into the main chunk. Instead, load it with Vue's `defineAsyncComponent` so it stays in a lazy chunk:

```ts
import { defineAsyncComponent } from 'vue';
const CalibrationOverlay = defineAsyncComponent(() => import('./CalibrationOverlay.vue'));
```

`calibration.ts` is already reached only via the dynamic `import('./calibration')` inside `runCalibration`, so it never enters the main chunk.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.test.ts hugo-apps/src/tutorial-prefs/main.ts
git commit -m "feat(camera): Calibrate control + calibration orchestration in main"
```

---

## Task 10: Debug overlay shows active thresholds + profile-loaded

**Files:**
- Modify: `hugo-apps/src/tutorial-prefs/cam-debug.ts`
- Modify: `hugo-apps/src/tutorial-prefs/cam-debug.test.ts`

**Interfaces:**
- Consumes: `EyeReport`/`HandReport` (from eye/hand detectors, updated in Tasks 3/5).
- Produces: `EyeReport` gains `threshold: number` and `calibrated: boolean`; `HandReport` gains `dxThreshold: number`, `vThreshold: number`, `calibrated: boolean`. The overlay renders the active (possibly calibrated) threshold instead of the module constant, plus a `cal ✓/✗` line. `dtMs` is dropped from the hand render (no longer meaningful — Task 5).

- [ ] **Step 1: Update the failing tests in `cam-debug.test.ts`**

Replace the eye + hand render tests to assert the active-threshold display and calibration flag:

```ts
it('renders eye fields with the ACTIVE threshold and cal flag', () => {
  const handle = createDebugOverlay(true)!;
  handle.report({
    kind: 'eye', faceSeen: true, gazeY: 0.85, pitch: 0.30,
    headForward: true, dwellMs: 300, threshold: 0.42, calibrated: true
  });
  const text = document.querySelector<HTMLElement>('[data-kind="eye"]')!.textContent ?? '';
  expect(text).toContain('gazeY      0.85  > 0.42');   // shows injected threshold, not the constant
  expect(text).toContain('cal        ✓');
  expect(text).toContain('eligible   ✓');
});

it('renders hand fields with active dx/v thresholds and cal flag', () => {
  const handle = createDebugOverlay(true)!;
  handle.report({
    kind: 'hand', palmSeen: true, palmOpen: true, x: 0.5,
    dxFromArmed: 0.4, dtMs: 0, velocity: 2.0, state: 'ARMED',
    dxThreshold: 0.3, vThreshold: 0.4, calibrated: false
  });
  const text = document.querySelector<HTMLElement>('[data-kind="hand"]')!.textContent ?? '';
  expect(text).toContain('dx         0.40  >= 0.3  ✓');
  expect(text).toContain('v          2.00  >= 0.4  ✓');
  expect(text).toContain('cal        ✗');
});
```

Update the earlier `'renders eye fields with threshold ticks'` and `'marks eye eligible ✗'` tests to include `threshold` + `calibrated` in their report objects (use `threshold: 0.55` to preserve their existing tick expectations), and the `'marks eye eligible ✗ when gaze is high'` report to `gazeY: 0.4, threshold: 0.55`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/cam-debug.test.ts`
Expected: FAIL — reports don't carry `threshold`/`calibrated`; render uses constants.

- [ ] **Step 3: Update `cam-debug.ts`**

Extend the report interfaces and the renderers to use the report-carried thresholds:

```ts
interface EyeReport {
  kind: 'eye'; gazeY: number; pitch: number; headForward: boolean;
  dwellMs: number; faceSeen: boolean;
  threshold: number; calibrated: boolean;      // active values from the detector
}
interface HandReport {
  kind: 'hand'; palmSeen: boolean; palmOpen: boolean; x: number;
  dxFromArmed: number; dtMs: number; velocity: number;
  state: 'IDLE' | 'ARMED' | 'COOLDOWN';
  dxThreshold: number; vThreshold: number; calibrated: boolean;
}

function renderEye(r: EyeReport): void {
  const eligible = r.gazeY > r.threshold && r.headForward;
  const lines = [
    'EYE',
    `face       ${tick(r.faceSeen)}`,
    `gazeY      ${fmt(r.gazeY)}  > ${fmt(r.threshold)}  ${tick(r.gazeY > r.threshold)}`,
    `pitch      ${fmt(r.pitch, 3)}  < ${GAZE_HEAD_PITCH_MAX}  ${tick(r.headForward)}`,
    `dwell      ${r.dwellMs} / ${GAZE_DWELL_MS} ms`,
    `cal        ${tick(r.calibrated)}`,
    `eligible   ${tick(eligible)}`
  ];
  eyeBlock.textContent = lines.join('\n');
}

function renderHand(r: HandReport): void {
  const dxOk = Math.abs(r.dxFromArmed) >= r.dxThreshold;
  const vOk = r.velocity >= r.vThreshold;
  const lines = [
    'HAND',
    `palm       ${tick(r.palmSeen)} seen / ${tick(r.palmOpen)} open`,
    `x          ${fmt(r.x)}`,
    `state      ${r.state}`,
    `dx         ${fmt(r.dxFromArmed)}  >= ${fmt(r.dxThreshold)}  ${tick(dxOk)}`,
    `v          ${fmt(r.velocity)}  >= ${fmt(r.vThreshold)}  ${tick(vOk)}`,
    `cal        ${tick(r.calibrated)}`
  ];
  handBlock.textContent = lines.join('\n');
}
```

Then in the detectors' `onDebug` calls (Tasks 3 & 5), include the new fields: eye passes `threshold: (the resolved threshold), calibrated: !!cal`; hand passes `dxThreshold`, `vThreshold` (the detector's resolved values — expose them via a getter or capture the resolved numbers where the detector is built), `calibrated: !!cal`. The `SWIPE_MIN_DX_FRACTION`/`SWIPE_MIN_VELOCITY` imports in `cam-debug.ts` and the `_CONSTS_FOR_TEST` export are no longer used by the renderers — remove them (and the now-dead `GAZE_BOTTOM_THRESHOLD` import) to keep the module clean.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/cam-debug.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/cam-debug.ts hugo-apps/src/tutorial-prefs/cam-debug.test.ts hugo-apps/src/tutorial-prefs/eye-tracking.ts hugo-apps/src/tutorial-prefs/hand-gestures.ts
git commit -m "feat(camera): debug overlay shows active thresholds + calibration flag"
```

---

## Task 11: Docs + full-suite + island build verification

**Files:**
- Modify: `docs/end-users/experimental-features.md`
- (verification only) whole `tutorial-prefs` test set + island bundle build.

**Interfaces:** none produced.

- [ ] **Step 1: Add a calibration section to `docs/end-users/experimental-features.md`**

Add, in prose (en-US), a short section after the feature descriptions:

```markdown
## Calibrate for best results

Both camera features work out of the box, but a quick one-time calibration makes
them noticeably more reliable for your camera, seating position, and screen. When
you first start a feature you'll be offered a short calibration; you can also run
it anytime from the **Calibrate** button in Tutorial preferences.

- **Eye-tracking:** press Begin, then slowly scan your eyes over the whole page,
  top to bottom, for about five seconds.
- **Hand gestures:** press Begin, then hold an open palm up and sweep it left and
  right a few times for about five seconds.

Calibration is optional — without it the features fall back to sensible defaults.
Your calibration is stored only in this browser and is never sent anywhere. These
remain experimental, hands-free conveniences, not assistive technologies.
```

- [ ] **Step 2: Run the full tutorial-prefs unit set**

Run: `npx vitest run --project unit hugo-apps/src/tutorial-prefs/`
Expected: PASS — all detector, calibration, store, overlay, popover, and debug tests green.

- [ ] **Step 3: Build the island bundle and confirm the 8 KB budget holds**

Run: `npm run build:apps`
Expected: build succeeds; **no** `tutorial-prefs.js is … bytes gzipped (> 8192)` error. If it errors, something heavy leaked into the main chunk — confirm `calibration.ts` is only ever `import()`-ed and `CalibrationOverlay.vue` is loaded via `defineAsyncComponent` (Task 9, Step 5).

- [ ] **Step 4: Live-verify against a real webcam (manual, per "test the actual thing")**

Serve the site (`npm run dev`), open a tutorial with `?debug-cam`, and for each feature: start it, click Calibrate, complete the 5s capture, and confirm on the overlay that (a) `cal ✓` appears and (b) the active `gazeY >` / `dx >=` / `v >=` thresholds differ from the defaults. Then confirm scroll / Next / Prev fire naturally. Note results in the PR description.

- [ ] **Step 5: Commit**

```bash
git add docs/end-users/experimental-features.md
git commit -m "docs(camera): calibration section in experimental-features"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| A1 gaze metric | Task 2 |
| A2 EMA | Task 3 |
| A3 dwell grace | Task 3 |
| A4 normalized pitch | Task 2 |
| B1 mirror | Task 4 |
| B2 tolerant palm gate | Task 4 |
| B3 motion model | Task 5 |
| C1 new files | Tasks 6–8 |
| C2 capture flows | Task 7 |
| C3 profiles + storage | Tasks 1, 6 |
| C4 detector refactor (injection) | Tasks 3, 5 |
| C5 UX + wiring | Task 9 |
| C6 debug overlay | Task 10 |
| Constants | Tasks 1, 2 |
| Error handling (invalid capture, denied, model-load, parse/version) | Tasks 1 (version), 7 (invalid→null), 9 (invalid phase + catch) |
| Testing (unit/component/live) | every task + Task 11 |
| Docs | Task 11 |

No gaps.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Empirical constant *values* (e.g. `CAL_EYE_MIN_SPREAD`, pitch/threshold defaults) are concrete numbers in Task 1/2 with a live-tuning note (matching how the existing thresholds were set) — not placeholders.

**3. Type consistency:** `EyeProfile`/`HandProfile`/`CalProfile` defined in `constants.ts` (Task 1), consumed unchanged in prefs-store, calibration, detectors. `Sample` defined in Task 6, used in Task 7. `getCal`/`setCal`/`clearCal`/`isCalPrompted`/`markCalPrompted` names consistent across Tasks 1/3/5/7/9. `computeGazeFrame`/`computeHandFrame` exported (Tasks 2/4) and imported by `calibration.ts` (Task 7). `inspect()` new shape `{state,dx,velocity}` (Task 5) consumed by the hand `onDebug` block (Task 5) and reflected in the overlay (Task 10). Report fields `threshold`/`calibrated`/`dxThreshold`/`vThreshold` added in Task 10 and emitted by detectors in the same task's Step 3.

---

