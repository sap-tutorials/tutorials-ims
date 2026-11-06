// hugo/assets/js/sync-groups.ts
//
// Unified client-side choice-storage runtime.
// Backs the OS-toggle, codetabs, and future OPTION sync-groups.
//
// Storage layout: ONE JSON object at localStorage["sync-groups"].
//   { os: "macOS", runtime: "Java", codetabs: "Node.js", … }
//
// Migration: reads legacy per-key localStorage items for "os" and "codetabs"
// so returning readers' existing preferences are honoured for one release.

const STORAGE_KEY = 'sync-groups';
const LEGACY_FALLBACK: Record<string, string> = {
  os: 'os-preference',
  codetabs: 'codetabs-preference',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readObject(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeObject(obj: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* private mode / storage quota — preference simply won't persist */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Name of the custom DOM event used for same-document fan-out. */
const SYNC_EVENT = 'sync-groups:change';

/** Read the stored choice for `key` from the unified object.
 *  Falls back to the legacy per-key `localStorage` entry for "os" and
 *  "codetabs" so existing preferences are honoured during the transition. */
export function getChoice(key: string): string | null {
  const obj = readObject();
  if (key in obj && typeof obj[key] === 'string') return obj[key];
  // Migration read-fallback for one release.
  const legacyKey = LEGACY_FALLBACK[key];
  if (legacyKey) {
    try {
      const v = localStorage.getItem(legacyKey);
      return v ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Persist `value` for `key` inside the unified JSON object. */
export function setChoice(key: string, value: string): void {
  const obj = readObject();
  obj[key] = value;
  writeObject(obj);
  // Emit an in-page event so same-document subscribers fire immediately.
  // (The native `storage` event only fires in OTHER documents.)
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { key, value } }));
}

/** Register a callback that fires when any document writes a new value for
 *  `key` — either this document (via the custom in-page event) or another
 *  browser tab (via the native `storage` event).
 *  Returns an unsubscribe function. */
export function onChange(key: string, cb: (value: string) => void): () => void {
  // Same-document path: custom event dispatched by setChoice().
  function inPageHandler(e: Event): void {
    const { key: k, value } = (e as CustomEvent<{ key: string; value: string }>).detail;
    if (k === key) cb(value);
  }
  // Cross-tab path: native storage event from another document.
  function storageHandler(e: StorageEvent): void {
    if (e.key !== STORAGE_KEY) return;
    if (!e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue) as Record<string, string>;
      if (key in parsed && typeof parsed[key] === 'string') {
        cb(parsed[key]);
      }
    } catch {
      // corrupt value — ignore
    }
  }
  window.addEventListener(SYNC_EVENT, inPageHandler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(SYNC_EVENT, inPageHandler);
    window.removeEventListener('storage', storageHandler);
  };
}

/** Resolution options for `resolveChoice`. */
export interface ResolveChoiceOptions {
  /** Raw value from the URL query-string (e.g. `?runtime=JAVA`). */
  urlParam?: string;
  /** OS / runtime detected from the browser environment. */
  detected?: string;
  /** Default for the current group or page. */
  groupDefault?: string;
  /** The first tab value rendered in the group. */
  firstTab?: string;
  /** Maps a raw URL-param string to the canonical value, or returns null when
   *  the raw value is unrecognised. Enables case-insensitive matching:
   *    `(raw) => ['Node.js','Java'].find(v => v.toLowerCase() === raw.toLowerCase()) ?? null`
   */
  canonicalize?: (raw: string) => string | null;
}

/** Resolve the active choice for `key` using the 5-step resolution order:
 *    1. URL param (canonicalized — skipped if not recognised)
 *    2. Stored choice (from unified object, with legacy fallback)
 *    3. Detected value
 *    4. groupDefault
 *    5. firstTab
 *    6. '' (empty string) when every option is absent
 */
export function resolveChoice(key: string, opts: ResolveChoiceOptions): string {
  // 1. URL param
  if (opts.urlParam !== undefined) {
    const canonical = opts.canonicalize
      ? opts.canonicalize(opts.urlParam)
      : opts.urlParam;
    if (canonical !== null && canonical !== undefined && canonical !== '') {
      return canonical;
    }
  }

  // 2. Stored choice (guard empty string — a stored "" must not strand resolution)
  const stored = getChoice(key);
  if (stored !== null && stored !== '') return stored;

  // 3. Detected
  if (opts.detected !== undefined && opts.detected !== '') return opts.detected;

  // 4. Group default
  if (opts.groupDefault !== undefined && opts.groupDefault !== '') return opts.groupDefault;

  // 5. First tab
  if (opts.firstTab !== undefined && opts.firstTab !== '') return opts.firstTab;

  // 6. Fallback
  return '';
}

// ---------------------------------------------------------------------------
// Picker bar — DOM integration
// ---------------------------------------------------------------------------

/** Selector constants used by the picker bar feature. */
const PICKER_ATTR = 'data-sync-picker';
const PICKER_KEY_ATTR = 'data-sync-key';
const PICKER_VALUE_ATTR = 'data-sync-value';
/** Selector for content strips — the inner tablist div that carries data-sync-key.
 *  Panels (.tab-panel) are siblings of .fd-tabs inside the outer [data-component="tabs"] wrapper. */
const CONTENT_STRIP_SELECTOR = `.fd-tabs[${PICKER_KEY_ATTR}]`;
const STRIP_BTN_SELECTOR = '[role="tab"][data-sync-value]';
const STRIP_PANEL_SELECTOR = '.tab-panel[data-sync-value]';
const PLACEHOLDER_ATTR = 'data-sync-missing-placeholder';
const ANNOUNCE_ATTR = 'data-sync-announce';

/** Apply the given choice to all strips sharing `key` on the page.
 *  Strips that lack the chosen `value` get a missing-variant placeholder
 *  instead of silently switching to another tab. */
function applyChoiceToStrips(key: string, value: string): void {
  // Target .fd-tabs[data-sync-key="<key>"] — the inner tablist that carries the key.
  // Picker bars also carry data-sync-key but are [data-sync-picker], not .fd-tabs,
  // so they are naturally excluded.
  const strips = document.querySelectorAll<HTMLElement>(`.fd-tabs[${PICKER_KEY_ATTR}="${key}"]`);

  for (const strip of strips) {
    // Walk up to the [data-component="tabs"] wrapper which contains BOTH buttons
    // (inside .fd-tabs) and panels (inside .tab-panels, a sibling of .fd-tabs).
    const tabsContainer = strip.closest<HTMLElement>('[data-component="tabs"]') ?? strip;

    // Remove any existing placeholder from a prior activation
    const oldPlaceholder = tabsContainer.querySelector<HTMLElement>(`[${PLACEHOLDER_ATTR}]`);
    if (oldPlaceholder) oldPlaceholder.remove();

    // Check whether the requested value exists among the buttons (buttons live inside .fd-tabs = strip)
    const hasValue = strip.querySelector(`[${PICKER_VALUE_ATTR}="${value}"]`) !== null;

    if (!hasValue) {
      // Collect the values that ARE available in this strip
      const available: string[] = [];
      for (const btn of strip.querySelectorAll<HTMLElement>(STRIP_BTN_SELECTOR)) {
        const v = btn.getAttribute(PICKER_VALUE_ATTR);
        if (v) available.push(v);
      }

      // Build placeholder element
      const placeholder = document.createElement('div');
      placeholder.setAttribute(PLACEHOLDER_ATTR, '');
      placeholder.setAttribute('data-sync-missing', '');
      placeholder.className = 'option-tabs__missing-placeholder';
      placeholder.textContent =
        `"${value}" is not available in this section. ` +
        (available.length > 0
          ? `Available options: ${available.join(', ')}.`
          : 'No options available.');

      // Hide all panels so nothing stale remains visible (panels are inside tabsContainer)
      for (const panel of tabsContainer.querySelectorAll<HTMLElement>(STRIP_PANEL_SELECTOR)) {
        panel.hidden = true;
      }
      for (const btn of strip.querySelectorAll<HTMLElement>(STRIP_BTN_SELECTOR)) {
        btn.setAttribute('aria-selected', 'false');
        btn.tabIndex = -1;
      }

      // Insert placeholder inside the tabs container
      tabsContainer.appendChild(placeholder);
      continue;
    }

    // Normal activation: toggle buttons (inside .fd-tabs) and panels (inside tabsContainer)
    for (const btn of strip.querySelectorAll<HTMLElement>(STRIP_BTN_SELECTOR)) {
      const v = btn.getAttribute(PICKER_VALUE_ATTR);
      if (v === value) {
        btn.setAttribute('is-selected', '');
        btn.setAttribute('aria-selected', 'true');
        btn.tabIndex = 0;
      } else {
        btn.removeAttribute('is-selected');
        btn.setAttribute('aria-selected', 'false');
        btn.tabIndex = -1;
      }
    }
    for (const panel of tabsContainer.querySelectorAll<HTMLElement>(STRIP_PANEL_SELECTOR)) {
      const v = panel.getAttribute(PICKER_VALUE_ATTR);
      panel.hidden = v !== value;
    }
  }
}

/** Update the picker bar buttons for `key` to reflect `value`. */
function syncPickerBar(key: string, value: string): void {
  const pickers = document.querySelectorAll<HTMLElement>(`[${PICKER_ATTR}][${PICKER_KEY_ATTR}="${key}"]`);
  for (const picker of pickers) {
    for (const item of picker.querySelectorAll<HTMLElement>(`[${PICKER_VALUE_ATTR}]`)) {
      const v = item.getAttribute(PICKER_VALUE_ATTR);
      if (v === value) {
        item.setAttribute('pressed', '');
      } else {
        item.removeAttribute('pressed');
      }
    }
  }
}

/** Announce the choice change to assistive technologies. */
function announceChoice(key: string, value: string): void {
  const region = document.querySelector<HTMLElement>(`[${ANNOUNCE_ATTR}]`);
  if (!region) return;
  region.textContent = `${key} changed to ${value}`;
}

/** Wire up all picker bars on the page.
 *
 *  - Hides pickers where < 2 strips share the same key.
 *  - Listens for clicks on `[data-sync-value]` items inside each picker.
 *  - Calls `applyChoiceToStrips`, `setChoice`, and `announceChoice`.
 */
export function initPickerBars(): void {
  const pickers = document.querySelectorAll<HTMLElement>(`[${PICKER_ATTR}]`);

  for (const picker of pickers) {
    const key = picker.getAttribute(PICKER_KEY_ATTR);
    if (!key) continue;

    // Count only content strips (not picker bars themselves)
    const stripCount = document.querySelectorAll<HTMLElement>(`.fd-tabs[${PICKER_KEY_ATTR}="${key}"]`).length;

    // Hide picker when fewer than 2 strips share this key
    if (stripCount < 2) {
      picker.hidden = true;
      continue;
    }

    // Restore any previously stored choice
    const stored = getChoice(key);
    if (stored) {
      applyChoiceToStrips(key, stored);
      syncPickerBar(key, stored);
    }

    // Wire click on picker items
    picker.addEventListener('click', (e: Event) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(`[${PICKER_VALUE_ATTR}]`);
      if (!target) return;
      const value = target.getAttribute(PICKER_VALUE_ATTR);
      if (!value) return;

      setChoice(key, value);
      applyChoiceToStrips(key, value);
      syncPickerBar(key, value);
      announceChoice(key, value);
    });
  }
}

// Auto-init when loaded in the browser (not during unit tests which call initPickerBars manually)
if (typeof document !== 'undefined' && typeof window !== 'undefined' && !('__vitest__' in window)) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPickerBars);
  } else {
    initPickerBars();
  }
}

// ---------------------------------------------------------------------------
// Test seam — exposes internals to unit tests, not part of the public API.
// ---------------------------------------------------------------------------
export const __test__ = {
  getChoice,
  setChoice,
  onChange,
  resolveChoice,
  initPickerBars,
};
