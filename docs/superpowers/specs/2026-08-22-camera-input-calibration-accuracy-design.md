# Camera-Input Accuracy Fixes + Per-User Calibration

**Status:** Design approved in chat 2026-08-22. Awaiting implementation plan.

**Supersedes:** the "Out of scope: Calibration UX or per-user fine-tuning" and
"No 'real' gaze tracking with calibration" lines in
[2026-05-28-experimental-camera-input-design.md](2026-05-28-experimental-camera-input-design.md).
Calibration is now in scope for both features.

## Summary

The two experimental webcam features on tutorial pages — eye-tracking auto-scroll
and hand-gesture step navigation — run without errors but detect poorly in
practice. Root cause is twofold: (1) the per-frame detection math is crude and
un-normalized, and (2) both detectors compare against a single global threshold
that cannot fit every user's camera angle, seating distance, screen size, or hand
size. This change lands two workstreams:

- **A + B — detection-quality fixes**: replace the fragile gaze metric, add
  smoothing and dwell grace (eye); fix swipe-direction mirroring, loosen the
  open-palm gate, and improve the motion model (hand).
- **Calibration** — a new, lazy-loaded, shared subsystem that captures a per-user
  profile for each feature and feeds it into the detectors as their thresholds,
  falling back to the existing constants when no profile exists.

All work stays inside the `hugo-apps/src/tutorial-prefs/` island. No backend,
schema, XSUAA, approuter, or CSP changes. Processing remains 100% local.

## Goals

- Make both features detect reliably for the median laptop-webcam user.
- Fix the algorithmic defects that calibration alone cannot fix (blink-contaminated
  gaze metric, inverted swipe direction, palm-gate fragility, average-from-arm
  velocity).
- Add per-user calibration for both features, opt-in and non-blocking, with a
  clean fallback to today's behaviour when uncalibrated.
- Keep the main `tutorial-prefs.js` chunk ≤ 8 KB gzip (existing build assertion) —
  all new heavy code is dynamic-`import()`ed.
- Preserve the existing privacy posture, error handling, badge, and auto-resume
  behaviour unchanged.

## Non-goals

- Not assistive technology (unchanged from the original spec). Copy stays
  "experimental, hands-free input"; docs keep the platform-alternatives note.
- No mobile support; desktop-gating unchanged.
- No server persistence or telemetry of calibration profiles — localStorage only.
- No new gestures or gaze directions beyond the existing swipe-left/right and
  scroll-down.
- No change to `camera-session.ts` reference-counting semantics or the badge.

## Workstream A — Eye detection quality (`eye-tracking.ts`)

### A1. Replace the gazeY metric

**Current (defective):** `computeGazeFrame` normalizes iris-y between the upper and
lower **eyelid** landmarks (159/145 right, 386/374 left). The eyelid aperture moves
with gaze *and* with blinks/squints, so the normalization denominator moves with
the signal and every blink spikes `gazeY`.

**New:** anchor vertical gaze to the **eye corners (canthi)**, which are stable
through blinks and independent of lid position:

- Right eye corners: 33 (outer), 133 (inner). Left eye corners: 263 (outer),
  362 (inner).
- Iris centers: 468 (right), 473 (left).
- Per eye, compute the iris-center vertical offset from the eye-corner midpoint,
  normalized by the eye width `|x_outer − x_inner|` (distance-invariant):
  `off = (iris.y − cornerMidY) / max(eyeWidth, 1e-6)`.
- Average left and right → a signed `gazeRaw`. Larger = iris lower in the socket =
  looking down.

Because calibration learns each user's range, the metric no longer needs to land in
a fixed `[0,1]` band — it only needs to be monotonic in vertical gaze and stable
against blinks/distance. `GazeFrame.gazeY` becomes this `gazeRaw` value; the
`[0,1]` clamp is removed.

### A2. EMA smoothing

Apply an exponential moving average to `gazeRaw` before it reaches the detector:
`ema = α·sample + (1−α)·ema`, α ≈ 0.4 (tunable constant). Cuts single-frame jitter
that currently makes dwell feel unreliable. Smoothing lives in the frame loop /
detector input, not in `computeGazeFrame` (which stays pure).

### A3. Dwell grace

**Current:** `GazeDetector.observe` hard-resets `dwellStart = null` on any single
ineligible frame, so one blink or noisy frame inside the 600 ms window restarts the
dwell.

**New:** track `lastEligible` timestamp. An ineligible frame only resets the dwell
after ineligibility has persisted `GAZE_DWELL_GRACE_MS` (≈150 ms). Within the grace
window the dwell continues accumulating. This is the single biggest "looks down but
never scrolls" fix.

### A4. Distance-normalized pitch guard

**Current:** `pitch = nose.y − eyeMidY` in raw normalized image coords, checked
against fixed `GAZE_HEAD_PITCH_MAX`. Scales with face size / distance / vertical
head position.

**New:** normalize by inter-ocular distance:
`pitch = (nose.y − eyeMidY) / max(interOcular, 1e-6)`, where `interOcular` is the
distance between the two eye-corner midpoints (or 33↔263). The guard's job is
unchanged (suppress firing when the head is tilted down at the keyboard); it just
stops drifting with seating distance. `GAZE_HEAD_PITCH_MAX` is re-tuned for the new
normalized units.

## Workstream B — Hand detection quality (`hand-gestures.ts`)

### B1. Mirror fix

The off-DOM `<video>` uses raw (un-mirrored) camera pixels, so a sweep to the
user's right *decreases* image-x and currently maps to `left` → Prev — inverted
from user expectation. Mirror the palm x at the source: `x' = 1 − palmCenterX` in
`computeHandFrame`, so a rightward sweep → positive dx → `right` → Next. (Mirroring
x in the frame is equivalent and keeps the detector unchanged.)

### B2. Tolerant, orientation-agnostic palm gate

**Current:** `tips.every(tip.y < mcp.y)` requires all four fingers pointing
straight up; any hand tilt drops the gate and, after `PALM_LOST_RESET_MS`, kills an
in-progress swipe.

**New:** count a finger as "extended" when the tip is farther from the wrist
(landmark 0) than the finger's PIP joint, along the wrist→finger direction (a
tilt-invariant radial test rather than a strict `y` comparison). Palm is "open" when
**≥ 3 of 4** fingers (index/middle/ring/pinky) are extended. Survives natural hand
tilt and splay; still rejects a closed fist or single pointing finger (avoids
talk-while-gesturing false positives).

### B3. Motion model

**Current:** `startX`/`startT` captured once at arm time; velocity = total-dx /
total-dt (average). A slow approach followed by a fast flick averages *below*
`SWIPE_MIN_VELOCITY` and never fires.

**New:** keep a short trailing ring buffer of `(t, x)` samples (≈250 ms window).
Compute:

- **net displacement** over the window (or from the local x-extreme to now), and
- **peak instantaneous velocity** across adjacent buffer samples.

Fire when net displacement ≥ `dxFraction` **and** peak velocity ≥ `minVelocity`,
using the sign of net displacement for direction. The ARMED/COOLDOWN/`PALM_LOST`
state machine and cooldown are preserved; only the dx/velocity computation changes.
`SwipeDetector` keeps its synchronous, injectable, unit-testable shape.

## Workstream C — Calibration (new shared subsystem)

### C1. New files

```
hugo-apps/src/tutorial-prefs/
├── calibration.ts            # capture loop + profile math (pure fns + async capture)
├── CalibrationOverlay.vue    # fullscreen 5s scan UI (progress + live feedback)
└── *.test.ts
```

Both are dynamic-`import()`ed only when the user calibrates (or auto-prompt fires),
so the main chunk budget is unaffected — same pattern as `eye-tracking.ts` /
`hand-gestures.ts`.

### C2. Capture flows (continuous, 5 s)

`calibration.ts` exports `calibrate(feature: FeatureId, opts): Promise<Profile>`:

1. `acquire(feature)` the shared stream (reference-counted; shares with a running
   detector and the badge, or opens the camera if idle).
2. Create the feature's landmarker (FaceLandmarker / HandLandmarker), run it at
   `TARGET_FPS` for `CAL_DURATION_MS` (≈5000 ms), streaming samples.
3. Compute the profile (below), `release(feature)`, close the landmarker, resolve.

- **Eye — "scan the whole page":** collect `gazeRaw` samples; profile from the
  robust envelope: `gazeMin = p5`, `gazeMax = p95` (percentiles reject blink
  outliers). Requires a minimum sample count and a minimum spread
  (`gazeMax − gazeMin ≥ CAL_EYE_MIN_SPREAD`) or the capture is rejected as invalid
  (user told to retry).
- **Hand — "hold your palm up and sweep left–right a few times":** collect palm-x
  while the palm gate passes; profile from **median swept amplitude** (median of
  per-sweep peak-to-peak dx) and **peak velocity** across the window. Requires a
  minimum number of detected direction reversals or the capture is rejected.

### C3. Profiles + storage

Versioned JSON in `localStorage`, one key per feature:

| Key | Shape |
|---|---|
| `tut.pref.eyeTrack.cal` | `{ v: 1, gazeMin: number, gazeMax: number }` |
| `tut.pref.handGest.cal` | `{ v: 1, dxFraction: number, minVelocity: number }` |

Derived thresholds:

- Eye trigger threshold `= gazeMin + CAL_EYE_TRIGGER_FRACTION·(gazeMax − gazeMin)`
  (`CAL_EYE_TRIGGER_FRACTION ≈ 0.7`).
- Hand `dxFraction = CAL_HAND_DX_FACTOR·medianAmplitude` (≈0.6),
  `minVelocity = CAL_HAND_V_FACTOR·peakVelocity` (≈0.5), each clamped to sane
  `[min,max]` bounds so a degenerate capture can't produce an un-triggerable or
  hair-trigger profile.

**Versioning:** the profile `v` is compared to a `CAL_PROFILE_VERSION` constant on
read. A mismatch (e.g., after a future metric change) is treated as "no profile" →
fallback to constants, so a stale profile can never feed the new metric bad numbers.

`prefs-store.ts` gains:

```ts
getCal(f: FeatureId): Profile | null      // returns null on absent/parse-fail/version-mismatch
setCal(f: FeatureId, p: Profile): void
clearCal(f: FeatureId): void
```

All wrapped in the existing `try/catch` storage-safety pattern.

### C4. Detector refactor (design-for-isolation)

`GazeDetector` and `SwipeDetector` currently read module-level constants directly.
Refactor them to accept the thresholds via their `opts`, defaulting to today's
constants when omitted:

- `GazeDetectorOpts` gains `threshold?: number` (default `GAZE_BOTTOM_THRESHOLD`).
- `SwipeDetectorOpts` gains `dxFraction?: number` (default `SWIPE_MIN_DX_FRACTION`)
  and `minVelocity?: number` (default `SWIPE_MIN_VELOCITY`).

`runEyeTracking` / `runHandGestures` call `getCal(feature)` at startup and pass the
derived thresholds into the detector. This keeps the detectors pure and directly
unit-testable with injected thresholds, and means "calibrated vs default" is a
single value swap with no branching in the hot loop.

### C5. UX + wiring (`main.ts`, `TutorialPrefsPopover.vue`)

- **Popover:** when a feature toggle is on, show a **"Calibrate"** button alongside
  Start/Stop. A one-line hint states last-calibrated status ("Calibrated" /
  "Not calibrated — using defaults"). New emit `calibrate(f)`.
- **Auto-prompt once:** on the first successful `Start` of a feature that has no
  profile, auto-open the calibration overlay. Skippable. Tracked by new
  first-run-style keys `tut.pref.eyeTrack.cal.prompted` /
  `tut.pref.handGest.cal.prompted` (mirrors the existing `firstRun` mechanism), so
  it never nags twice.
- **Overlay:** `CalibrationOverlay.vue` is a fullscreen layer (mounted on demand on
  its own host, like the badge/popover hosts) with instructions, a 5 s progress
  bar, live "we can see you" feedback, and Cancel. On completion it calls `setCal`
  and, if the feature is currently running, restarts the detector so the new
  thresholds take effect immediately. On invalid capture (C2) it shows a retry
  message. Cancel/close acquires nothing persistent and releases the stream if it
  opened solely for calibration.
- **`main.ts`** gains `calibrate(state, f)` orchestrating the above, plus the
  auto-prompt check inside `startEye`/`startHand` after a successful start.

### C6. Debug overlay (`cam-debug.ts`)

Extend the `?debug-cam` overlay to display, per feature: whether a profile is
loaded, and the **active** threshold(s) (calibrated value vs the default constant).
This is the primary live-verification surface (per the "test the actual thing"
rule) — it makes it visible whether calibration actually moved the firing line.

## Constants (`constants.ts`)

New/changed constants (values tuned during implementation against `?debug-cam`
telemetry, as the existing ones were):

```ts
export const GAZE_EMA_ALPHA = 0.4;
export const GAZE_DWELL_GRACE_MS = 150;
// GAZE_BOTTOM_THRESHOLD / GAZE_HEAD_PITCH_MAX re-tuned for the new gaze/pitch units.

export const PALM_MIN_FINGERS = 3;          // of 4
export const SWIPE_WINDOW_MS = 250;         // trailing motion buffer

export const CAL_DURATION_MS = 5000;
export const CAL_PROFILE_VERSION = 1;
export const CAL_EYE_TRIGGER_FRACTION = 0.7;
export const CAL_EYE_MIN_SPREAD = /* tuned */;
export const CAL_HAND_DX_FACTOR = 0.6;
export const CAL_HAND_V_FACTOR = 0.5;
// clamp bounds for derived thresholds

export const KEY_CAL_EYE = 'tut.pref.eyeTrack.cal';
export const KEY_CAL_HAND = 'tut.pref.handGest.cal';
export const KEY_CAL_PROMPTED_EYE = 'tut.pref.eyeTrack.cal.prompted';
export const KEY_CAL_PROMPTED_HAND = 'tut.pref.handGest.cal.prompted';
```

## Error handling

Reuses the existing table. Additions:

| Failure | User sees | State after |
|---|---|---|
| Calibration capture invalid (too few samples / insufficient spread or reversals) | Overlay: "Couldn't calibrate — please try again." + Retry / Cancel | No profile written; detector keeps current (default or prior) thresholds |
| `getUserMedia` denied during calibrate | Same messages as feature start (`NotAllowedError`, etc.) | Overlay closes; no profile |
| Landmarker/WASM load fails during calibrate | "Couldn't load the detection model. Reload and try again." | Overlay closes; no profile |
| Stored profile parse error / version mismatch | (silent) | Treated as no profile → default constants |

No telemetry; console logs only, matching the original spec.

## Testing

### Unit (Vitest, happy-dom)

- **Gaze metric:** synthetic corner+iris landmarks → assert monotonic `gazeRaw` in
  vertical gaze, stability across a simulated blink (lid landmarks move, corners
  don't), invariance to a distance scale factor.
- **EMA + dwell grace:** a single ineligible frame inside the window does not reset
  dwell; sustained ineligibility past the grace does.
- **Palm gate:** 3-of-4 and 4-of-4 pass; ≤2 and fist/point fail; passes under a
  tilted-hand landmark set that the old strict-y test failed.
- **Mirror direction:** rightward sweep → `right`/Next; leftward → `left`/Prev.
- **Motion model:** slow-approach-then-flick fires (peak velocity), steady drift
  below threshold does not; direction from net displacement sign; cooldown enforced.
- **Calibration math:** p5/p95 envelope rejects injected blink outliers; median
  amplitude + peak velocity from a synthetic multi-sweep; invalid-capture
  rejection; derived-threshold clamping.
- **Detector injection:** `GazeDetector`/`SwipeDetector` honour injected thresholds;
  default to constants when omitted.
- **cal-store:** `getCal/setCal/clearCal` round-trip; null on parse-fail and on
  `CAL_PROFILE_VERSION` mismatch.

### Component (Vue Test Utils + happy-dom)

- Popover: Calibrate button visibility per state; calibrated/not-calibrated hint.
- CalibrationOverlay: progress render, completion → `setCal`, invalid → retry,
  cancel path.

### Live / manual (per "test the actual thing")

Against a real webcam with `?debug-cam`: calibrate each feature, confirm the
overlay shows the active threshold moving off the default, and that
scroll/next/prev fire naturally afterwards. Extend the existing pre-release manual
checklist with calibrate + recalibrate + fallback-when-uncalibrated steps.

## Docs

Update `docs/end-users/experimental-features.md`: add a short "Calibrate for best
results" section (what it does, that it's optional and stored locally, how to
recalibrate). Keep the not-assistive-technology note.

## Out of scope (unchanged)

Server persistence, telemetry, mobile support, additional gestures/gaze directions,
kiosk mode, localization beyond en-US.
