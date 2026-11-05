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
}

/** Register a callback that fires when another tab writes a new value for
 *  `key` to the unified object (via the native `storage` event).
 *  Returns an unsubscribe function. */
export function onChange(key: string, cb: (value: string) => void): () => void {
  function handler(e: StorageEvent): void {
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
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
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
// Test seam — exposes internals to unit tests, not part of the public API.
// ---------------------------------------------------------------------------
export const __test__ = {
  getChoice,
  setChoice,
  onChange,
  resolveChoice,
};
