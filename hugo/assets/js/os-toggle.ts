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

const FALLBACK_CHAIN: Record<OS, OS[]> = {
  Linux:   ['Linux',   'macOS',   'Windows', 'BAS'],
  macOS:   ['macOS',   'Linux',   'Windows', 'BAS'],
  BAS:     ['BAS',     'Linux',   'macOS',   'Windows'],
  Windows: ['Windows', 'macOS',   'Linux',   'BAS'],
};

function pickPanel(wrapper: Element, os: OS): { panel: HTMLElement | null; usedFallback: OS | null } {
  for (const candidate of FALLBACK_CHAIN[os]) {
    const found = wrapper.querySelector<HTMLElement>(`.os-panel[data-os="${candidate}"]`);
    if (found) return { panel: found, usedFallback: candidate === os ? null : candidate };
  }
  // Last-resort: first panel in the wrapper, regardless of OS.
  // Defense-in-depth — only reachable if the wrapper contains panels with
  // non-canonical data-os values (which the build pipeline never emits).
  const first = wrapper.querySelector<HTMLElement>('.os-panel[data-os]');
  return { panel: first, usedFallback: first ? (first.dataset.os as OS) : null };
}

function clearStrip(wrapper: Element) {
  wrapper.querySelectorAll('ui5-message-strip[data-os-fallback-strip]').forEach((s) => s.remove());
}

function renderStrip(wrapper: Element, requested: OS, used: OS) {
  const strip = document.createElement('ui5-message-strip');
  strip.setAttribute('design', 'Information');
  strip.setAttribute('data-os-fallback-strip', '');
  strip.textContent = `No ${requested} instructions for this step — showing ${used}.`;
  wrapper.insertBefore(strip, wrapper.firstChild);
}

function activate(os: OS): void {
  document.querySelectorAll<HTMLElement>('[data-os-options]').forEach((wrapper) => {
    wrapper.setAttribute('data-os-options-hydrated', '');
    wrapper.querySelectorAll<HTMLElement>('.os-panel[data-os]').forEach((p) => {
      p.removeAttribute('data-os-active');
    });
    clearStrip(wrapper);
    const { panel, usedFallback } = pickPanel(wrapper, os);
    if (!panel) return;
    panel.setAttribute('data-os-active', '');
    if (usedFallback) renderStrip(wrapper, os, usedFallback);
  });
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

async function init(): Promise<void> {
  const picker = document.querySelector<HTMLElement>('[data-os-picker]');
  const groups = document.querySelectorAll('[data-os-options]');
  if (!picker && groups.length === 0) return;

  // Wait for ui5-segmented-button to upgrade (3s timeout fallback).
  await Promise.race([
    customElements.whenDefined('ui5-segmented-button'),
    new Promise((r) => setTimeout(r, 3000)),
  ]);

  const current = detectDefaultOs();
  activate(current);
  if (picker) wirePicker(picker, current);

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
export const __test__ = { detectDefaultOs, activate, OS_VALUES, selectPickerItem };
