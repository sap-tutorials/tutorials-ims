// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import CommunityLane from './CommunityLane.vue';

// (#1579) The advocates column previously rendered the fallback title
// "SAP Developer Advocate" on every card, because advocateName() read
// a.fullName / a.name — fields the /api/advocates payload does not carry.
// The real payload (srv/routes/advocates-public.js shapeAdvocateRow) has
// firstName + lastName. These tests fail if the name derivation regresses
// back to the title-only fallback.

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route the three parallel fetches CommunityLane fires on mount. */
function stubFetch(advocatesBody: unknown) {
  const fn = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/advocates')) return jsonResponse(advocatesBody);
    // Blogs + news degrade to their empty-state links; not under test here.
    return jsonResponse({ value: [] });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function settle(wrapper: ReturnType<typeof mount>) {
  for (let i = 0; i < 6; i++) await flushPromises();
  await wrapper.vm.$nextTick();
  await wrapper.vm.$nextTick();
}

describe('CommunityLane.vue — advocate names', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders each advocate full name from firstName + lastName, not the repeated title', async () => {
    stubFetch({
      advocates: [
        { ID: '1', slug: 'thomas-jung', firstName: 'Thomas', lastName: 'Jung', title: 'SAP Developer Advocate', region: 'AMERICAS' },
        { ID: '2', slug: 'dj-adams', firstName: 'DJ', lastName: 'Adams', title: 'SAP Developer Advocate', region: 'EMEA' },
        { ID: '3', slug: 'nora-von-thenen', firstName: 'Nora', lastName: 'von Thenen', title: 'SAP Developer Advocate', region: 'EMEA' },
      ],
    });

    const wrapper = mount(CommunityLane, { attachTo: document.body });
    await settle(wrapper);

    const names = wrapper.findAll('.hb-community-lane__adv-name').map((n) => n.text());
    expect(names).toHaveLength(3);
    expect(names).toContain('Thomas Jung');
    expect(names).toContain('DJ Adams');
    expect(names).toContain('Nora von Thenen');

    // The bug being fixed: not every card should read the same title.
    expect(names.every((n) => n === 'SAP Developer Advocate')).toBe(false);
  });

  it('falls back to the title only when both names are missing', async () => {
    stubFetch({
      advocates: [{ ID: '1', slug: 'anon', region: 'APJ' }],
    });

    const wrapper = mount(CommunityLane, { attachTo: document.body });
    await settle(wrapper);

    const names = wrapper.findAll('.hb-community-lane__adv-name').map((n) => n.text());
    expect(names).toEqual(['SAP Developer Advocate']);
  });
});
