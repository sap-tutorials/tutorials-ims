export const TARGET_FPS = 15;
export const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

// Eye auto-scroll fires on HEAD PITCH relative to a per-user CALIBRATED envelope
// (see calibration.ts), NOT the iris gazeY — which read ~0 and inverted on real
// cameras (2026-08 telemetry), while pitch tracks vertical gaze monotonically.
// Calibration captures the pitch range as the user scans the page top→bottom;
// the runtime scrolls DOWN when pitch climbs into the bottom of that range and
// UP when it drops into the top. gazeY is still computed for the ?debug-cam
// overlay only. Swipe defaults tuned 2026-05-29 against live telemetry.
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

// Hand gestures navigate between steps via the layout's window.opStepNav hook
// (see nav-dispatch.ts) — no DOM selectors are needed here anymore.

export const MEDIAPIPE_WASM_BASE = '/vendor/mediapipe';
export const MODEL_FACE = '/vendor/mediapipe/face_landmarker.task';
export const MODEL_HAND = '/vendor/mediapipe/hand_landmarker.task';

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { width: 640, height: 480, frameRate: 30 }
};

export const PAGE_KIND_TUTORIAL = 'tutorial';

// --- Calibration (2026-08-22) -------------------------------------------
export const CAL_PROFILE_VERSION = 2;   // v2: eye profile stores pitch envelope (was gaze)
export const CAL_DURATION_MS = 5000;
export const CAL_MIN_SAMPLES = 20;

// Eye: scroll triggers sit this far into the captured [p5, p95] PITCH envelope.
// Down fires high in the range (looking down), up fires low (looking up); the
// gap between leaves a resting-center deadband so neutral posture never scrolls.
export const CAL_EYE_DOWN_FRACTION = 0.75;
export const CAL_EYE_UP_FRACTION = 0.25;
export const CAL_EYE_MIN_SPREAD = 0.05;      // min p95-p5 pitch spread to accept

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

export interface EyeProfile { v: number; pitchMin: number; pitchMax: number; }
export interface HandProfile { v: number; dxFraction: number; minVelocity: number; }
export type CalProfile = EyeProfile | HandProfile;

export type FeatureId = 'eye' | 'hand';

// Display-chrome preferences (#1966). Individual keys mirror the tut.pref.* convention.
export const KEY_PREF_HEADER = 'tut.pref.header';
export const KEY_PREF_FOOTER = 'tut.pref.footer';
export const KEY_PREF_BREADCRUMBS = 'tut.pref.breadcrumbs';
export const KEY_PREF_FEEDBACK = 'tut.pref.feedback';

// Below this CSS-px viewport height, header→thinbar + footer→autohide by default
// (unless the user set an explicit pref). CSS px shrink under OS scaling / browser
// zoom, so high-DPI laptops cross this automatically. Mirrored (with a comment) in
// the head.html pre-paint snippet, which cannot import this module.
export const SHORT_VIEWPORT_MAX_HEIGHT = 900;

export type HeaderMode = 'locked' | 'thinbar' | 'autohide';
export type FooterMode = 'shown' | 'autohide';
export type OnOff = 'on' | 'off';

// Reading preferences batch 2 (#1966 follow-up). Same tut.pref.* convention.
export const KEY_PREF_TEXT_SIZE = 'tut.pref.textSize';
export const KEY_PREF_READ_WIDTH = 'tut.pref.readWidth';
export const KEY_PREF_CODE_SIZE = 'tut.pref.codeSize';
export const KEY_PREF_CODE_WRAP = 'tut.pref.codeWrap';
export const KEY_PREF_COPY_CLEAN = 'tut.pref.copyClean';
export const KEY_PREF_IMG_SIZE = 'tut.pref.imgSize';
export const KEY_PREF_IMG_COLLAPSE = 'tut.pref.imgCollapse';
export const KEY_PREF_REDUCE_MOTION = 'tut.pref.reduceMotion';
export const KEY_PREF_READABLE_FONT = 'tut.pref.readableFont';

export type SizeStep = 's' | 'm' | 'l';
export type ReadWidth = 'full' | 'narrow' | 'wide';
