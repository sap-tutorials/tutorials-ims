// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyEmbedMode } from './main';

// main.ts calls the bare `localStorage` global. Under vitest/Node that global
// is the experimental (unavailable) one, so install a simple in-memory stub on
// globalThis for these assertions (the try/catch in main.ts would otherwise
// swallow the failure and we could not observe persistence).
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
}

describe('applyEmbedMode persistence (#1584)', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.embed;
    installMemoryLocalStorage();
  });

  it('explicit mode applies AND persists to localStorage', () => {
    applyEmbedMode('minimal', false /* reset */, true /* persist */);
    expect(document.documentElement.dataset.embed).toBe('minimal');
    expect(localStorage.getItem('embed')).toBe('minimal');
  });

  it('auto-derived mode (persist:false) applies but does NOT persist', () => {
    applyEmbedMode('minimal', false /* reset */, false /* persist */);
    expect(document.documentElement.dataset.embed).toBe('minimal');
    expect(localStorage.getItem('embed')).toBeNull();
  });

  it('defaults to persisting when the persist arg is omitted', () => {
    applyEmbedMode('reader', false);
    expect(document.documentElement.dataset.embed).toBe('reader');
    expect(localStorage.getItem('embed')).toBe('reader');
  });

  it('reset clears the attribute and removes localStorage regardless of persist', () => {
    localStorage.setItem('embed', 'minimal');
    document.documentElement.dataset.embed = 'minimal';
    applyEmbedMode(null, true /* reset */);
    expect(document.documentElement.dataset.embed).toBeUndefined();
    expect(localStorage.getItem('embed')).toBeNull();
  });

  it('an auto-only apply never leaks into a later normal visit (localStorage stays empty)', () => {
    // Simulates a narrow iframe with no embed param: pickAutoMode → 'minimal',
    // res.mode === null so persist is false.
    applyEmbedMode('minimal', false, false);
    expect(localStorage.getItem('embed')).toBeNull();
  });
});
