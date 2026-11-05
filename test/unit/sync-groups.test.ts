// @vitest-environment happy-dom
// test/unit/sync-groups.test.ts
//
// Unit tests for hugo/assets/js/sync-groups.ts — the unified client-side
// choice-storage runtime backing OS-toggle, codetabs, and future OPTION groups.
//
// Pattern mirrors os-toggle.test.ts:
//   1. seed localStorage BEFORE the lazy `import(...)` so the module reads the
//      right initial state.
//   2. Tests import via `__test__` to reach internals without side-effects.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UNIFIED_KEY = 'sync-groups';
const LEGACY_OS_KEY = 'os-preference';
const LEGACY_CODETABS_KEY = 'codetabs-preference';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedUnified(obj: Record<string, string>) {
  localStorage.setItem(UNIFIED_KEY, JSON.stringify(obj));
}

function readUnified(): Record<string, string> {
  const raw = localStorage.getItem(UNIFIED_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, string>; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// getChoice / setChoice — unified object round-trip
// ---------------------------------------------------------------------------

describe('getChoice / setChoice — unified storage round-trip', () => {
  beforeEach(() => { localStorage.clear(); });

  it('getChoice returns null when nothing is stored', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    expect(__test__.getChoice('os')).toBeNull();
  });

  it('setChoice persists inside the unified JSON object', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    __test__.setChoice('os', 'macOS');
    const stored = readUnified();
    expect(stored.os).toBe('macOS');
  });

  it('setChoice does NOT clobber sibling keys', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    __test__.setChoice('runtime', 'Java');
    __test__.setChoice('os', 'Linux');
    const stored = readUnified();
    expect(stored.runtime).toBe('Java');
    expect(stored.os).toBe('Linux');
  });

  it('getChoice reads back what setChoice stored', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    __test__.setChoice('runtime', 'Node.js');
    expect(__test__.getChoice('runtime')).toBe('Node.js');
  });

  it('getChoice returns null for an unknown key even when the object exists', async () => {
    seedUnified({ os: 'Windows' });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    expect(__test__.getChoice('runtime')).toBeNull();
  });

  it('getChoice handles corrupt localStorage gracefully (returns null)', async () => {
    localStorage.setItem(UNIFIED_KEY, 'not-json{{{');
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    expect(__test__.getChoice('os')).toBeNull();
  });

  it('setChoice tolerates a full localStorage without throwing', async () => {
    // Simulate a storage quota error — setChoice must swallow it.
    const origSetItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new DOMException('QuotaExceededError'); });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    expect(() => __test__.setChoice('os', 'Windows')).not.toThrow();
    vi.restoreAllMocks();
    // Manually restore for subsequent tests
    localStorage.setItem = origSetItem;
  });
});

// ---------------------------------------------------------------------------
// Migration: legacy os-preference → unified 'os' key
// ---------------------------------------------------------------------------

describe('migration — legacy os-preference fallback', () => {
  beforeEach(() => { localStorage.clear(); });

  it('reads legacy os-preference when unified object has no os key', async () => {
    localStorage.setItem(LEGACY_OS_KEY, 'Linux');
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    // getChoice('os') should fall through to the legacy key
    expect(__test__.getChoice('os')).toBe('Linux');
  });

  it('unified object wins over legacy when both exist', async () => {
    localStorage.setItem(LEGACY_OS_KEY, 'macOS');
    seedUnified({ os: 'Windows' });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    expect(__test__.getChoice('os')).toBe('Windows');
  });

  it('reads legacy codetabs-preference for key "codetabs" when unified lacks it', async () => {
    localStorage.setItem(LEGACY_CODETABS_KEY, 'Java');
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    expect(__test__.getChoice('codetabs')).toBe('Java');
  });

  it('unified codetabs wins over legacy codetabs-preference', async () => {
    localStorage.setItem(LEGACY_CODETABS_KEY, 'Java');
    seedUnified({ codetabs: 'Node.js' });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    expect(__test__.getChoice('codetabs')).toBe('Node.js');
  });

  it('returns null when no legacy or unified value exists for that key', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    expect(__test__.getChoice('runtime')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onChange — fires on cross-tab storage events
// ---------------------------------------------------------------------------

describe('onChange — cross-tab storage events', () => {
  beforeEach(() => { localStorage.clear(); });

  it('fires the callback when a storage event updates the relevant key', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const calls: string[] = [];
    __test__.onChange('os', (v) => calls.push(v));

    // Simulate the storage event from another tab writing the unified object.
    const next = JSON.stringify({ os: 'Linux' });
    window.dispatchEvent(new StorageEvent('storage', {
      key: UNIFIED_KEY,
      oldValue: null,
      newValue: next,
      storageArea: localStorage,
    }));

    expect(calls).toEqual(['Linux']);
  });

  it('does NOT fire when a different key changes', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const calls: string[] = [];
    __test__.onChange('os', (v) => calls.push(v));

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'unrelated-key',
      oldValue: null,
      newValue: 'whatever',
      storageArea: localStorage,
    }));

    expect(calls).toHaveLength(0);
  });

  it('does NOT fire when the watched inner key is not present in the new object', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const calls: string[] = [];
    __test__.onChange('runtime', (v) => calls.push(v));

    const next = JSON.stringify({ os: 'macOS' }); // no "runtime"
    window.dispatchEvent(new StorageEvent('storage', {
      key: UNIFIED_KEY,
      oldValue: null,
      newValue: next,
      storageArea: localStorage,
    }));

    expect(calls).toHaveLength(0);
  });

  it('unsubscribe stops further callbacks', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const calls: string[] = [];
    const unsub = __test__.onChange('os', (v) => calls.push(v));

    unsub(); // unsubscribe immediately

    window.dispatchEvent(new StorageEvent('storage', {
      key: UNIFIED_KEY,
      oldValue: null,
      newValue: JSON.stringify({ os: 'BAS' }),
      storageArea: localStorage,
    }));

    expect(calls).toHaveLength(0);
  });

  it('fires for each relevant storage event after first', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const calls: string[] = [];
    __test__.onChange('os', (v) => calls.push(v));

    for (const os of ['Linux', 'macOS', 'Windows']) {
      window.dispatchEvent(new StorageEvent('storage', {
        key: UNIFIED_KEY,
        newValue: JSON.stringify({ os }),
        storageArea: localStorage,
      }));
    }

    expect(calls).toEqual(['Linux', 'macOS', 'Windows']);
  });
});

// ---------------------------------------------------------------------------
// resolveChoice — 5-step resolution order
// ---------------------------------------------------------------------------

describe('resolveChoice — resolution order', () => {
  beforeEach(() => { localStorage.clear(); });

  it('URL param wins over everything else (exact case match)', async () => {
    seedUnified({ os: 'Linux' });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('os', {
      urlParam: 'macOS',
      detected: 'Windows',
      groupDefault: 'BAS',
      firstTab: 'Linux',
      canonicalize: (raw: string) => ['Windows', 'macOS', 'Linux', 'BAS'].find(v => v.toLowerCase() === raw.toLowerCase()) ?? null,
    });
    expect(result).toBe('macOS');
  });

  it('URL param is matched case-insensitively via canonicalize', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('os', {
      urlParam: 'MACOS',
      detected: 'Windows',
      groupDefault: 'BAS',
      firstTab: 'Linux',
      canonicalize: (raw: string) => ['Windows', 'macOS', 'Linux', 'BAS'].find(v => v.toLowerCase() === raw.toLowerCase()) ?? null,
    });
    expect(result).toBe('macOS');
  });

  it('URL param that does not match canonical values is ignored → stored wins', async () => {
    seedUnified({ os: 'Linux' });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('os', {
      urlParam: 'UNKNOWN_OS',
      detected: 'Windows',
      groupDefault: 'BAS',
      firstTab: 'macOS',
      canonicalize: (raw: string) => ['Windows', 'macOS', 'Linux', 'BAS'].find(v => v.toLowerCase() === raw.toLowerCase()) ?? null,
    });
    expect(result).toBe('Linux');
  });

  it('stored choice wins when no URL param', async () => {
    seedUnified({ os: 'BAS' });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('os', {
      detected: 'Windows',
      groupDefault: 'Linux',
      firstTab: 'macOS',
    });
    expect(result).toBe('BAS');
  });

  it('detected wins when no URL param and no stored choice', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('os', {
      detected: 'Linux',
      groupDefault: 'Windows',
      firstTab: 'macOS',
    });
    expect(result).toBe('Linux');
  });

  it('groupDefault wins when no URL param, no stored choice, no detected', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('os', {
      groupDefault: 'Windows',
      firstTab: 'macOS',
    });
    expect(result).toBe('Windows');
  });

  it('firstTab wins when all higher-priority options are absent', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('os', {
      firstTab: 'macOS',
    });
    expect(result).toBe('macOS');
  });

  it('returns empty string when every option is absent', async () => {
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('os', {});
    expect(result).toBe('');
  });

  it('a stored empty string "" falls through to detected/groupDefault/firstTab', async () => {
    // An empty write must NOT strand resolution at the stored step — it must
    // continue down to the next priority so Task-3 OPTION groups can't get
    // stuck with a permanently blank selection.
    seedUnified({ os: '' });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');

    // Falls through "" → detected
    expect(__test__.resolveChoice('os', { detected: 'Linux', groupDefault: 'macOS', firstTab: 'Windows' })).toBe('Linux');
    // Falls through "" + no detected → groupDefault
    expect(__test__.resolveChoice('os', { groupDefault: 'macOS', firstTab: 'Windows' })).toBe('macOS');
    // Falls through "" + no detected + no groupDefault → firstTab
    expect(__test__.resolveChoice('os', { firstTab: 'Windows' })).toBe('Windows');
  });

  it('resolveChoice("runtime", …) works the same for a non-os key', async () => {
    seedUnified({ runtime: 'Java' });
    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    const result = __test__.resolveChoice('runtime', {
      urlParam: 'Node.js',
      detected: 'Java',
      groupDefault: 'Java',
      firstTab: 'Java',
      canonicalize: (raw: string) => ['Node.js', 'Java'].find(v => v.toLowerCase() === raw.toLowerCase()) ?? null,
    });
    expect(result).toBe('Node.js');
  });
});
