# Experimental Camera-Input — Plan (Part 2: Tasks 7–12)

> Continuation of [`./2026-05-28-experimental-camera-input.md`](./2026-05-28-experimental-camera-input.md). Pre-flight, file structure, and tasks 1–6 live there. Tasks 13–18 live in [`./2026-05-28-experimental-camera-input-part3.md`](./2026-05-28-experimental-camera-input-part3.md).

---

## Task 7: Eye-tracking algorithm (pure functions)

Goal: A pure-function detector that takes face-landmark frames and emits `gaze-low` events with the dwell + cooldown state machine. MediaPipe wiring is added in Task 9.

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/eye-tracking.ts` (algorithm shell only here)
- Test: `hugo-apps/src/tutorial-prefs/eye-tracking.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GazeDetector } from './eye-tracking';
import { GAZE_DWELL_MS, GAZE_FIRE_COOLDOWN_MS, NO_FACE_TIMEOUT_MS } from './constants';

describe('GazeDetector', () => {
  let now = 0; const tick = (ms: number) => { now += ms; };
  let onFire: ReturnType<typeof vi.fn>;
  let det: GazeDetector;

  beforeEach(() => {
    now = 0; onFire = vi.fn();
    det = new GazeDetector({ now: () => now, onGazeLow: onFire });
  });

  it('does not fire on a single low frame', () => {
    det.observe({ gazeY: 0.9, headForward: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it('fires after sustained low gaze for DWELL ms', () => {
    for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('does not fire if head is tilted down', () => {
    for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) {
      det.observe({ gazeY: 0.9, headForward: false });
      tick(50);
    }
    expect(onFire).not.toHaveBeenCalled();
  });

  it('respects fire cooldown', () => {
    for (let t = 0; t <= GAZE_DWELL_MS + 50; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).toHaveBeenCalledTimes(1);
    for (let t = 0; t < GAZE_FIRE_COOLDOWN_MS - 100; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('breaks dwell when gaze rises', () => {
    for (let t = 0; t < GAZE_DWELL_MS - 100; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    det.observe({ gazeY: 0.4, headForward: true });
    tick(50);
    for (let t = 0; t < GAZE_DWELL_MS - 100; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).not.toHaveBeenCalled();
  });

  it('observeNoFace clears the dwell window', () => {
    for (let t = 0; t < GAZE_DWELL_MS / 2; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    det.observeNoFace();
    tick(NO_FACE_TIMEOUT_MS + 50);
    for (let t = 0; t < GAZE_DWELL_MS / 2; t += 50) {
      det.observe({ gazeY: 0.9, headForward: true });
      tick(50);
    }
    expect(onFire).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npx vitest run hugo-apps/src/tutorial-prefs/eye-tracking.test.ts
```

- [ ] **Step 3: Implement the algorithm shell of `eye-tracking.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/eye-tracking.ts hugo-apps/src/tutorial-prefs/eye-tracking.test.ts
git commit -m "feat(tutorial-prefs): add GazeDetector dwell+cooldown state machine"
```

---

## Task 8: Hand-gesture algorithm (pure state machine)

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/hand-gestures.ts` (algorithm shell only here)
- Test: `hugo-apps/src/tutorial-prefs/hand-gestures.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwipeDetector } from './hand-gestures';
import { SWIPE_COOLDOWN_MS, PALM_LOST_RESET_MS } from './constants';

describe('SwipeDetector', () => {
  let now = 0; const tick = (ms: number) => { now += ms; };
  let onSwipe: ReturnType<typeof vi.fn>;
  let det: SwipeDetector;

  beforeEach(() => {
    now = 0; onSwipe = vi.fn();
    det = new SwipeDetector({ now: () => now, frameWidth: 1, onSwipe });
  });

  it('emits "right" on a fast positive sweep', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.55 });
    expect(onSwipe).toHaveBeenCalledWith('right');
  });

  it('emits "left" on a fast negative sweep', () => {
    det.observe({ palmOpen: true, x: 0.9 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.45 });
    expect(onSwipe).toHaveBeenCalledWith('left');
  });

  it('does not fire below dx threshold', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.25 });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('does not fire below velocity threshold', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(2000);
    det.observe({ palmOpen: true, x: 0.55 });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('resets when palm lost beyond reset window', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(PALM_LOST_RESET_MS + 100);
    det.observe({ palmOpen: false, x: 0 });
    tick(50);
    det.observe({ palmOpen: true, x: 0.55 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.6 });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('respects cooldown', () => {
    det.observe({ palmOpen: true, x: 0.1 });
    tick(200);
    det.observe({ palmOpen: true, x: 0.55 });
    expect(onSwipe).toHaveBeenCalledTimes(1);
    tick(SWIPE_COOLDOWN_MS - 100);
    det.observe({ palmOpen: true, x: 0.1 });
    tick(100);
    det.observe({ palmOpen: true, x: 0.55 });
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `hand-gestures.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/hand-gestures.ts hugo-apps/src/tutorial-prefs/hand-gestures.test.ts
git commit -m "feat(tutorial-prefs): add SwipeDetector with cooldown and palm-loss reset"
```

---

## Task 9: Eye-tracking MediaPipe wiring

Goal: Append a `runEyeTracking()` async function that wires `FaceLandmarker` + camera + `requestAnimationFrame` to `GazeDetector`. Returns a stop function. Integration code; correctness is verified via the manual test plan in Task 16.

**Files:** Modify `hugo-apps/src/tutorial-prefs/eye-tracking.ts` (append; do NOT replace existing exports).

- [ ] **Step 1: Append the runtime wiring**

```ts
import {
  FRAME_INTERVAL_MS, NO_FACE_TIMEOUT_MS, SCROLL_VIEWPORT_FRACTION,
  MEDIAPIPE_WASM_BASE, MODEL_FACE, SLOW_FRAME_MS, SLOW_FRAME_RUN
} from './constants';
import { acquire, release } from './camera-session';

interface EyeRuntime { stop: () => void; }
interface RunOpts { reducedMotion: boolean; onError: (e: Error) => void; onSlow: () => void; }

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
      } else {
        lastFace = performance.now();
        det.observe(computeGazeFrame(lm));
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
  const pitch = nose.y - eyeMidY;     // positive ≈ head tilted down
  const headForward = pitch < 0.06;

  return { gazeY, headForward };
}
```

- [ ] **Step 2: Re-run unit tests; algorithm tests must still pass**

```bash
npx vitest run hugo-apps/src/tutorial-prefs/eye-tracking.test.ts
cd hugo-apps && npx tsc --noEmit && cd ..
```

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/eye-tracking.ts
git commit -m "feat(tutorial-prefs): wire FaceLandmarker + camera + rAF loop to GazeDetector"
```

---

## Task 10: Hand-gesture MediaPipe wiring

**Files:** Modify `hugo-apps/src/tutorial-prefs/hand-gestures.ts` (append).

- [ ] **Step 1: Append the runtime wiring**

```ts
import {
  FRAME_INTERVAL_MS, MEDIAPIPE_WASM_BASE, MODEL_HAND,
  SLOW_FRAME_MS, SLOW_FRAME_RUN
} from './constants';
import { acquire, release } from './camera-session';
import { dispatchNav } from './nav-dispatch';

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
```

- [ ] **Step 2: Re-run unit tests; type-check**

```bash
npx vitest run hugo-apps/src/tutorial-prefs/hand-gestures.test.ts
cd hugo-apps && npx tsc --noEmit && cd ..
```

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/hand-gestures.ts
git commit -m "feat(tutorial-prefs): wire HandLandmarker + camera + rAF loop to SwipeDetector"
```

---

## Task 11: CameraBadge.vue

**Files:** Create `hugo-apps/src/tutorial-prefs/CameraBadge.vue`

- [ ] **Step 1: Implement the component**

```vue
<template>
  <ui5-message-strip
    v-if="active.length > 0"
    class="tut-prefs-cam-badge"
    design="Information"
    hide-close-button
  >
    Camera active — {{ label }}
    <ui5-button design="Transparent" @click="$emit('stop')">Stop</ui5-button>
    <span v-if="slow" class="tut-prefs-cam-badge__slow">
      Detection is slow on this device — accuracy may suffer.
    </span>
  </ui5-message-strip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FeatureId } from './constants';

const props = defineProps<{ active: FeatureId[]; slow?: boolean }>();
defineEmits<{ (e: 'stop'): void }>();

const label = computed(() => {
  const parts: string[] = [];
  if (props.active.includes('eye')) parts.push('eye-tracking');
  if (props.active.includes('hand')) parts.push('gestures');
  return parts.join(', ');
});
</script>

<style>
.tut-prefs-cam-badge {
  position: fixed;
  top: var(--tut-prefs-cam-badge-top, 4rem);
  right: 1rem;
  z-index: 9999;
  max-width: 28rem;
}
.tut-prefs-cam-badge__slow { display: block; margin-top: 0.25rem; opacity: 0.85; font-size: 0.85em; }
</style>
```

- [ ] **Step 2: Type-check**

```bash
cd hugo-apps && npx tsc --noEmit && cd ..
```

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/CameraBadge.vue
git commit -m "feat(tutorial-prefs): add CameraBadge.vue active-camera pill"
```

---

## Task 12: TutorialPrefsPopover.vue

**Files:** Create `hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue`

- [ ] **Step 1: Implement the component**

```vue
<template>
  <ui5-popover ref="popoverRef" placement="Bottom" horizontal-align="End" hide-arrow header-text="Tutorial preferences">
    <div class="tut-prefs">
      <section class="tut-prefs__row">
        <label class="tut-prefs__label">
          <span>Reader mode <span class="tut-prefs__hint">(f)</span></span>
          <ui5-switch :checked="readerOn || undefined" @change="$emit('toggle-reader')"></ui5-switch>
        </label>
        <p class="tut-prefs__desc">Hide chrome and focus on the content.</p>
      </section>

      <template v-if="onTutorialPage">
        <hr class="tut-prefs__sep" />
        <p class="tut-prefs__group-label">Experimental</p>

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Eye-tracking auto-scroll</span>
            <ui5-switch
              :checked="eyePref === 'on' || undefined"
              :disabled="!supported || undefined"
              @change="$emit('toggle-pref', 'eye')"
            ></ui5-switch>
          </label>
          <p class="tut-prefs__desc">
            Uses your webcam. The page scrolls down when you look near the bottom for about half a second. Stays running until you stop it or close the tab.
          </p>
          <template v-if="eyePref === 'on' && supported">
            <ui5-button v-if="eyeRunning" design="Transparent" @click="$emit('stop', 'eye')">Stop camera</ui5-button>
            <ui5-button v-else @click="$emit('start', 'eye')">Start camera</ui5-button>
            <p v-if="eyeRunning" class="tut-prefs__state">
              Look at the bottom of the page for half a second to scroll.
            </p>
            <p v-else-if="eyeFirstRun" class="tut-prefs__nudge">
              Press <strong>Start camera</strong> to try it.
            </p>
            <p v-if="eyeError" class="tut-prefs__error">{{ eyeError }}</p>
          </template>
        </section>

        <hr class="tut-prefs__sep" />

        <section class="tut-prefs__row">
          <label class="tut-prefs__label">
            <span>Hand-gesture step nav</span>
            <ui5-switch
              :checked="handPref === 'on' || undefined"
              :disabled="!supported || undefined"
              @change="$emit('toggle-pref', 'hand')"
            ></ui5-switch>
          </label>
          <p class="tut-prefs__desc">
            Uses your webcam. Hold an open palm to the camera, then sweep left or right to go to the previous or next step.
          </p>
          <template v-if="handPref === 'on' && supported">
            <ui5-button v-if="handRunning" design="Transparent" @click="$emit('stop', 'hand')">Stop camera</ui5-button>
            <ui5-button v-else @click="$emit('start', 'hand')">Start camera</ui5-button>
            <p v-if="handRunning" class="tut-prefs__state">
              Show an open palm, then sweep left or right.
            </p>
            <p v-else-if="handFirstRun" class="tut-prefs__nudge">
              Press <strong>Start camera</strong> to try it.
            </p>
            <p v-if="handError" class="tut-prefs__error">{{ handError }}</p>
          </template>
        </section>

        <p v-if="!supported" class="tut-prefs__unsupported">
          {{ unsupportedReasonText }}
        </p>
      </template>

      <hr class="tut-prefs__sep" />
      <p class="tut-prefs__footer">
        Camera processing happens entirely in your browser. Nothing is sent to a server.
        <a href="/end-users/experimental-features" target="_blank" rel="noopener">Learn more</a>
      </p>
    </div>
  </ui5-popover>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { FeatureId } from './constants';

defineProps<{
  readerOn: boolean;
  onTutorialPage: boolean;
  supported: boolean;
  unsupportedReasonText: string;
  eyePref: 'on' | 'off';
  handPref: 'on' | 'off';
  eyeRunning: boolean;
  handRunning: boolean;
  eyeFirstRun: boolean;
  handFirstRun: boolean;
  eyeError: string;
  handError: string;
}>();
defineEmits<{
  (e: 'toggle-reader'): void;
  (e: 'toggle-pref', f: FeatureId): void;
  (e: 'start', f: FeatureId): void;
  (e: 'stop', f: FeatureId): void;
}>();

const popoverRef = ref<HTMLElement | null>(null);
defineExpose({
  open(opener: HTMLElement) {
    (popoverRef.value as any).opener = opener;
    (popoverRef.value as any).open = true;
  },
  close() { if (popoverRef.value) (popoverRef.value as any).open = false; }
});
</script>

<style>
.tut-prefs { padding: 0.5rem 0.75rem; min-width: 22rem; }
.tut-prefs__row { padding: 0.25rem 0; }
.tut-prefs__label { display: flex; align-items: center; justify-content: space-between; gap: 1rem; font-weight: 600; }
.tut-prefs__hint { font-weight: 400; opacity: 0.6; margin-left: 0.25rem; }
.tut-prefs__desc { margin: 0.25rem 0 0.5rem; opacity: 0.85; font-size: 0.9em; }
.tut-prefs__group-label { font-size: 0.8em; text-transform: uppercase; opacity: 0.6; margin: 0.5rem 0 0.25rem; }
.tut-prefs__sep { border: none; border-top: 1px solid var(--sapList_BorderColor, #e0e0e0); margin: 0.5rem 0; }
.tut-prefs__state { font-size: 0.85em; opacity: 0.8; margin: 0.5rem 0 0; }
.tut-prefs__nudge { font-size: 0.85em; color: var(--sapInformativeTextColor, #0070f2); margin: 0.5rem 0 0; }
.tut-prefs__error { font-size: 0.85em; color: var(--sapNegativeTextColor, #b00); margin: 0.5rem 0 0; }
.tut-prefs__unsupported { font-size: 0.85em; opacity: 0.7; margin: 0.5rem 0 0; }
.tut-prefs__footer { font-size: 0.8em; opacity: 0.7; margin: 0.5rem 0 0; }
</style>
```

- [ ] **Step 2: Type-check**

```bash
cd hugo-apps && npx tsc --noEmit && cd ..
```

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/TutorialPrefsPopover.vue
git commit -m "feat(tutorial-prefs): add TutorialPrefsPopover.vue layout"
```

---

(Tasks 13–18 continue in [`./2026-05-28-experimental-camera-input-part3.md`](./2026-05-28-experimental-camera-input-part3.md).)
