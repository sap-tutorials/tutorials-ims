// Debug overlay for tuning eye/hand detection.
//
// Off unless `?debug-cam` is in the URL — gated in main.ts so this module
// is dead code in normal sessions and tree-shakes when not imported.
//
// The overlay shows live frame-derived values (gazeY, headForward pitch,
// palmOpen, dx/dt) next to the firing thresholds, so we can see whether
// the model is producing values the detectors would ever fire on.

import {
  GAZE_HEAD_PITCH_MAX, GAZE_DWELL_MS,
  type FeatureId
} from './constants';

interface EyeReport {
  kind: 'eye';
  gazeY: number;
  pitch: number;        // raw pitch value (headForward = pitch < GAZE_HEAD_PITCH_MAX)
  headForward: boolean;
  dwellMs: number;      // 0 if not currently dwelling
  faceSeen: boolean;
  threshold: number;    // active (possibly calibrated) gaze threshold
  calibrated: boolean;  // whether a calibration profile is active
}

interface HandReport {
  kind: 'hand';
  palmSeen: boolean;
  palmOpen: boolean;
  x: number;            // normalized 0..1
  dxFromArmed: number;  // 0 if not armed
  dtMs: number;         // 0 if not armed
  velocity: number;     // 0 if not armed or dt==0
  state: 'IDLE' | 'ARMED' | 'COOLDOWN';
  dxThreshold: number;  // active (possibly calibrated) swipe dx threshold
  vThreshold: number;   // active (possibly calibrated) velocity threshold
  calibrated: boolean;  // whether a calibration profile is active
}

export type CamReport = EyeReport | HandReport;

interface OverlayHandle {
  report(r: CamReport): void;
  destroy(): void;
}

// Returns null when debug is off so callers can skip work cheaply.
export function createDebugOverlay(enabled: boolean): OverlayHandle | null {
  if (!enabled) return null;
  if (typeof document === 'undefined') return null;

  const root = document.createElement('div');
  root.id = 'tut-cam-debug';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-label', 'Camera detection debug');
  Object.assign(root.style, {
    position: 'fixed',
    top: '8px',
    right: '8px',
    zIndex: '2147483647',
    background: 'rgba(0,0,0,0.82)',
    color: '#fff',
    font: '12px/1.35 ui-monospace,Menlo,Consolas,monospace',
    padding: '8px 10px',
    borderRadius: '6px',
    minWidth: '230px',
    maxWidth: '320px',
    pointerEvents: 'none',
    whiteSpace: 'pre',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
  });

  const eyeBlock = document.createElement('div');
  eyeBlock.dataset.kind = 'eye';
  const handBlock = document.createElement('div');
  handBlock.dataset.kind = 'hand';
  handBlock.style.marginTop = '6px';

  const title = document.createElement('div');
  title.textContent = 'cam-debug';
  title.style.fontWeight = '600';
  title.style.marginBottom = '4px';
  title.style.opacity = '0.7';

  root.appendChild(title);
  root.appendChild(eyeBlock);
  root.appendChild(handBlock);
  document.body.appendChild(root);

  function fmt(n: number, d = 2): string {
    return Number.isFinite(n) ? n.toFixed(d) : '–';
  }

  function tick(ok: boolean): string { return ok ? '✓' : '✗'; }

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
      `dx         ${fmt(r.dxFromArmed)}  >= ${r.dxThreshold}  ${tick(dxOk)}`,
      `v          ${fmt(r.velocity)}  >= ${r.vThreshold}  ${tick(vOk)}`,
      `cal        ${tick(r.calibrated)}`
    ];
    handBlock.textContent = lines.join('\n');
  }

  return {
    report(r: CamReport) {
      if (r.kind === 'eye') renderEye(r);
      else renderHand(r);
    },
    destroy() {
      root.remove();
    }
  };
}

// Read once on module load — main.ts imports this and forwards the flag.
// `?debug-cam` (no value) is the canonical form; any value is accepted.
export function isCamDebugEnabled(): boolean {
  if (typeof location === 'undefined') return false;
  try {
    return new URLSearchParams(location.search).has('debug-cam');
  } catch {
    return false;
  }
}

// Re-exported so eye-tracking/hand-gestures can build their reports without
// pulling the constants file again at the call site.
export type { EyeReport, HandReport };

// keep FeatureId import warning-clean if anyone re-exports kind tagging later
export type _FeatureId = FeatureId;
