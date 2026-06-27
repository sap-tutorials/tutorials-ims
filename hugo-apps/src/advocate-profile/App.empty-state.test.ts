// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from './App.vue';

describe('advocate-profile App.vue 404 path', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders the "no longer listed" banner on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, json: async () => ({}),
    } as unknown as Response);

    const wrapper = mount(App, { props: { apiUrl: '/api/advocates/gone' } });
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toMatch(/no longer listed/i);
    expect(wrapper.find('.adv-profile-island-banner').exists()).toBe(true);
  });

  it('renders nothing on a generic 5xx error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({}),
    } as unknown as Response);

    const wrapper = mount(App, { props: { apiUrl: '/api/advocates/x' } });
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('.adv-profile-island-banner').exists()).toBe(false);
    expect(wrapper.find('h2').exists()).toBe(false);
  });
});
