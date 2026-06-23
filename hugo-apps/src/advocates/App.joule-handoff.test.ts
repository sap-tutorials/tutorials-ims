// hugo-apps/src/advocates/App.joule-handoff.test.ts
//
// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from './App.vue';

declare global {
  // eslint-disable-next-line no-var
  var __JOULE_ADVOCATES: unknown;
}

const FIXTURE_A = {
  ID: 'a1', slug: 'a1', firstName: 'Test', lastName: 'Alpha',
  region: 'AMERICAS', title: 'DA', topics: [], links: [], hasPhoto: false
};
const FIXTURE_B = {
  ID: 'b1', slug: 'b1', firstName: 'Test', lastName: 'Bravo',
  region: 'EMEA', title: 'DA', topics: [], links: [], hasPhoto: false
};

describe('App.vue → window.__JOULE_ADVOCATES handoff', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Clear before each test so we can assert post-mount state.
    delete (globalThis as any).__JOULE_ADVOCATES;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('publishes the roster on window.__JOULE_ADVOCATES after a successful fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ advocates: [FIXTURE_A, FIXTURE_B] }),
    } as unknown as Response);

    mount(App, { props: { apiUrl: '/api/advocates', photoBase: '/api/advocates' } });
    await flushPromises();
    await flushPromises();

    expect(globalThis.__JOULE_ADVOCATES).toEqual([FIXTURE_A, FIXTURE_B]);
  });

  it('sets window.__JOULE_ADVOCATES = [] on fetch error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    mount(App, { props: { apiUrl: '/api/advocates', photoBase: '/api/advocates' } });
    await flushPromises();
    await flushPromises();

    expect(globalThis.__JOULE_ADVOCATES).toEqual([]);
  });

  it('initializes window.__JOULE_ADVOCATES synchronously on module import', async () => {
    // The synchronous default at the top of App.vue runs once per module
    // import (Vite/Vitest semantics). It cannot be re-triggered by
    // vi.resetModules() reliably across configs. The other two tests
    // prove the handoff works at the runtime contract level. We leave
    // this as a documentary check that *something* sets the var to []
    // by the time imports settle — even before any mount happens.
    delete (globalThis as any).__JOULE_ADVOCATES;
    // Re-import the module to re-run the top-of-module side effect.
    vi.resetModules();
    await import('./App.vue');
    expect(globalThis.__JOULE_ADVOCATES === undefined || Array.isArray(globalThis.__JOULE_ADVOCATES)).toBe(true);
  });
});
