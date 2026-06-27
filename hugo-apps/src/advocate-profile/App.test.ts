// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from './App.vue';

describe('advocate-profile App.vue', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders both list sections when both arrays are non-empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        slug: 'thomas-jung', firstName: 'Thomas', lastName: 'Jung',
        authoredTutorials: [{ slug: 'tut-a', title: 'Tutorial A' }],
        contributedTutorials: [{ slug: 'tut-b', title: 'Tutorial B' }],
      }),
    } as unknown as Response);

    const wrapper = mount(App, { props: { apiUrl: '/api/advocates/thomas-jung' } });
    await flushPromises();
    await flushPromises();

    const text = wrapper.text();
    expect(text).toMatch(/Tutorials authored/i);
    expect(text).toMatch(/Tutorials contributed/i);
    expect(text).toContain('Tutorial A');
    expect(text).toContain('Tutorial B');
  });

  it('hides authored section when the array is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        slug: 's', firstName: 'F', lastName: 'L',
        contributedTutorials: [{ slug: 't', title: 'T' }],
      }),
    } as unknown as Response);

    const wrapper = mount(App, { props: { apiUrl: '/api/advocates/s' } });
    await flushPromises();
    await flushPromises();

    const text = wrapper.text();
    expect(text).toMatch(/Tutorials contributed/i);
    expect(text).not.toMatch(/Tutorials authored/i);
  });
});
