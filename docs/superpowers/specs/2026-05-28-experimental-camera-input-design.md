# Experimental Camera-Input Tutorial Preferences

**Status:** Design approved 2026-05-28. Awaiting implementation plan.

## Summary

Add two opt-in, off-by-default experimental features to tutorial pages: **eye-tracking auto-scroll** and **hand-gesture step navigation**, both powered by the user's webcam via Google MediaPipe. Consolidate the existing reader-mode toggle and these new toggles under a single "Tutorial preferences" gear icon, so the net change to the tutorial header is zero icons. All processing happens locally in the browser; nothing is sent to a server.

## Goals

- Ship two niche-but-striking webcam-based interactions for tutorial readers.
- Keep them strictly opt-in: flag-off means no camera code path runs.
- Preserve privacy: local processing only, explicit camera consent, persistent kill-switch UI.
- Add no XSUAA, HANA, schema, or backend dependencies. Pure client-side.
- Zero additional icons in the tutorial header.

## Non-goals

- These are NOT assistive technologies. Users who need accessibility tools have purpose-built platform features (macOS Voice Control, Windows Eye Control, dedicated eye-tracker hardware) — a webcam heuristic must not compete with or be marketed as those.
- No mobile support. The features are gated to desktop browsers (`pointer: fine`, viewport ≥ 768px).
- No kiosk / event-booth integration in this iteration. Audience is personal opt-in only.
- No "real" gaze tracking with calibration — the eye-tracker is a coarse "is the user looking at the lower portion of the viewport?" heuristic, sufficient for the auto-scroll use case.
- No telemetry. Errors are console-only.

## User-facing surface

### Header trigger

The existing reader-mode toggle button is **replaced** by a single ⚙ "Tutorial preferences" button using the `action-settings` icon. Net change in the header: zero icons.

The `f` keyboard shortcut for reader mode is preserved unchanged.

### Popover

Clicking the gear opens a `ui5-popover` with the following structure:

```
Tutorial preferences
─────────────────────────────────────────────
Reader mode                       [   off ]  f
Hide chrome and focus on the content.
─────────────────  Experimental  ─────────────
Eye-tracking auto-scroll          [   off ]
Uses your webcam. The page scrolls down when
you look near the bottom for about half a
second. Stays running until you stop it or
close the tab.
[ Start camera ]    (only when toggle is on)
─────────────────────────────────────────────
Hand-gesture step nav             [   off ]
Uses your webcam. Hold an open palm to the
camera, then sweep left or right to go to
the previous or next step.
[ Start camera ]    (only when toggle is on)
─────────────────────────────────────────────
Camera processing happens entirely in your
browser. Nothing is sent to a server.
[ Learn more ]
```

The popover renders different controls per feature based on its state machine (see *State and lifecycle*). When a feature is `running`, the "Start camera" button reads "Stop camera" and a one-line state hint appears beneath it ("Look at the bottom of the page for half a second to scroll." / "Show an open palm, then sweep left or right.").

### First-run nudge

When the user toggles a feature on for the first time, a subtle accent-color hint *"Press **Start camera** to try it"* appears under the toggle. Cleared after the first successful camera start. Tracked via `localStorage` keys `tut.pref.eyeTrack.firstRun` and `tut.pref.handGest.firstRun`.

### Camera-active badge

When at least one feature is running, a fixed-position `ui5-message-strip` (design `Information`, no close button) anchors below the tutorial header:

```
[●] Camera active — eye-tracking, gestures   [ Stop ]
```

Visible regardless of scroll position. The list updates live ("eye-tracking", "gestures", or "eye-tracking, gestures"). Clicking **Stop** stops all detectors and closes the underlying camera stream. The badge disappears when the last feature stops.

### Browser support and disabled states

- If `getUserMedia`, `WebAssembly`, `requestAnimationFrame`, or `OffscreenCanvas` are unavailable, both experimental toggles render disabled with helper text *"Your browser doesn't support this feature."*
- On phones / coarse-pointer devices / viewports < 768px, the experimental section shows *"Available on desktop browsers only."* and toggles are disabled.
- If `prefers-reduced-motion: reduce`, eye-tracking auto-scroll uses `behavior: 'auto'` instead of `'smooth'`. Gesture-driven Next/Prev inherits whatever motion behavior those buttons already have.

### "Learn more" docs page

A new short doc at `docs/end-users/experimental-features.md` is registered in the VitePress sidebar. It covers what the features do, the high-level detection mechanism, the privacy posture ("your camera, your laptop, no network"), how to disable them, and an explicit *"these are not assistive technologies — see [platform alternatives]"* note.

## Architecture

### File layout

A new Vue 3 island, **`tutorial-prefs`**, lives in `hugo-apps/src/tutorial-prefs/`. It compiles to `hugo/static/js/tutorial-prefs.js` like other islands and is loaded by the tutorial Object Page layout in place of the standalone reader-mode toggle.

```
hugo-apps/src/tutorial-prefs/
├── index.ts                  # island entry; mounts the gear button + popover
├── TutorialPrefsPopover.vue  # popover with all three toggles + privacy footer
├── CameraBadge.vue           # fixed-position "Camera active" pill
├── camera-session.ts         # singleton MediaStream owner + reference counter
├── eye-tracking.ts           # lazy: Face Landmarker wrapper, emits 'gaze-low'
├── hand-gestures.ts          # lazy: Hand Landmarker wrapper, emits 'swipe-*'
├── prefs-store.ts            # localStorage / sessionStorage read/write helpers
├── constants.ts              # all detection thresholds, dwell/cooldown times
└── *.test.ts                 # vitest unit tests
```

`eye-tracking.ts` and `hand-gestures.ts` are imported via dynamic `import()` only when the user clicks "Start camera". They are not in the main island chunk.

The reader-mode toggle's existing pre-paint script (set by U12) and `localStorage` key are unchanged. `tutorial-prefs` reads/writes the same key, so FOUC behavior on dark→light flips is preserved.

### Vendored MediaPipe assets

A small npm script copies `@mediapipe/tasks-vision` runtime assets into `hugo/static/vendor/mediapipe/` at build time:

- `vision_wasm_internal.wasm` (~3 MB)
- `vision_wasm_internal.js` (~50 KB)
- `face_landmarker.task` (~3 MB)
- `hand_landmarker.task` (~2 MB)

Total ~8 MB added to the static deploy artifact, fetched only when a user clicks "Start camera". No Google CDN at runtime → no AppRouter CSP changes.

The copy step runs as a Vite plugin or as part of the `hugo-apps` build script and asserts file presence.

### Bundle budget

The main `tutorial-prefs.js` chunk (Vue island + popover + state machine, *not* counting MediaPipe) must be ≤ 8 KB gzip. A build-time check fails the build if exceeded.

## State and lifecycle

### Storage keys

| Key | Storage | Values | Purpose |
|---|---|---|---|
| `tut.pref.eyeTrack` | `localStorage` | `'on'` \| `'off'` (default `'off'`) | Has the user opted into eye-tracking? |
| `tut.pref.handGest` | `localStorage` | `'on'` \| `'off'` (default `'off'`) | Has the user opted into hand-gestures? |
| `tut.cam.session` | `sessionStorage` | `'eye'` \| `'hand'` \| `'eye+hand'` \| absent | Has the user *started* the camera in this tab? |
| `tut.pref.eyeTrack.firstRun` | `localStorage` | `'1'` \| absent | First-run hint already shown for eye-tracking? |
| `tut.pref.handGest.firstRun` | `localStorage` | `'1'` \| absent | First-run hint already shown for gestures? |

The reader-mode `localStorage` key set by U12 is reused unchanged.

### Per-feature state machine

Identical for both eye-tracking and hand-gestures:

```
disabled  ──toggle on──►  enabled-idle  ──Start camera──►  running
   ▲                          │ ▲                            │
   └────toggle off────────────┘ └─────Stop camera────────────┘
```

- Toggle off from any state: stops detector if running, removes session marker for this feature, persists pref `'off'`.
- Tab close clears `tut.cam.session` (via `sessionStorage`); `localStorage` prefs persist.

### Auto-resume on subsequent tutorial pages

On every tutorial page bootstrap, `tutorial-prefs/index.ts` checks both:

1. `tut.cam.session` contains the feature's tag, AND
2. The feature's `localStorage` pref is `'on'`.

If both are true, the feature auto-starts (no extra Start click needed). This makes hands-free reading actually hands-free across step navigation. Tab close → session marker gone → next visit requires an explicit Start click.

### Permission denial

If `getUserMedia` rejects, the Start button flips to "Camera blocked — check browser settings" with a small **Try again** button, and the toggle drops back to `'off'`. The `localStorage` pref is **not** persisted as `'on'` until the camera actually starts at least once. This avoids the trap where a user toggles on, denies permission, leaves, and returns to find the toggle still on.

### `camera-session.ts` reference counting

A singleton owns at most one `MediaStream`:

- `acquire(consumer: 'eye' | 'hand'): Promise<MediaStream>` — if no stream exists, calls `getUserMedia({ video: { width: 640, height: 480, frameRate: 30 } })`. Adds consumer to set. Updates `tut.cam.session`. Shows badge.
- `release(consumer: 'eye' | 'hand'): void` — removes consumer. If set is empty, calls `stream.getTracks().forEach(t => t.stop())`, clears `tut.cam.session`, hides badge.

This is what makes "both features on, stop one, the other keeps the camera" work without leaking tracks.

## Detection algorithms

All thresholds and timings live in `tutorial-prefs/constants.ts`:

```ts
export const TARGET_FPS = 15;
export const GAZE_BOTTOM_THRESHOLD = 0.7;     // gazeY normalized [0,1]; 0=up, 1=down
export const GAZE_DWELL_MS = 600;
export const GAZE_FIRE_COOLDOWN_MS = 1200;
export const SWIPE_MIN_DX_FRACTION = 0.30;    // of frame width
export const SWIPE_MIN_VELOCITY = 1.5;        // frame-widths per second
export const SWIPE_COOLDOWN_MS = 800;
export const PALM_LOST_RESET_MS = 200;
export const SLOW_FRAME_MS = 100;             // frame budget; >5 in a row triggers warning
```

### Eye-tracking → "gaze near bottom"

Face Landmarker runs at ~15 FPS on `requestAnimationFrame` (skip frames if rAF is faster than `1000 / TARGET_FPS`). Per frame:

1. Get iris landmarks (MediaPipe face-mesh indices 468–477: left iris and right iris centers).
2. Get eye-corner landmarks (33, 133 for right eye; 362, 263 for left eye).
3. Compute normalized iris position within each eye's bounding box, average left and right → single `gazeY ∈ [0, 1]` (0 ≈ looking up, 1 ≈ looking down).
4. Compute head pitch from nose-tip vs. the line through the eye corners. If pitch indicates head-tilted-down (e.g., looking at keyboard), suppress firing — we don't want to scroll because the user looked away from the screen entirely.
5. Maintain a rolling 600 ms window. If `gazeY > GAZE_BOTTOM_THRESHOLD` AND head pitch is forward-ish for the entire window → fire `gaze-low`.
6. On `gaze-low`: `window.scrollBy({ top: window.innerHeight * 0.85, behavior: prefers-reduced-motion ? 'auto' : 'smooth' })`. Suppress further fires for 1200 ms (lets the smooth scroll complete + the user re-fixate).

Edge cases:

- Face not detected for ≥ 1 s → ignore. Don't scroll on no-face.
- Page already at the bottom (`scrollY + innerHeight >= scrollingElement.scrollHeight - 4`) → don't fire.
- User scrolls manually during the cooldown → cooldown is unaffected; manual scroll does not interfere.

### Hand gestures → "swipe left/right"

Hand Landmarker also at ~15 FPS. Per-hand state machine (only the first detected hand is tracked — multi-hand is not worth the complexity):

```
IDLE
  └─ if open-palm test passes → ARMED, record start_x, start_t
ARMED
  ├─ if open-palm lost for > PALM_LOST_RESET_MS → IDLE
  ├─ if |dx| / dt < SWIPE_MIN_VELOCITY → keep ARMED
  └─ if |dx| / dt >= SWIPE_MIN_VELOCITY AND |dx| > SWIPE_MIN_DX_FRACTION × frame_width → FIRE
FIRE
  └─ emit 'swipe-left' or 'swipe-right' from sign(dx); enter COOLDOWN
COOLDOWN (SWIPE_COOLDOWN_MS)
  └─ ignore all input → IDLE
```

**Open-palm test:** for each of index, middle, ring, pinky — fingertip Y above MCP-knuckle Y (i.e., fingers extended upward). Closed fist or single pointing finger fails the test, which prevents talk-while-gesturing false positives.

### Wiring swipes to existing navigation

`'swipe-left'` and `'swipe-right'` events do not contain custom navigation logic. They locate the existing tutorial Next / Prev buttons via stable selectors (the U2 wizard nav already provides these) and dispatch a programmatic `click()`. This way the gesture inherits all existing behavior — completion tracking, scroll-to-top, view transitions — for free.

If the buttons aren't present (we're on the last/first step), the click is a no-op. No error, no toast.

## Error handling

| Failure | User sees | State after |
|---|---|---|
| `getUserMedia` denied | Popover: *"Camera permission was denied. Allow the camera in your browser to use this feature."* + **Try again** button | Toggle off, pref off, no session marker |
| `getUserMedia` `NotFoundError` (no camera) | Popover: *"No camera detected on this device."* | Toggle off, pref off, no retry |
| MediaPipe WASM 404 / model fetch fails | Popover: *"Couldn't load the detection model. Reload the page and try again."* Failing URL logged to console. | Toggle off, pref off |
| Detection runtime exception | Camera stops, badge disappears, popover: *"Detection stopped unexpectedly. Try again later."* Logged to console. | Toggle off, pref off |
| Tab visibility hidden | (No user-visible message.) `requestAnimationFrame` pauses processing automatically; stream stays open; badge stays visible. Resumes on `visibilitychange` to visible. | Unchanged |
| Slow hardware (≥ 5 consecutive frames > 100 ms) | Badge appends one-line note: *"Detection is slow on this device — accuracy may suffer."* Detection continues. | Unchanged |

No telemetry. No `/feedback/submit`. Console logs only.

## Performance

- Detection loop targets 15 FPS, self-throttling via `performance.now()` deltas.
- Expected idle CPU on a modern laptop: ~10–15% with one feature, ~20–25% with both.
- All MediaPipe code paths are dynamic `import()`. The main `tutorial-prefs.js` chunk is ≤ 8 KB gzip (build assertion).
- Model + WASM files are vendored and cached by the browser like any other static asset (immutable filenames recommended; revisit during implementation planning).
- Tab-hidden behavior: `requestAnimationFrame` pauses naturally; CPU drops to ~0% while still keeping the stream open and the badge visible.

## Accessibility

- Toggles use `ui5-switch` with proper labels — keyboard navigable, screen-reader friendly, full focus ring.
- The features themselves are **not** marketed as accessibility tools. Copy uses *"experimental, hands-free input"* exclusively. The docs page explicitly notes the tools are not assistive technology and points to platform-level alternatives.
- The camera-active badge has an accessible name and is in the natural tab order. Screen readers announce *"Camera active. Eye-tracking, hand gestures. Stop."*
- `prefers-reduced-motion: reduce` is respected for auto-scroll.

## Testing

### Unit (Vitest, happy-dom)

- `prefs-store.ts` round-trip: read/write each `localStorage` and `sessionStorage` key.
- `camera-session.ts` reference counting: acquire/release for one consumer, two consumers, double-acquire by same consumer, release-without-acquire.
- Per-feature state-machine transitions: disabled ↔ enabled-idle ↔ running, including all error transitions.
- Eye-tracking algorithm: feed synthetic landmark sequences; assert `gaze-low` fires after dwell, doesn't fire on insufficient dwell, suppresses during cooldown.
- Hand-gesture algorithm: feed synthetic landmark sequences; assert correct `swipe-left` / `swipe-right` direction and cooldown enforcement.

### Component (Vue Test Utils + happy-dom)

- Popover render states: default, eye on/idle, eye on/running, hand on/running, both on/running, blocked-permission, unsupported-browser, mobile-disabled.
- Camera badge live-updates as features start/stop.

### Manual test plan (in the spec, run pre-release)

A checklist Tom runs before each release:

1. Open a tutorial page; confirm gear icon present where reader-mode icon used to be.
2. Open popover; confirm reader-mode toggle works (parity with old behavior).
3. Toggle eye-tracking on; confirm Start button appears and first-run hint shows.
4. Click Start; deny permission; confirm error message and Try again button.
5. Click Start; allow permission; confirm camera badge appears.
6. Look at bottom of viewport for ~600 ms; confirm one-viewport scroll.
7. Click Stop on badge; confirm camera light off, badge gone, toggle still on.
8. Reload page; confirm camera does NOT auto-start (no session marker after fresh tab).
9. Click Start again; navigate to next step; confirm camera auto-resumes on the next page.
10. Repeat 3–9 for hand-gesture toggle.
11. Enable both; confirm one stream serves both detectors.
12. Close tab and reopen tutorial; confirm both toggles still on but no auto-start.
13. Try on phone / narrow viewport; confirm experimental section disabled with desktop-only message.
14. Try in a browser without `getUserMedia`; confirm experimental section disabled with browser-support message.

### Smoke

No new smoke tests required — there are no new endpoints, no XSUAA changes, no auth flow changes. The existing smoke suite covers tutorial page reachability.

## Out of scope (will not be implemented)

- HANA persistence of preferences (no schema change).
- Server-side telemetry of detector activity.
- Mobile / touch-screen support.
- Calibration UX or per-user fine-tuning.
- "Real" gaze regression — coarse "looking near bottom" is sufficient.
- Additional gestures beyond swipe-left and swipe-right (e.g., thumbs-up to mark complete, scroll up/down by gaze direction).
- Kiosk / event-booth mode integration with `AppSpace.vue` or scanner.
- Localization of in-popover copy beyond English (the rest of `developers.sap.com` is en-US-only per the locales memory).

## Open questions resolved during brainstorming

- **Audience:** personal opt-in only (not kiosk).
- **Toggle location:** in-popover on tutorial pages, not on `/me/`.
- **First-run consent:** toggle records preference, separate Start button does the camera ask.
- **Camera lifecycle:** session-scoped auto-resume across step navigation; tab close ends it.
- **Library choice:** `@mediapipe/tasks-vision` (Face Landmarker + Hand Landmarker), self-hosted assets.
- **Gesture vocabulary:** swipe-left and swipe-right only.
- **Eye-tracking trigger:** discrete "gaze near bottom for 600 ms → scroll one viewport".
- **Reader mode consolidation:** moved under the same gear, net-zero header icons.
- **Explanation copy:** in-popover one-liners + state-dependent hints + privacy footer + "Learn more" docs link.
