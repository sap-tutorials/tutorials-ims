# Experimental Camera-Input — Plan (Part 3: Tasks 13–18)

> Continuation of [`./2026-05-28-experimental-camera-input.md`](./2026-05-28-experimental-camera-input.md) and [`./2026-05-28-experimental-camera-input-part2.md`](./2026-05-28-experimental-camera-input-part2.md).

---

## Task 13: Island entry `main.ts` (orchestrator)

Goal: Wire the popover, badge, prefs-store, and runtime detectors together. Mount only when the `sb-prefs` shellbar item exists. Auto-resume from `sessionStorage` on tutorial pages.

**Files:** Create `hugo-apps/src/tutorial-prefs/main.ts`

- [ ] **Step 1: Implement the orchestrator**

```ts
import { createApp, h, reactive, ref } from 'vue';
import TutorialPrefsPopover from './TutorialPrefsPopover.vue';
import CameraBadge from './CameraBadge.vue';
import {
  getPref, setPref, getSession, removeSession,
  isFirstRun, consumeFirstRun
} from './prefs-store';
import { detectSupport } from './browser-support';
import { PAGE_KIND_TUTORIAL, KEY_READER, type FeatureId } from './constants';

interface Runtime { stop: () => void; }

interface State {
  readerOn: boolean;
  eyePref: 'on' | 'off';
  handPref: 'on' | 'off';
  eyeRuntime: Runtime | null;
  handRuntime: Runtime | null;
  eyeError: string;
  handError: string;
  slow: boolean;
}

function unsupportedText(reasons: string[]): string {
  if (reasons.includes('mobile')) return 'Available on desktop browsers only.';
  if (reasons.length > 0) return "Your browser doesn't support this feature.";
  return '';
}

async function startEye(state: State): Promise<void> {
  state.eyeError = '';
  try {
    const { runEyeTracking } = await import('./eye-tracking');
    state.eyeRuntime = await runEyeTracking({
      reducedMotion: detectSupport().prefersReducedMotion,
      onError: (e) => {
        state.eyeError = 'Detection stopped unexpectedly. Try again later.';
        console.error('[tutorial-prefs] eye-tracking', e);
        stopEye(state);
      },
      onSlow: () => { state.slow = true; }
    });
    consumeFirstRun('eye');
    setPref('eye', 'on');
  } catch (err: any) {
    handleStartError(state, 'eye', err);
  }
}

function stopEye(state: State): void {
  state.eyeRuntime?.stop();
  state.eyeRuntime = null;
  removeSession('eye');
}

async function startHand(state: State): Promise<void> {
  state.handError = '';
  try {
    const { runHandGestures } = await import('./hand-gestures');
    state.handRuntime = await runHandGestures({
      onError: (e) => {
        state.handError = 'Detection stopped unexpectedly. Try again later.';
        console.error('[tutorial-prefs] hand-gestures', e);
        stopHand(state);
      },
      onSlow: () => { state.slow = true; }
    });
    consumeFirstRun('hand');
    setPref('hand', 'on');
  } catch (err: any) {
    handleStartError(state, 'hand', err);
  }
}

function stopHand(state: State): void {
  state.handRuntime?.stop();
  state.handRuntime = null;
  removeSession('hand');
}

function handleStartError(state: State, f: FeatureId, err: any): void {
  console.error('[tutorial-prefs] start', f, err);
  const msg =
    err?.name === 'NotAllowedError' ? 'Camera permission was denied. Allow the camera in your browser to use this feature.' :
    err?.name === 'NotFoundError' ? 'No camera detected on this device.' :
    /model|wasm|fetch/i.test(String(err?.message ?? '')) ? "Couldn't load the detection model. Reload the page and try again." :
    'Detection stopped unexpectedly. Try again later.';
  if (f === 'eye') state.eyeError = msg; else state.handError = msg;
  setPref(f, 'off');
}

function toggleReader(state: State) {
  state.readerOn = !state.readerOn;
  if (state.readerOn) document.documentElement.dataset.reader = 'on';
  else delete document.documentElement.dataset.reader;
  try { localStorage.setItem(KEY_READER, state.readerOn ? 'on' : 'off'); } catch {}
}

function togglePref(state: State, f: FeatureId) {
  if (f === 'eye') {
    if (state.eyePref === 'on') { stopEye(state); state.eyePref = 'off'; setPref('eye', 'off'); }
    else { state.eyePref = 'on'; }   // pref persisted only after first successful start
  } else {
    if (state.handPref === 'on') { stopHand(state); state.handPref = 'off'; setPref('hand', 'off'); }
    else { state.handPref = 'on'; }
  }
}

function init() {
  const trigger = document.getElementById('sb-prefs');
  if (!trigger) return;
  const support = detectSupport();
  const onTutorial = document.documentElement.dataset.pageKind === PAGE_KIND_TUTORIAL;

  const state = reactive<State>({
    readerOn: document.documentElement.dataset.reader === 'on',
    eyePref: getPref('eye'),
    handPref: getPref('hand'),
    eyeRuntime: null,
    handRuntime: null,
    eyeError: '',
    handError: '',
    slow: false
  });

  const popoverHost = document.createElement('div');
  popoverHost.id = 'tut-prefs-popover-host';
  document.body.appendChild(popoverHost);

  const badgeHost = document.createElement('div');
  badgeHost.id = 'tut-prefs-badge-host';
  document.body.appendChild(badgeHost);

  const popoverRef = ref<any>(null);

  createApp({
    render: () => h(TutorialPrefsPopover, {
      ref: popoverRef,
      readerOn: state.readerOn,
      onTutorialPage: onTutorial,
      supported: support.supported,
      unsupportedReasonText: unsupportedText(support.reasons),
      eyePref: state.eyePref,
      handPref: state.handPref,
      eyeRunning: !!state.eyeRuntime,
      handRunning: !!state.handRuntime,
      eyeFirstRun: isFirstRun('eye'),
      handFirstRun: isFirstRun('hand'),
      eyeError: state.eyeError,
      handError: state.handError,
      'onToggle-reader': () => toggleReader(state),
      'onToggle-pref': (f: FeatureId) => togglePref(state, f),
      onStart: (f: FeatureId) => f === 'eye' ? startEye(state) : startHand(state),
      onStop: (f: FeatureId) => f === 'eye' ? stopEye(state) : stopHand(state)
    })
  }).mount(popoverHost);

  createApp({
    render: () => h(CameraBadge, {
      active: [
        ...(state.eyeRuntime ? ['eye' as FeatureId] : []),
        ...(state.handRuntime ? ['hand' as FeatureId] : [])
      ],
      slow: state.slow,
      onStop: () => { stopEye(state); stopHand(state); state.slow = false; }
    })
  }).mount(badgeHost);

  trigger.addEventListener('click', () => popoverRef.value?.open(trigger));

  // Auto-resume on tutorial pages within the same tab session.
  if (onTutorial && support.supported) {
    const session = getSession();
    if (state.eyePref === 'on' && session.includes('eye')) startEye(state);
    if (state.handPref === 'on' && session.includes('hand')) startHand(state);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
```

- [ ] **Step 2: Type-check**

```bash
cd hugo-apps && npx tsc --noEmit && cd ..
```

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/tutorial-prefs/main.ts
git commit -m "feat(tutorial-prefs): add island entry orchestrating popover + badge + runtime"
```

---

## Task 14: Vite entry + bundle-size assertion

**Files:** Modify `hugo-apps/vite.config.ts`

- [ ] **Step 1: Add the entry and a size-check plugin**

In `hugo-apps/vite.config.ts`:

1. Add at the top:
   ```ts
   import { gzipSync } from 'node:zlib';
   const MAX_TUTORIAL_PREFS_GZIP = 8 * 1024;
   ```

2. Append to `rollupOptions.input`:
   ```ts
   'tutorial-prefs': resolve(__dirname, 'src/tutorial-prefs/main.ts'),
   ```

3. Add a small Vite plugin function:
   ```ts
   function tutorialPrefsBudget() {
     return {
       name: 'tutorial-prefs-budget',
       generateBundle(_opts: unknown, bundle: Record<string, any>) {
         const chunk = bundle['tutorial-prefs.js'];
         if (!chunk || chunk.type !== 'chunk') return;
         const gz = gzipSync(chunk.code).length;
         if (gz > MAX_TUTORIAL_PREFS_GZIP) {
           // @ts-ignore — Rollup plugin context
           this.error(`tutorial-prefs.js is ${gz} bytes gzipped (> ${MAX_TUTORIAL_PREFS_GZIP}). Move code to a lazy chunk.`);
         } else {
           // @ts-ignore
           this.warn(`tutorial-prefs.js: ${gz} bytes gzipped (budget ${MAX_TUTORIAL_PREFS_GZIP}).`);
         }
       }
     };
   }
   ```

4. Append `tutorialPrefsBudget()` to the `plugins` array.

- [ ] **Step 2: Build hugo-apps**

```bash
cd hugo-apps && npm run build && cd ..
```

Expected: `tutorial-prefs.js` emitted; budget warning visible; build succeeds. `chunks/` contains the lazy MediaPipe + detector modules.

If the budget fails, audit `main.ts` for accidental top-level imports of MediaPipe.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/vite.config.ts
git commit -m "build(tutorial-prefs): add vite entry + 8KB-gzip budget assertion"
```

---

## Task 15: Replace `sb-reader` with `sb-prefs` in the shellbar

Goal: Swap the existing reader-mode shellbar item for the gear, remove the now-unused `sb-reader` JS branches, and load the island. Keep the `f` keyboard shortcut and the `head.html` pre-paint script untouched.

**Files:** Modify `hugo/layouts/partials/header.html`

- [ ] **Step 1: Apply targeted edits**

Make these specific edits in `hugo/layouts/partials/header.html`:

1. Replace the `sb-reader` shellbar item:
   - From: `<ui5-shellbar-item id="sb-reader" icon="documents" text="Reader mode (f)"></ui5-shellbar-item>`
   - To: `<ui5-shellbar-item id="sb-prefs" icon="action-settings" text="Tutorial preferences"></ui5-shellbar-item>`

2. Delete this line in the click handler:
   - `else if (id === 'sb-reader') toggleReader();`

3. Delete this line:
   - `const readerItem = document.getElementById('sb-reader');`

4. Delete the function:
   - `function syncReaderItem() { ... }`

5. Delete the `syncReaderItem();` call.

6. **Keep** `function toggleReader()`, the `'f'` keydown handler, and the pre-paint script in `head.html`. They are still the source of truth for reader-mode state. The popover reuses them by writing `localStorage.setItem('reader', ...)` and `html.dataset.reader`.

7. At the bottom of `header.html` (after the closing `</script>`), add:

```html
<script type="module" src="/js/tutorial-prefs.js"></script>
```

- [ ] **Step 2: Sanity-check the diff is small**

```bash
git diff hugo/layouts/partials/header.html
```

Expected: ≤ 10 lines changed (1 swap, ~5 deletions, 1 addition).

- [ ] **Step 3: Build and verify**

```bash
npm run fetch-tutorials && npm run build:apps && npm run build:hugo
grep -c 'id="sb-prefs"' hugo/public/index.html       # > 0
grep -c 'id="sb-reader"' hugo/public/index.html      # 0
```

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/header.html
git commit -m "feat(header): replace sb-reader with sb-prefs gear + load tutorial-prefs island"
```

---

## Task 16: Manual smoke pass (local hybrid)

Goal: Run the spec's manual checklist against a local hybrid-dev instance with a real webcam.

**Files:** None (manual procedure)

- [ ] **Step 1: Start local hybrid**

In one terminal:

```bash
npm run dev:hybrid
```

In another:

```bash
npm run start:approuter
```

Open `http://localhost:5000/tutorials/<any-slug>` in a Chromium-based browser.

- [ ] **Step 2: Walk the manual checklist**

Execute steps 1–14 from the spec section *Manual test plan* (also reproduced at the end of this part). Record pass/fail in a scratch file. Do NOT commit it.

Common pitfalls:

- WASM 404 — re-run `npm run vendor:mediapipe` and rebuild Hugo.
- Popover doesn't open — confirm the page contains `id="sb-prefs"`. The island only mounts if that element exists.
- Camera badge overlaps content — adjust `--tut-prefs-cam-badge-top` in `hugo/assets/css/ui5-overrides.css` if needed.

- [ ] **Step 3: Commit any tweaks discovered**

If any CSS tweaks were needed:

```bash
git add hugo/assets/css/ui5-overrides.css
git commit -m "style(tutorial-prefs): manual-pass tweaks to camera badge layout"
```

Skip if no tweaks.

---

## Task 17: "Learn more" docs page

**Files:**
- Create: `docs/end-users/experimental-features.md`
- Modify: `docs/.vitepress/config.ts`

- [ ] **Step 1: Write the docs page**

```md
# Experimental features

Two opt-in webcam features live under the **Tutorial preferences** gear in the header:

- **Eye-tracking auto-scroll** — the page scrolls down when you look near the bottom of the viewport for about half a second.
- **Hand-gesture step navigation** — show an open palm to the camera, then sweep left or right to go to the previous or next step.

Both features are **off by default** and require an explicit "Start camera" click each browser session.

## How they work

Camera frames are processed entirely on your device by Google's MediaPipe `tasks-vision` library, running in WebAssembly inside your browser. **No video, no images, and no derived data are sent to any server.** The detector outputs (a normalized gaze position, a swipe direction) drive page actions locally.

Eye-tracking estimates approximately where in the viewport you are looking by comparing the position of your iris to the corners of your eyes. It does not record gaze data. The detector simply asks "is gaze near the bottom of the screen for at least 600 ms?" and triggers a single scroll action when yes.

Hand-gesture navigation looks for an open palm and tracks its horizontal motion across frames. A fast sweep over a fraction of the camera frame triggers a click on the existing Previous / Next links.

## Privacy and control

- Camera processing is local. Nothing is uploaded.
- A persistent "Camera active" badge appears whenever the camera is in use, with a Stop button that always works.
- Closing the tab ends the camera session immediately.
- Your preference (the toggle position) is stored in `localStorage`. The active-camera state is stored in `sessionStorage` and dies with the tab.
- Disable a feature by toggling it off in the Tutorial preferences popover.

## Not assistive technology

These are experimental input demos, not accessibility tools. People who rely on hands-free input every day have purpose-built options that work better and run system-wide:

- **macOS** Voice Control (System Settings → Accessibility) and Head Pointer.
- **Windows** Eye Control (Settings → Accessibility).
- Dedicated eye-tracker hardware (Tobii, EyeTech) and switch-access devices.

If you need consistent hands-free input across applications, please use one of those instead.

## Browser and device support

The features require a modern desktop browser with `getUserMedia`, `WebAssembly`, and `OffscreenCanvas`. They are **not** available on phones or tablets — coarse-pointer / narrow-viewport devices show a "desktop only" message.
```

- [ ] **Step 2: Register in the sidebar**

In `docs/.vitepress/config.ts`, add to the `end-users/` sidebar block, after `Accessibility`:

```ts
{ text: 'Experimental features', link: '/end-users/experimental-features' }
```

- [ ] **Step 3: Build the docs**

```bash
npm run docs:build
```

Expected: Build passes; sidebar guard does not error.

- [ ] **Step 4: Commit**

```bash
git add docs/end-users/experimental-features.md docs/.vitepress/config.ts
git commit -m "docs(end-users): add experimental features page covering camera-based prefs"
```

---

## Task 18: Final verification

**Files:** None

- [ ] **Step 1: Run all unit tests**

```bash
npm test -- --run
```

Expected: Previously passing tests still pass; new `tutorial-prefs` tests pass.

- [ ] **Step 2: Build the full pipeline**

```bash
npm run build:all
```

Expected: Succeeds. Bundle budget warning visible but does not fail.

- [ ] **Step 3: Audit the diff**

```bash
git log --oneline main..HEAD
git diff --stat main..HEAD
```

Confirm only files in *File Structure* are touched.

- [ ] **Step 4: (Optional) deployed smoke**

If `cf login` is fresh:

```bash
npm run test:smoke
```

Expected: PASS.

- [ ] **Step 5: No commit**

This task creates no new commits.

---

## Manual test plan (run before each release that touches this code)

Reproduce on a real machine with a real webcam:

1. Open a tutorial page; confirm the gear icon is present where the reader-mode icon used to be.
2. Click the gear; confirm reader-mode toggle works (parity with previous behavior).
3. Toggle eye-tracking on; confirm Start button + first-run hint appear.
4. Click Start; deny permission; confirm error message + Try again button.
5. Click Start; allow permission; confirm camera badge appears.
6. Look at the bottom of the viewport for ~600 ms; confirm one-viewport scroll.
7. Click Stop on badge; confirm camera light off, badge gone, toggle remains on.
8. Reload page; confirm camera does NOT auto-start (fresh session marker).
9. Click Start again; navigate to next step; confirm camera auto-resumes.
10. Repeat 3–9 for hand-gesture toggle.
11. Enable both; confirm one stream serves both detectors (camera light steady).
12. Close tab and reopen the tutorial; confirm both toggles still on but no auto-start.
13. Try on a phone / narrow viewport; confirm experimental section disabled with desktop-only message.
14. Try in a browser missing `OffscreenCanvas`; confirm experimental section disabled with browser-support message.

---

## Open implementation choices (resolved here, flagged for reviewer)

- **MediaPipe asset cache strategy:** vendored under stable filenames (no fingerprint). The CDN-style hashing the rest of `hugo/static/js/` uses doesn't apply because the model files are referenced by string from inside MediaPipe's own loader. Browsers cache by URL; the WASM/.task files only change on a `@mediapipe/tasks-vision` upgrade. If a future upgrade requires cache busting, bump the path in `constants.ts` (e.g. `/vendor/mediapipe-v1/`).
- **Bundle-size assertion mechanism:** added inline in `vite.config.ts` (Task 14). No prior mechanism existed in `hugo-apps/`; this is the first chunk with a hard budget. If we add more, lift the plugin into its own file.
- **Stable Next/Prev selectors:** pinned in `constants.ts` to `.tutorial-stepnav__slot--{prev,next} .nav-pill`. `nav-dispatch.test.ts` exercises both selectors against a fixture, so a future U2 refactor that renames the classes fails the test before gestures silently break.
