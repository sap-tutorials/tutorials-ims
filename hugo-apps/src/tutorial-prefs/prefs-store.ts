import {
  KEY_PREF_EYE, KEY_PREF_HAND, KEY_SESSION_CAM,
  KEY_FIRSTRUN_EYE, KEY_FIRSTRUN_HAND,
  KEY_CAL_EYE, KEY_CAL_HAND, KEY_CAL_PROMPTED_EYE, KEY_CAL_PROMPTED_HAND,
  CAL_PROFILE_VERSION,
  KEY_PREF_HEADER, KEY_PREF_FOOTER, KEY_PREF_BREADCRUMBS, KEY_PREF_FEEDBACK,
  KEY_PREF_TEXT_SIZE, KEY_PREF_READ_WIDTH, KEY_PREF_CODE_SIZE, KEY_PREF_CODE_WRAP,
  KEY_PREF_COPY_CLEAN, KEY_PREF_IMG_SIZE, KEY_PREF_IMG_COLLAPSE, KEY_PREF_REDUCE_MOTION, KEY_PREF_READABLE_FONT,
  type FeatureId, type CalProfile,
  type HeaderMode, type FooterMode, type OnOff, type SizeStep, type ReadWidth
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

const HEADER_MODES: HeaderMode[] = ['locked', 'thinbar', 'autohide'];
const FOOTER_MODES: FooterMode[] = ['shown', 'autohide'];

export function getHeaderPref(): HeaderMode | null {
  const v = safeLocal()?.getItem(KEY_PREF_HEADER);
  return (v && (HEADER_MODES as string[]).includes(v)) ? (v as HeaderMode) : null;
}
export function setHeaderPref(v: HeaderMode): void { safeSet(safeLocal(), KEY_PREF_HEADER, v); }

export function getFooterPref(): FooterMode | null {
  const v = safeLocal()?.getItem(KEY_PREF_FOOTER);
  return (v && (FOOTER_MODES as string[]).includes(v)) ? (v as FooterMode) : null;
}
export function setFooterPref(v: FooterMode): void { safeSet(safeLocal(), KEY_PREF_FOOTER, v); }

export function getBreadcrumbsPref(): OnOff { return safeLocal()?.getItem(KEY_PREF_BREADCRUMBS) === 'off' ? 'off' : 'on'; }
export function setBreadcrumbsPref(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_BREADCRUMBS, v); }

export function getFeedbackPref(): OnOff { return safeLocal()?.getItem(KEY_PREF_FEEDBACK) === 'off' ? 'off' : 'on'; }
export function setFeedbackPref(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_FEEDBACK, v); }

const SIZE_STEPS: SizeStep[] = ['s', 'm', 'l'];
function readSize(key: string): SizeStep {
  const v = safeLocal()?.getItem(key);
  return (v && (SIZE_STEPS as string[]).includes(v)) ? (v as SizeStep) : 'm';
}
function readOnOff(key: string): OnOff { return safeLocal()?.getItem(key) === 'on' ? 'on' : 'off'; }

export function getTextSize(): SizeStep { return readSize(KEY_PREF_TEXT_SIZE); }
export function setTextSize(v: SizeStep): void { safeSet(safeLocal(), KEY_PREF_TEXT_SIZE, v); }

export function getReadWidth(): ReadWidth {
  return safeLocal()?.getItem(KEY_PREF_READ_WIDTH) === 'narrow' ? 'narrow' : 'full';
}
export function setReadWidth(v: ReadWidth): void { safeSet(safeLocal(), KEY_PREF_READ_WIDTH, v); }

export function getCodeSize(): SizeStep { return readSize(KEY_PREF_CODE_SIZE); }
export function setCodeSize(v: SizeStep): void { safeSet(safeLocal(), KEY_PREF_CODE_SIZE, v); }

export function getCodeWrap(): OnOff { return readOnOff(KEY_PREF_CODE_WRAP); }
export function setCodeWrap(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_CODE_WRAP, v); }

export function getCopyClean(): OnOff { return readOnOff(KEY_PREF_COPY_CLEAN); }
export function setCopyClean(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_COPY_CLEAN, v); }

// imgSize defaults to 'l' (natural), so default rendering is unchanged.
export function getImgSize(): SizeStep {
  const v = safeLocal()?.getItem(KEY_PREF_IMG_SIZE);
  return (v === 's' || v === 'm' || v === 'l') ? v : 'l';
}
export function setImgSize(v: SizeStep): void { safeSet(safeLocal(), KEY_PREF_IMG_SIZE, v); }

export function getImgCollapse(): OnOff { return readOnOff(KEY_PREF_IMG_COLLAPSE); }
export function setImgCollapse(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_IMG_COLLAPSE, v); }

export function getReduceMotion(): OnOff { return readOnOff(KEY_PREF_REDUCE_MOTION); }
export function setReduceMotion(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_REDUCE_MOTION, v); }

export function getReadableFont(): OnOff { return readOnOff(KEY_PREF_READABLE_FONT); }
export function setReadableFont(v: OnOff): void { safeSet(safeLocal(), KEY_PREF_READABLE_FONT, v); }
