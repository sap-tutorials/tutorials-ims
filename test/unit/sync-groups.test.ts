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

// ---------------------------------------------------------------------------
// Picker bar — DOM-driven tests (Task 5)
// ---------------------------------------------------------------------------

/**
 * Build a minimal DOM representing two sync-group strips, each with
 * Node.js and Java panels, and a picker bar with two buttons.
 *
 * Strip HTML structure mirrors what Task 4 shortcodes emit:
 *   <div class="option-tabs" data-sync-key="runtime">
 *     <div class="option-tabs__bar">
 *       <button class="option-tabs__btn" data-sync-value="Node.js" is-selected>Node.js</button>
 *       <button class="option-tabs__btn" data-sync-value="Java">Java</button>
 *     </div>
 *     <div class="option-tabs__panel" data-sync-value="Node.js">…</div>
 *     <div class="option-tabs__panel" data-sync-value="Java" hidden>…</div>
 *   </div>
 *
 * Picker bar structure (what Task 5 adds to the Hugo template):
 *   <div class="sync-picker" data-sync-picker data-sync-key="runtime">
 *     <ui5-segmented-button>
 *       <ui5-segmented-button-item data-sync-value="Node.js" pressed>Node.js</ui5-segmented-button-item>
 *       <ui5-segmented-button-item data-sync-value="Java">Java</ui5-segmented-button-item>
 *     </ui5-segmented-button>
 *   </div>
 *   <div aria-live="polite" aria-atomic="true" class="sync-announce" data-sync-announce></div>
 */
function buildTwoStripDOM(opts: {
  strip1Values?: string[];
  strip2Values?: string[];
  pickerValues?: string[];
  initialChoice?: string;
  oneStripOnly?: boolean;
} = {}) {
  const {
    strip1Values = ['Node.js', 'Java'],
    strip2Values = ['Node.js', 'Java'],
    pickerValues = ['Node.js', 'Java'],
    initialChoice = 'Node.js',
    oneStripOnly = false,
  } = opts;

  function makeStrip(values: string[], active: string): string {
    const buttons = values.map(v =>
      `<button class="option-tabs__btn" data-sync-value="${v}"${v === active ? ' is-selected' : ''}>${v}</button>`
    ).join('');
    const panels = values.map(v =>
      `<div class="option-tabs__panel" data-sync-value="${v}"${v === active ? '' : ' hidden'}>Content for ${v}</div>`
    ).join('');
    return `<div class="option-tabs" data-sync-key="runtime">
      <div class="option-tabs__bar">${buttons}</div>
      ${panels}
    </div>`;
  }

  const pickerItems = pickerValues.map(v =>
    `<ui5-segmented-button-item data-sync-value="${v}"${v === initialChoice ? ' pressed' : ''}>${v}</ui5-segmented-button-item>`
  ).join('');

  const strip1 = makeStrip(strip1Values, initialChoice);
  const strip2 = oneStripOnly ? '' : makeStrip(strip2Values, initialChoice);

  const picker = `<div class="sync-picker" data-sync-picker data-sync-key="runtime">
    <ui5-segmented-button>
      ${pickerItems}
    </ui5-segmented-button>
  </div>`;

  const liveRegion = `<div aria-live="polite" aria-atomic="true" class="sync-announce" data-sync-announce></div>`;

  document.body.innerHTML = `${picker}${liveRegion}${strip1}${strip2}`;
}

describe('picker bar — DOM integration (Task 5)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('changing picker to Java activates Java panels in both strips', async () => {
    buildTwoStripDOM({ initialChoice: 'Node.js' });

    const { __test__ } = await import('../../hugo/assets/js/sync-groups');

    // Bootstrap the picker bar runtime
    __test__.initPickerBars();

    // Simulate clicking "Java" in the picker bar
    const javaItem = document.querySelector('[data-sync-picker] [data-sync-value="Java"]') as HTMLElement;
    expect(javaItem).not.toBeNull();
    javaItem.click();

    // All strips for "runtime" should now show Java (only content strips, not picker bars)
    const strips = document.querySelectorAll('.option-tabs[data-sync-key="runtime"]');
    expect(strips).toHaveLength(2);

    for (const strip of strips) {
      // Java button should be is-selected
      const javaBtn = strip.querySelector('[data-sync-value="Java"]') as HTMLElement;
      expect(javaBtn).not.toBeNull();
      expect(javaBtn.hasAttribute('is-selected')).toBe(true);
      // Node.js button should NOT be is-selected
      const nodeBtn = strip.querySelector('[data-sync-value="Node.js"]') as HTMLElement;
      expect(nodeBtn?.hasAttribute('is-selected')).toBe(false);
      // Java panel should be visible (no hidden attr)
      const javaPanel = strip.querySelector('.option-tabs__panel[data-sync-value="Java"]') as HTMLElement;
      expect(javaPanel?.hasAttribute('hidden')).toBe(false);
      // Node.js panel should be hidden
      const nodePanel = strip.querySelector('.option-tabs__panel[data-sync-value="Node.js"]') as HTMLElement;
      expect(nodePanel?.hasAttribute('hidden')).toBe(true);
    }
  });

  it('a strip lacking the active sync value shows a placeholder (no silent substitution)', async () => {
    // Strip 1 has Node.js + Java; Strip 2 only has Node.js (missing Java)
    buildTwoStripDOM({
      strip1Values: ['Node.js', 'Java'],
      strip2Values: ['Node.js'],         // Java is absent here
      pickerValues: ['Node.js', 'Java'],
      initialChoice: 'Node.js',
    });

    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    __test__.initPickerBars();

    // Switch to Java
    const javaItem = document.querySelector('[data-sync-picker] [data-sync-value="Java"]') as HTMLElement;
    javaItem.click();

    // Strip 2 should show a placeholder element (not silently switch to Node.js)
    // Use class-scoped selector to exclude the picker bar itself (which also has data-sync-key)
    const strips = document.querySelectorAll('.option-tabs[data-sync-key="runtime"]');
    const strip2 = strips[1] as HTMLElement;
    const placeholder = strip2.querySelector('[data-sync-missing-placeholder]');
    expect(placeholder).not.toBeNull();
    // Placeholder must name the missing variant
    expect(placeholder!.textContent).toMatch(/Java/);
    // Placeholder must list available values
    expect(placeholder!.textContent).toMatch(/Node\.js/);
    // Strip 2 should NOT have activated a Java panel (no Java panel exists to activate)
    const javaPanel = strip2.querySelector('.option-tabs__panel[data-sync-value="Java"]');
    expect(javaPanel).toBeNull();
  });

  it('picker bar is hidden when only one strip has the sync key', async () => {
    buildTwoStripDOM({ oneStripOnly: true });

    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    __test__.initPickerBars();

    const picker = document.querySelector('[data-sync-picker]') as HTMLElement;
    expect(picker).not.toBeNull();
    // Should be hidden: either hidden attr or display:none style or aria-hidden
    const isHidden =
      picker.hasAttribute('hidden') ||
      picker.style.display === 'none' ||
      picker.getAttribute('aria-hidden') === 'true';
    expect(isHidden).toBe(true);
  });

  it('aria-live region is announced after a choice change', async () => {
    buildTwoStripDOM({ initialChoice: 'Node.js' });

    const { __test__ } = await import('../../hugo/assets/js/sync-groups');
    __test__.initPickerBars();

    const liveRegion = document.querySelector('[data-sync-announce]') as HTMLElement;
    expect(liveRegion).not.toBeNull();

    // Before any change, region may be empty
    const before = liveRegion.textContent ?? '';

    // Switch to Java
    const javaItem = document.querySelector('[data-sync-picker] [data-sync-value="Java"]') as HTMLElement;
    javaItem.click();

    // After change, live region must have non-empty text (announces the selection)
    const after = liveRegion.textContent ?? '';
    expect(after).not.toBe(before);
    expect(after.trim().length).toBeGreaterThan(0);
    expect(after).toMatch(/Java/i);
  });
});
