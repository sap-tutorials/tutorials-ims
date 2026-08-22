import {
  KEY_PREF_EYE, KEY_PREF_HAND, KEY_SESSION_CAM,
  KEY_FIRSTRUN_EYE, KEY_FIRSTRUN_HAND,
  KEY_CAL_EYE, KEY_CAL_HAND, KEY_CAL_PROMPTED_EYE, KEY_CAL_PROMPTED_HAND,
  CAL_PROFILE_VERSION,
  type FeatureId,
  type CalProfile
} from './constants';

type Toggle = 'on' | 'off';

const PREF_KEY: Record<FeatureId, string> = { eye: KEY_PREF_EYE, hand: KEY_PREF_HAND };
const FR_KEY: Record<FeatureId, string> = { eye: KEY_FIRSTRUN_EYE, hand: KEY_FIRSTRUN_HAND };
const CAL_KEY: Record<FeatureId, string> = { eye: KEY_CAL_EYE, hand: KEY_CAL_HAND };
const CAL_PROMPTED_KEY: Record<FeatureId, string> = {
  eye: KEY_CAL_PROMPTED_EYE, hand: KEY_CAL_PROMPTED_HAND
};

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
