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
