// hugo/assets/js/kbd-os.ts
// OS-aware keyboard shortcut switcher for tutorial pages.
// Listens to the 'osprefchange' event dispatched by os-toggle.ts and swaps
// the displayed keybinding labels on <kbd data-kbd> elements to match the
// active OS preference.
//
// Import type only — avoids pulling in os-toggle.ts's side-effects (init())
// into unit tests. The STORAGE_KEY constant is duplicated here intentionally
// (single source of truth is os-toggle.ts but importing the value would drag
// in the side-effect module).

import type { OS } from './os-toggle.js';

const STORAGE_KEY = 'os-preference';

// Ordered fallback chain for OS detection when no stored preference exists.
function detectOsFromUa(): OS {
  try {
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac|iPhone|iPad|iPod/i.test(ua)) return 'macOS';
    if (/Linux|X11/i.test(ua)) return 'Linux';
  } catch { /* SSR / headless */ }
  return 'Windows';
}

/** Returns the currently active OS: stored preference → UA detection → 'Windows'. */
export function getActiveOs(): OS {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'Windows' || stored === 'macOS' || stored === 'Linux' || stored === 'BAS') {
      return stored;
    }
  } catch { /* private-mode / quota */ }
  return detectOsFromUa();
}

/**
 * Returns the display label for an OS-tagged <kbd> element.
 * BAS maps to the Windows form (per design D2).
 * Linux falls back to the Windows form when data-linux is absent.
 */
export function kbdLabel(el: HTMLElement, os: OS): string {
  const ds = el.dataset;
  if (os === 'macOS') {
    return ds['mac'] ?? ds['win'] ?? '';
  }
  if (os === 'Linux') {
    return ds['linux'] ?? ds['win'] ?? '';
  }
  // 'Windows' and 'BAS' both use the Windows form.
  return ds['win'] ?? '';
}

/**
 * Returns an accessible aria-label string for a kbd label by spelling out
 * Mac modifier symbols. Win/Linux labels (e.g. "Ctrl+Shift+P") are already
 * readable and returned unchanged after trim.
 */
export function kbdAriaLabel(rawLabel: string): string {
  const result = rawLabel
    .replace(/⌘/g, 'Command ')
    .replace(/⌥/g, 'Option ')
    .replace(/⇧/g, 'Shift ')
    .replace(/⌃/g, 'Control ')
    .replace(/↩/g, 'Return ')
    .replace(/  +/g, ' ')
    .trim();
  return result;
}

/**
 * Updates all <kbd data-kbd> elements to display the keybinding for `os`.
 * Called on DOMContentLoaded and whenever the user switches OS in the picker.
 */
export function applyOs(os: OS): void {
  document.querySelectorAll<HTMLElement>('[data-kbd]').forEach((el) => {
    const label = kbdLabel(el, os);
    el.textContent = label;
    el.setAttribute('aria-label', kbdAriaLabel(label));
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

function init(): void {
  applyOs(getActiveOs());

  // Listen for OS picker changes dispatched by os-toggle.ts.
  document.addEventListener('osprefchange', (e) => {
    const os = (e as CustomEvent<{ os: OS }>).detail?.os;
    if (os) applyOs(os);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Test seam — exported for unit tests.
export const __test__ = { getActiveOs, kbdLabel, kbdAriaLabel, applyOs };
