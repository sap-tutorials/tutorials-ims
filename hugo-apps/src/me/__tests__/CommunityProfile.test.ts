// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import CommunityProfile from '../CommunityProfile.vue';
import { _resetCsrfTokenCacheForTests, _seedCsrfTokenForTests } from '@shared/csrf-fetch';

function mockFetch(routes: Record<string, () => Promise<any>>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method || 'GET'} ${url}`;
    const handler = routes[key] ?? routes[url];
    if (!handler) throw new Error(`unmocked: ${key}`);
    const result = await handler();
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.body,
    };
  });
}

describe('CommunityProfile.vue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // csrfFetch() (used for POST /api/setKhorosLink and /api/clearKhorosLink)
    // would otherwise fire an extra `GET /auth/user` handshake that mockFetch's
    // strict routing table throws on. Seed the token so csrfFetch skips it.
    _resetCsrfTokenCacheForTests();
    _seedCsrfTokenForTests('TEST-CSRF');
  });

  it('renders unlinked state when getKhorosProfile returns linked:false', async () => {
    const fetchMock = mockFetch({
      '/api/getKhorosProfile()': async () => ({ body: { linked: false } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    expect(wrapper.find('ui5-input').exists()).toBe(true);
    expect(wrapper.find('ui5-button').exists()).toBe(true);
    expect(wrapper.find('.linked-chip').exists()).toBe(false);
  });

  it('renders linked chip when getKhorosProfile returns linked:true', async () => {
    const fetchMock = mockFetch({
      '/api/getKhorosProfile()': async () => ({
        body: {
          linked: true,
          khorosId: '123',
          khorosLogin: 'j_doe',
          name: 'Jane Doe',
          rank: 'Star Blogger',
          avatarUrl: 'https://x/a.png',
          profileUrl: 'https://community.sap.com/t5/user/viewprofilepage/user-id/123',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    expect(wrapper.text()).toContain('Jane Doe');
    expect(wrapper.text()).toContain('@j_doe');
    expect(wrapper.text()).toContain('Star Blogger');
    expect(wrapper.find('.linked-chip').exists()).toBe(true);
  });

  it('on Link click → POST /api/setKhorosLink → success transitions to linked', async () => {
    const fetchMock = mockFetch({
      '/api/getKhorosProfile()': async () => ({ body: { linked: false } }),
      'POST /api/setKhorosLink': async () => ({
        body: {
          status: 'ok',
          khorosId: '123',
          khorosLogin: 'j_doe',
          name: 'Jane Doe',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    // Drive the island's setup-exposed onLink directly to bypass UI5 input plumbing.
    const vm = wrapper.vm as any;
    vm.input = 'j_doe';
    await vm.onLink();
    await flushPromises();
    expect(wrapper.text()).toContain('Jane Doe');
  });

  it('maps status:not-found to the lurker error copy', async () => {
    const fetchMock = mockFetch({
      '/api/getKhorosProfile()': async () => ({ body: { linked: false } }),
      'POST /api/setKhorosLink': async () => ({
        body: { status: 'not-found' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.input = 'ghost_user';
    await vm.onLink();
    await flushPromises();
    expect(wrapper.text()).toMatch(/couldn.?t find that community user/i);
  });

  it('maps status:already-claimed to the friendly conflict copy', async () => {
    const fetchMock = mockFetch({
      '/api/getKhorosProfile()': async () => ({ body: { linked: false } }),
      'POST /api/setKhorosLink': async () => ({
        body: { status: 'already-claimed' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.input = 'taken';
    await vm.onLink();
    await flushPromises();
    expect(wrapper.text()).toMatch(/already linked/i);
  });

  it('maps status:upstream-unavailable to the Information strip copy', async () => {
    const fetchMock = mockFetch({
      '/api/getKhorosProfile()': async () => ({ body: { linked: false } }),
      'POST /api/setKhorosLink': async () => ({
        body: { status: 'upstream-unavailable' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.input = '12345';
    await vm.onLink();
    await flushPromises();
    expect(wrapper.text()).toMatch(/SAP Community is unreachable/i);
  });

  it('Unlink → POST /api/clearKhorosLink → transitions to unlinked', async () => {
    let cleared = false;
    const fetchMock = mockFetch({
      '/api/getKhorosProfile()': async () =>
        cleared
          ? { body: { linked: false } }
          : {
              body: {
                linked: true,
                khorosId: '123',
                khorosLogin: 'j_doe',
                name: 'Jane Doe',
                rank: '',
                avatarUrl: '',
                profileUrl: 'https://community.sap.com/t5/user/viewprofilepage/user-id/123',
              },
            },
      'POST /api/clearKhorosLink': async () => {
        cleared = true;
        return { body: { status: 'ok' } };
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    const vm = wrapper.vm as any;
    await vm.onUnlink();
    await flushPromises();
    expect(wrapper.find('.linked-chip').exists()).toBe(false);
    expect(wrapper.find('ui5-input').exists()).toBe(true);
  });
});
