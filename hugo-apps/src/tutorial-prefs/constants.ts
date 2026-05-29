export const TARGET_FPS = 15;
export const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

// Tuned 2026-05-29 against live cam-debug telemetry. The original synthetic-
// frame defaults (gazeY > 0.7, pitch < 0.06, swipe v >= 1.5) required an
// exaggerated chin-up + iris-hard-down posture and a TikTok-speed flick;
// natural reading + a controlled wave never crossed either. See cam-debug
// overlay (?debug-cam) to revisit if behaviour drifts.
export const GAZE_BOTTOM_THRESHOLD = 0.55;   // iris in bottom ~45% of eye opening (was 0.7)
export const GAZE_HEAD_PITCH_MAX = 0.12;     // head roughly level — slight tilt OK (was 0.06)
export const GAZE_DWELL_MS = 600;
export const GAZE_FIRE_COOLDOWN_MS = 1200;
export const NO_FACE_TIMEOUT_MS = 1000;
export const SCROLL_VIEWPORT_FRACTION = 0.85;

export const SWIPE_MIN_DX_FRACTION = 0.30;
export const SWIPE_MIN_VELOCITY = 0.4;       // viewport-fractions/sec — slow deliberate wave (was 1.5)
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
