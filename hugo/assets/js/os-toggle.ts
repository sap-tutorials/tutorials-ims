// hugo/assets/js/os-toggle.ts
// Global OS picker for tutorial pages with OS-conditional content.
// Modeled on codetabs.ts: localStorage-backed cross-page preference,
// activates panels via data-os-active, listens for picker changes,
// cross-tab sync via storage events.
// NOTE: importing this module fires init() immediately as a side-effect.

const STORAGE_KEY = 'os-preference';
const CHANGE_EVENT = 'osprefchange';

export const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'] as const;
export type OS = typeof OS_VALUES[number];

function isValidOs(v: string | null | undefined): v is OS {
  return (OS_VALUES as readonly string[]).includes(v ?? '');
}

function getPreference(): OS | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isValidOs(v) ? v : null;
  } catch {
    return null;
  }
}

function setPreference(os: OS) {
  try {
    localStorage.setItem(STORAGE_KEY, os);
  } catch {
    /* private mode / quota */
  }
}

function detectFromBas(): OS | null {
  try {
    const ref = document.referrer ?? '';
    if (/applicationstudio/i.test(ref)) return 'BAS';
    const ancestors = (location as unknown as { ancestorOrigins?: { length: number; [k: number]: string } }).ancestorOrigins;
    if (ancestors && ancestors.length > 0) {
      for (let i = 0; i < ancestors.length; i++) {
        if (/applicationstudio/i.test(ancestors[i])) return 'BAS';
      }
    }
  } catch { /* ignore */ }
  return null;
}

function detectFromClientHints(): OS | null {
  const uad = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
  if (!uad?.platform) return null;
  const p = uad.platform.toLowerCase();
  if (p.includes('windows')) return 'Windows';
  if (p.includes('mac'))     return 'macOS';
  if (p.includes('linux'))   return 'Linux';
  return null;
}

function detectFromUserAgent(): OS | null {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua))               return 'Windows';
  if (/Mac|iPhone|iPad|iPod/i.test(ua))  return 'macOS';
  if (/Linux|X11/i.test(ua))             return 'Linux';
  return null;
}

function detectDefaultOs(): OS {
  return getPreference()
    ?? detectFromBas()
    ?? detectFromClientHints()
    ?? detectFromUserAgent()
    ?? 'Windows';
}

// #2820: the OS picker no longer substitutes another OS's content when the
// active OS has no panel in a group. An author who provides Linux + macOS for a
// step but not Windows was previously shown macOS for a Windows selection —
// confusing and wrong. We now show only the exact-match panel (if any) and, when
// there is none, a placeholder strip announcing the absence. Auto-detection
// still defaults to a real OS via detectDefaultOs(); this only governs
// per-group rendering, not which OS is selected.
function findPanel(wrapper: Element, os: OS): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(`.os-panel[data-os="${os}"]`);
}

function clearStrip(wrapper: Element) {
  wrapper.querySelectorAll('ui5-message-strip[data-os-fallback-strip]').forEach((s) => s.remove());
}

function renderStrip(wrapper: Element, requested: OS) {
  const strip = document.createElement('ui5-message-strip');
  strip.setAttribute('design', 'Information');
  strip.setAttribute('data-os-fallback-strip', '');
  strip.textContent = `No ${requested} instructions for this step.`;
  wrapper.insertBefore(strip, wrapper.firstChild);
}

function activate(os: OS): OS {
  document.querySelectorAll<HTMLElement>('[data-os-options]').forEach((wrapper) => {
    wrapper.setAttribute('data-os-options-hydrated', '');
    wrapper.querySelectorAll<HTMLElement>('.os-panel[data-os]').forEach((p) => {
      p.removeAttribute('data-os-active');
    });
    clearStrip(wrapper);
    const panel = findPanel(wrapper, os);
    if (panel) {
      panel.setAttribute('data-os-active', '');
    } else {
      // No content for this OS in this group — show a placeholder, never a
      // foreign OS's content (#2820).
      renderStrip(wrapper, os);
    }
  });
  // The selected OS is authoritative: we always return the requested OS so the
  // picker selection stays on what the user chose, even when a given group has
  // no panel for it (the placeholder explains the gap). This differs from the
  // old cross-OS fallback, which re-pointed the picker at a substitute OS.
  return os;
}

function wirePicker(picker: HTMLElement, current: OS): void {
  const seg = picker.querySelector('ui5-segmented-button');
  if (!seg) return;
  // Pre-select the current OS item.
  selectPickerItem(picker, current);
  seg.addEventListener('selection-change', (e) => {
    const detail = (e as CustomEvent).detail as { selectedItems?: HTMLElement[] } | undefined;
    const picked = detail?.selectedItems?.[0]?.dataset.os as OS | undefined;
    if (!picked || !isValidOs(picked)) return;
    setPreference(picked);
    activate(picked);
    document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { os: picked } }));
  });
}

function selectPickerItem(picker: HTMLElement, current: OS): void {
  const seg = picker.querySelector('ui5-segmented-button');
  if (!seg) return;
  seg.querySelectorAll<HTMLElement>('ui5-segmented-button-item').forEach((item) => {
    if (item.dataset.os === current) item.setAttribute('selected', '');
    else item.removeAttribute('selected');
  });
}

/** The OSes the tutorial actually offers as picker buttons (osList → #2703).
 *  Empty when there is no picker (legacy pages / groups without a picker). */
function pickerOses(picker: HTMLElement | null): OS[] {
  if (!picker) return [];
  const seg = picker.querySelector('ui5-segmented-button');
  if (!seg) return [];
  const out: OS[] = [];
  seg.querySelectorAll<HTMLElement>('ui5-segmented-button-item').forEach((item) => {
    const os = item.dataset.os;
    if (os && isValidOs(os)) out.push(os);
  });
  return out;
}

/**
 * Choose the INITIAL OS selection for a fresh page load (#2820). Precedence:
 *   1. An explicit stored cross-page preference always wins — even if this
 *      tutorial doesn't offer it (the per-group placeholder explains the gap);
 *      a deliberate choice is never silently overridden.
 *   2. Otherwise the detected OS, if the tutorial offers it (or there is no
 *      picker at all — a legacy page with no buttons to constrain us).
 *   3. Otherwise the first offered OS, so a visitor whose platform the tutorial
 *      doesn't cover lands on a real, populated OS instead of seeing a
 *      placeholder in every group.
 * This is selection-time coercion only; `activate()` never substitutes one OS's
 * content for another within a group.
 */
export function pickInitialOs(stored: OS | null, detected: OS, offered: OS[]): OS {
  if (stored) return stored;                       // getPreference() already validated
  if (offered.length === 0) return detected;       // legacy page, no picker buttons
  if (offered.includes(detected)) return detected;
  return offered[0];
}

async function init(): Promise<void> {
  const picker = document.querySelector<HTMLElement>('[data-os-picker]');
  const groups = document.querySelectorAll('[data-os-options]');
  if (!picker && groups.length === 0) return;

  // Wait for ui5-segmented-button to upgrade (3s timeout fallback).
  await Promise.race([
    customElements.whenDefined('ui5-segmented-button'),
    new Promise((r) => setTimeout(r, 3000)),
  ]);

  const detected = detectDefaultOs();
  const offered = pickerOses(picker);
  const current = pickInitialOs(getPreference(), detected, offered);
  activate(current);
  if (picker) {
    // wirePicker already pre-selects `current`; no second selectPickerItem call.
    wirePicker(picker, current);
  }

  // Cross-tab sync.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = e.newValue;
    if (next && isValidOs(next)) {
      activate(next);
      if (picker) selectPickerItem(picker, next);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init());
} else {
  void init();
}

// Test seam — exposes internals to the unit test, not part of the public API.
export const __test__ = { detectDefaultOs, activate, OS_VALUES, selectPickerItem, pickInitialOs };
