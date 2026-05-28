# Experimental Camera-Input Tutorial Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two opt-in webcam features (eye-tracking auto-scroll, hand-gesture step navigation) under a single "Tutorial preferences" gear icon that also subsumes the existing reader-mode toggle, with all detection running locally via `@mediapipe/tasks-vision`.

**Architecture:** A new Vue 3 island `tutorial-prefs` mounts a `ui5-popover` opened from a shellbar gear button (`sb-prefs`) that replaces the current `sb-reader` shellbar item. Two lazy-loaded detector modules (`eye-tracking.ts`, `hand-gestures.ts`) share a single `MediaStream` via a reference-counted `camera-session.ts` singleton. Preferences persist in `localStorage`; active-camera consent is `sessionStorage` (tab-scoped). MediaPipe WASM and `.task` model files are vendored to `hugo/static/vendor/mediapipe/` at build time. No XSUAA, HANA, or backend changes.

**Tech Stack:** Vue 3, TypeScript, Vite, `@mediapipe/tasks-vision`, UI5 Web Components (existing), Vitest with `happy-dom` (existing convention).

**Spec:** [docs/superpowers/specs/2026-05-28-experimental-camera-input-design.md](../specs/2026-05-28-experimental-camera-input-design.md)

The full task list (18 tasks) is split across companion files because of size:

- This file: tasks 1–6 (vendoring, constants, browser-support, prefs-store, camera-session, nav-dispatch).
- [`./2026-05-28-experimental-camera-input-part2.md`](./2026-05-28-experimental-camera-input-part2.md): tasks 7–12 (algorithms, MediaPipe wiring, components).
- [`./2026-05-28-experimental-camera-input-part3.md`](./2026-05-28-experimental-camera-input-part3.md): tasks 13–18 (orchestrator, vite entry, header swap, manual smoke, docs, verification).

---

## Pre-flight

- Fresh worktree under `.worktrees/<branch>/` with `npm install` complete (also `cd hugo-apps && npm install`).
- Verify Node ≥ 20: `node --version`.
- Verify base unit tests pass before starting: `npm test -- --run` should show 620+ passing.
- Verify Hugo + hugo-apps build cleanly today: `npm run build:apps && npm run build:hugo`.

If any of those fail, stop and surface the failure.

---

## File Structure (full)

**Created:**

```
hugo-apps/src/tutorial-prefs/
├── main.ts                      # island entry; wires up shellbar item + popover
├── TutorialPrefsPopover.vue     # popover with toggles + footer
├── CameraBadge.vue              # fixed-position "Camera active" pill
├── camera-session.ts            # singleton MediaStream owner with refcount
├── eye-tracking.ts              # lazy: Face Landmarker wrapper
├── hand-gestures.ts             # lazy: Hand Landmarker wrapper
├── prefs-store.ts               # localStorage / sessionStorage helpers
├── nav-dispatch.ts              # locate + click prev/next nav pills
├── constants.ts                 # detection thresholds + selectors
├── browser-support.ts           # feature detection
├── prefs-store.test.ts
├── camera-session.test.ts
├── eye-tracking.test.ts
├── hand-gestures.test.ts
├── nav-dispatch.test.ts
└── browser-support.test.ts

scripts/
└── vendor-mediapipe.cjs         # build-time copy of WASM + .task assets

docs/end-users/
└── experimental-features.md     # "Learn more" doc page
```

**Modified:**

- `hugo-apps/vite.config.ts` — add `tutorial-prefs` entry; add bundle-size-assertion plugin
- `hugo-apps/package.json` — add `@mediapipe/tasks-vision` dep
- `hugo/layouts/partials/header.html` — replace `sb-reader` with `sb-prefs`; remove old reader-popover code; load `tutorial-prefs.js`
- `hugo/assets/css/ui5-overrides.css` — popover + badge layout (small additions only)
- `package.json` — add `vendor:mediapipe` script; wire into `build:apps`
- `.gitignore` — ignore `hugo/static/vendor/mediapipe/`
- `docs/.vitepress/config.ts` — register `experimental-features.md` in end-users sidebar

**Net header icon delta: 0** (replaces `sb-reader` with `sb-prefs`).

---

## Task 1: Vendor MediaPipe assets at build time

Goal: Copy WASM + model files into `hugo/static/vendor/mediapipe/` so MediaPipe runs without a Google CDN at runtime.

**Files:**
- Create: `scripts/vendor-mediapipe.cjs`
- Modify: `hugo-apps/package.json` (add `@mediapipe/tasks-vision`)
- Modify: `package.json` (add `vendor:mediapipe` script + chain into `build:apps`)
- Modify: `.gitignore`

- [ ] **Step 1: Add the dependency**

```bash
cd hugo-apps && npm install --save @mediapipe/tasks-vision@^0.10.17 && cd ..
```

Verify: `jq '.dependencies' hugo-apps/package.json` shows `@mediapipe/tasks-vision`.

- [ ] **Step 2: Write the vendor script**

Create `scripts/vendor-mediapipe.cjs`:

```js
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'hugo-apps', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const DEST_DIR = path.join(ROOT, 'hugo', 'static', 'vendor', 'mediapipe');

const RUNTIME_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm'
];

const MODEL_URLS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
};

async function downloadIfMissing(name, url) {
  const dest = path.join(DEST_DIR, name);
  if (fs.existsSync(dest)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model fetch ${name} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`  downloaded ${name} (${buf.length} bytes)`);
}

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`Missing ${SRC_DIR}. Run "cd hugo-apps && npm install" first.`);
  }
  for (const f of RUNTIME_FILES) {
    const src = path.join(SRC_DIR, f);
    if (!fs.existsSync(src)) throw new Error(`Missing ${src}`);
    fs.copyFileSync(src, path.join(DEST_DIR, f));
    console.log(`  copied ${f}`);
  }
  for (const [name, url] of Object.entries(MODEL_URLS)) {
    await downloadIfMissing(name, url);
  }
  console.log('MediaPipe assets vendored to', DEST_DIR);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Wire into npm scripts**

Add to root `package.json` `scripts`:

```json
"vendor:mediapipe": "node scripts/vendor-mediapipe.cjs"
```

Then prepend it to the existing `build:apps` script. Locate with `jq '.scripts."build:apps"' package.json` and rewrite as `npm run vendor:mediapipe && <existing>`.

- [ ] **Step 4: Gitignore the output**

Append to `.gitignore`:

```
hugo/static/vendor/mediapipe/
```

- [ ] **Step 5: Run it once and verify**

```bash
npm run vendor:mediapipe
ls hugo/static/vendor/mediapipe/
```

Expected: 4 runtime files + 2 `.task` models.

- [ ] **Step 6: Commit**

```bash
git add scripts/vendor-mediapipe.cjs package.json hugo-apps/package.json hugo-apps/package-lock.json .gitignore
git commit -m "build(deps): vendor @mediapipe/tasks-vision assets for tutorial-prefs island"
```

---

## Task 2: Constants module

Goal: Single source of truth for thresholds, selectors, and storage keys.

**Files:** Create `hugo-apps/src/tutorial-prefs/constants.ts`

- [ ] **Step 1: Write `constants.ts`**

```ts
export const TARGET_FPS = 15;
export const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

export const GAZE_BOTTOM_THRESHOLD = 0.7;
export const GAZE_DWELL_MS = 600;
export const GAZE_FIRE_COOLDOWN_MS = 1200;
export const NO_FACE_TIMEOUT_MS = 1000;
export const SCROLL_VIEWPORT_FRACTION = 0.85;

export const SWIPE_MIN_DX_FRACTION = 0.30;
export const SWIPE_MIN_VELOCITY = 1.5;
export const SWIPE_COOLDOWN_MS = 800;
export const PALM_LOST_RESET_MS = 200;

export const SLOW_FRAME_MS = 100;
export const SLOW_FRAME_RUN = 5;

export const KEY_PREF_EYE = 'tut.pref.eyeTrack';
export const KEY_PREF_HAND = 'tut.pref.handGest';
export const KEY_SESSION_CAM = 'tut.cam.session';
export const KEY_FIRSTRUN_EYE = 'tut.pref.eyeTrack.firstRun';
export const KEY_FIRSTRUN_HAND = 'tut.pref.handGest.firstRun';
export const KEY_READER = 'reader';

// Stable selectors used by nav-dispatch. nav-dispatch.test.ts exercises
// these against a fixture, so a future U2 refactor that renames classes
// fails the test before gestures silently break.
export const SEL_NAV_NEXT = '.tutorial-stepnav__slot--next .nav-pill';
export const SEL_NAV_PREV = '.tutorial-stepnav__slot--prev .nav-pill';

export const MEDIAPIPE_WASM_BASE = '/vendor/mediapipe';
export const MODEL_FACE = '/vendor/mediapipe/face_landmarker.task';
export const MODEL_HAND = '/vendor/mediapipe/hand_landmarker.task';

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { width: 640, height: 480, frameRate: 30 }
};

export const PAGE_KIND_TUTORIAL = 'tutorial';

export type FeatureId = 'eye' | 'hand';
```

- [ ] **Step 2: Type-check**

```bash
cd hugo-apps && npx tsc --noEmit && cd ..
```

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/constants.ts
git commit -m "feat(tutorial-prefs): add constants module"
```

---

## Task 3: Browser-support feature detection

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/browser-support.ts`
- Test: `hugo-apps/src/tutorial-prefs/browser-support.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectSupport } from './browser-support';

describe('detectSupport', () => {
  const origMM = window.matchMedia;
  afterEach(() => { window.matchMedia = origMM; vi.restoreAllMocks(); });

  function withMM(matches: Record<string, boolean>) {
    window.matchMedia = ((q: string) => ({
      matches: !!matches[q], media: q,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
      onchange: null
    })) as any;
  }

  it('returns supported=true when all APIs and desktop media queries pass', () => {
    withMM({ '(pointer: fine)': true, '(min-width: 768px)': true });
    (navigator as any).mediaDevices = { getUserMedia: vi.fn() };
    const r = detectSupport();
    expect(r.supported).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('flags getUserMedia missing', () => {
    withMM({ '(pointer: fine)': true, '(min-width: 768px)': true });
    (navigator as any).mediaDevices = undefined;
    const r = detectSupport();
    expect(r.supported).toBe(false);
    expect(r.reasons).toContain('camera-api');
  });

  it('flags coarse pointer or narrow viewport as mobile', () => {
    withMM({ '(pointer: fine)': false, '(min-width: 768px)': true });
    (navigator as any).mediaDevices = { getUserMedia: vi.fn() };
    expect(detectSupport().reasons).toContain('mobile');
    withMM({ '(pointer: fine)': true, '(min-width: 768px)': false });
    expect(detectSupport().reasons).toContain('mobile');
  });

  it('reports prefers-reduced-motion', () => {
    withMM({ '(pointer: fine)': true, '(min-width: 768px)': true, '(prefers-reduced-motion: reduce)': true });
    (navigator as any).mediaDevices = { getUserMedia: vi.fn() };
    expect(detectSupport().prefersReducedMotion).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npx vitest run hugo-apps/src/tutorial-prefs/browser-support.test.ts
```

- [ ] **Step 3: Implement `browser-support.ts`**

```ts
export type UnsupportedReason = 'camera-api' | 'wasm' | 'offscreen-canvas' | 'raf' | 'mobile';

export interface SupportReport {
  supported: boolean;
  reasons: UnsupportedReason[];
  prefersReducedMotion: boolean;
}

function mq(query: string): boolean {
  try { return window.matchMedia(query).matches; } catch { return false; }
}

export function detectSupport(): SupportReport {
  const reasons: UnsupportedReason[] = [];
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') reasons.push('camera-api');
  if (typeof (globalThis as any).WebAssembly === 'undefined') reasons.push('wasm');
  if (typeof (globalThis as any).OffscreenCanvas === 'undefined') reasons.push('offscreen-canvas');
  if (typeof requestAnimationFrame !== 'function') reasons.push('raf');
  if (!mq('(pointer: fine)') || !mq('(min-width: 768px)')) reasons.push('mobile');
  return {
    supported: reasons.length === 0,
    reasons,
    prefersReducedMotion: mq('(prefers-reduced-motion: reduce)')
  };
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/browser-support.ts hugo-apps/src/tutorial-prefs/browser-support.test.ts
git commit -m "feat(tutorial-prefs): add browser-support feature detection"
```

---

## Task 4: Preferences store

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/prefs-store.ts`
- Test: `hugo-apps/src/tutorial-prefs/prefs-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPref, setPref, getSession, addSession, removeSession,
  consumeFirstRun, isFirstRun
} from './prefs-store';

describe('prefs-store', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it('defaults eye/hand prefs to off', () => {
    expect(getPref('eye')).toBe('off');
    expect(getPref('hand')).toBe('off');
  });

  it('round-trips eye pref', () => {
    setPref('eye', 'on');
    expect(getPref('eye')).toBe('on');
    setPref('eye', 'off');
    expect(getPref('eye')).toBe('off');
  });

  it('session marker is a set of features', () => {
    expect(getSession()).toEqual([]);
    addSession('eye');
    expect(getSession().sort()).toEqual(['eye']);
    addSession('hand');
    expect(getSession().sort()).toEqual(['eye', 'hand']);
    removeSession('eye');
    expect(getSession()).toEqual(['hand']);
    removeSession('hand');
    expect(getSession()).toEqual([]);
    expect(sessionStorage.getItem('tut.cam.session')).toBeNull();
  });

  it('firstRun is true once, then consumed', () => {
    expect(isFirstRun('eye')).toBe(true);
    consumeFirstRun('eye');
    expect(isFirstRun('eye')).toBe(false);
  });

  it('survives storage exceptions silently', () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('quota'); };
    expect(() => setPref('eye', 'on')).not.toThrow();
    Storage.prototype.setItem = orig;
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `prefs-store.ts`**

```ts
import {
  KEY_PREF_EYE, KEY_PREF_HAND, KEY_SESSION_CAM,
  KEY_FIRSTRUN_EYE, KEY_FIRSTRUN_HAND,
  type FeatureId
} from './constants';

type Toggle = 'on' | 'off';

const PREF_KEY: Record<FeatureId, string> = { eye: KEY_PREF_EYE, hand: KEY_PREF_HAND };
const FR_KEY: Record<FeatureId, string> = { eye: KEY_FIRSTRUN_EYE, hand: KEY_FIRSTRUN_HAND };

function safeLocal(): Storage | null { try { return localStorage; } catch { return null; } }
function safeSession(): Storage | null { try { return sessionStorage; } catch { return null; } }
function safeSet(s: Storage | null, k: string, v: string) { try { s?.setItem(k, v); } catch {} }
function safeRemove(s: Storage | null, k: string) { try { s?.removeItem(k); } catch {} }

export function getPref(f: FeatureId): Toggle {
  return safeLocal()?.getItem(PREF_KEY[f]) === 'on' ? 'on' : 'off';
}

export function setPref(f: FeatureId, v: Toggle): void {
  safeSet(safeLocal(), PREF_KEY[f], v);
}

export function isFirstRun(f: FeatureId): boolean {
  return safeLocal()?.getItem(FR_KEY[f]) !== '1';
}

export function consumeFirstRun(f: FeatureId): void {
  safeSet(safeLocal(), FR_KEY[f], '1');
}

function readSession(): FeatureId[] {
  const raw = safeSession()?.getItem(KEY_SESSION_CAM) ?? '';
  return raw.split('+').filter((x): x is FeatureId => x === 'eye' || x === 'hand');
}

function writeSession(features: FeatureId[]): void {
  if (features.length === 0) safeRemove(safeSession(), KEY_SESSION_CAM);
  else safeSet(safeSession(), KEY_SESSION_CAM, [...new Set(features)].join('+'));
}

export function getSession(): FeatureId[] { return readSession(); }
export function addSession(f: FeatureId): void { writeSession([...readSession(), f]); }
export function removeSession(f: FeatureId): void { writeSession(readSession().filter((x) => x !== f)); }
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/prefs-store.ts hugo-apps/src/tutorial-prefs/prefs-store.test.ts
git commit -m "feat(tutorial-prefs): add prefs-store with localStorage and sessionStorage helpers"
```

---

## Task 5: Camera-session singleton

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/camera-session.ts`
- Test: `hugo-apps/src/tutorial-prefs/camera-session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { acquire, release, getActiveConsumers, _resetForTests } from './camera-session';

function fakeTrack() { return { stop: vi.fn() }; }
function fakeStream(tracks = [fakeTrack(), fakeTrack()]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

describe('camera-session', () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sessionStorage.clear();
    _resetForTests();
    getUserMedia = vi.fn().mockResolvedValue(fakeStream());
    (navigator as any).mediaDevices = { getUserMedia };
  });
  afterEach(() => vi.restoreAllMocks());

  it('first acquire calls getUserMedia and returns a stream', async () => {
    const s = await acquire('eye');
    expect(s).toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getActiveConsumers().sort()).toEqual(['eye']);
  });

  it('second acquire reuses the same stream', async () => {
    const s1 = await acquire('eye');
    const s2 = await acquire('hand');
    expect(s1).toBe(s2);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getActiveConsumers().sort()).toEqual(['eye', 'hand']);
  });

  it('release of one keeps stream alive for the other', async () => {
    const tracks = [fakeTrack(), fakeTrack()];
    getUserMedia.mockResolvedValue(fakeStream(tracks));
    await acquire('eye'); await acquire('hand');
    release('eye');
    expect(tracks[0].stop).not.toHaveBeenCalled();
    expect(getActiveConsumers()).toEqual(['hand']);
  });

  it('releasing the last consumer stops all tracks', async () => {
    const tracks = [fakeTrack(), fakeTrack()];
    getUserMedia.mockResolvedValue(fakeStream(tracks));
    await acquire('eye');
    release('eye');
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(tracks[1].stop).toHaveBeenCalledTimes(1);
    expect(getActiveConsumers()).toEqual([]);
  });

  it('rejects when getUserMedia throws and leaves no active consumer', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    await expect(acquire('eye')).rejects.toThrow();
    expect(getActiveConsumers()).toEqual([]);
  });

  it('idempotent release is harmless', async () => {
    await acquire('eye'); release('eye'); release('eye');
    expect(getActiveConsumers()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `camera-session.ts`**

```ts
import { CAMERA_CONSTRAINTS, type FeatureId } from './constants';
import { addSession, removeSession } from './prefs-store';

let stream: MediaStream | null = null;
let inflight: Promise<MediaStream> | null = null;
const consumers = new Set<FeatureId>();

export function getActiveConsumers(): FeatureId[] { return [...consumers]; }

export async function acquire(consumer: FeatureId): Promise<MediaStream> {
  if (stream) {
    consumers.add(consumer);
    addSession(consumer);
    return stream;
  }
  if (inflight) {
    const s = await inflight;
    consumers.add(consumer);
    addSession(consumer);
    return s;
  }
  inflight = navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS).then((s) => {
    stream = s; inflight = null; return s;
  }).catch((err) => { inflight = null; throw err; });
  const s = await inflight;
  consumers.add(consumer);
  addSession(consumer);
  return s;
}

export function release(consumer: FeatureId): void {
  if (!consumers.has(consumer)) return;
  consumers.delete(consumer);
  removeSession(consumer);
  if (consumers.size === 0 && stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

// Test-only.
export function _resetForTests(): void {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; inflight = null; consumers.clear();
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/camera-session.ts hugo-apps/src/tutorial-prefs/camera-session.test.ts
git commit -m "feat(tutorial-prefs): add reference-counted camera-session singleton"
```

---

## Task 6: Nav-dispatch helper

Goal: Locate next/prev nav pills via the constants' selectors and click them. Includes a regression test that fails if those selectors disappear from the DOM. Test fixture is built via `createElement`/`appendChild` to avoid bulk-HTML-write properties.

**Files:**
- Create: `hugo-apps/src/tutorial-prefs/nav-dispatch.ts`
- Test: `hugo-apps/src/tutorial-prefs/nav-dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchNav, hasNext, hasPrev } from './nav-dispatch';
import { SEL_NAV_NEXT, SEL_NAV_PREV } from './constants';

function setupStepNav({ next, prev }: { next: boolean; prev: boolean }) {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

  const wrap = document.createElement('div');
  wrap.className = 'tutorial-stepnav';
  wrap.setAttribute('role', 'navigation');

  const inner = document.createElement('div');
  inner.className = 'tutorial-stepnav__inner';
  wrap.appendChild(inner);

  const prevSlot = document.createElement('div');
  prevSlot.className = 'tutorial-stepnav__slot tutorial-stepnav__slot--prev';
  if (prev) {
    const a = document.createElement('a');
    a.className = 'nav-pill';
    a.setAttribute('href', '/tutorials/prev');
    a.appendChild(document.createTextNode('Previous'));
    prevSlot.appendChild(a);
  }
  inner.appendChild(prevSlot);

  const nextSlot = document.createElement('div');
  nextSlot.className = 'tutorial-stepnav__slot tutorial-stepnav__slot--next';
  if (next) {
    const a = document.createElement('a');
    a.className = 'nav-pill nav-pill--primary';
    a.setAttribute('href', '/tutorials/next');
    a.appendChild(document.createTextNode('Next'));
    nextSlot.appendChild(a);
  }
  inner.appendChild(nextSlot);

  document.body.appendChild(wrap);
}

describe('nav-dispatch', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  it('hasNext / hasPrev reflect DOM state', () => {
    setupStepNav({ next: true, prev: false });
    expect(hasNext()).toBe(true);
    expect(hasPrev()).toBe(false);
  });

  it('dispatchNav("next") clicks the next pill', () => {
    setupStepNav({ next: true, prev: true });
    const next = document.querySelector(SEL_NAV_NEXT) as HTMLAnchorElement;
    const click = vi.spyOn(next, 'click').mockImplementation(() => {});
    dispatchNav('next');
    expect(click).toHaveBeenCalledOnce();
  });

  it('dispatchNav("prev") clicks the prev pill', () => {
    setupStepNav({ next: true, prev: true });
    const prev = document.querySelector(SEL_NAV_PREV) as HTMLAnchorElement;
    const click = vi.spyOn(prev, 'click').mockImplementation(() => {});
    dispatchNav('prev');
    expect(click).toHaveBeenCalledOnce();
  });

  it('dispatchNav is a no-op when target is missing', () => {
    setupStepNav({ next: false, prev: false });
    expect(() => dispatchNav('next')).not.toThrow();
    expect(() => dispatchNav('prev')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `nav-dispatch.ts`**

```ts
import { SEL_NAV_NEXT, SEL_NAV_PREV } from './constants';

export type NavDir = 'next' | 'prev';
const SEL: Record<NavDir, string> = { next: SEL_NAV_NEXT, prev: SEL_NAV_PREV };

export function hasNext(): boolean { return !!document.querySelector(SEL_NAV_NEXT); }
export function hasPrev(): boolean { return !!document.querySelector(SEL_NAV_PREV); }

export function dispatchNav(dir: NavDir): void {
  const a = document.querySelector(SEL[dir]) as HTMLAnchorElement | null;
  if (a) a.click();
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/nav-dispatch.ts hugo-apps/src/tutorial-prefs/nav-dispatch.test.ts
git commit -m "feat(tutorial-prefs): add nav-dispatch helper for gesture-driven step navigation"
```

---

(Tasks 7–18 continue in the companion files referenced at the top of this document.)
