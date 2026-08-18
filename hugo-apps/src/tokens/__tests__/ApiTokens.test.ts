// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ApiTokens from '../ApiTokens.vue';
import { _resetCsrfTokenCacheForTests, _seedCsrfTokenForTests } from '@shared/csrf-fetch';

// Keyed fetch mock: routes are looked up by "METHOD url" first, then by bare url.
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

const USER_OK = () => ({ body: { name: 'Tom', email: 'tom@example.com' } });

const TWO_TOKENS = () => ({
  body: {
    value: [
      {
        ID: 'aaaa-1111', name: 'ci-token', prefix: 'pat_abcd1234',
        scopes: ['read'], createdAt: '2026-08-01T00:00:00Z',
        expiresAt: '2026-11-01T00:00:00Z', lastUsedAt: null, revokedAt: null,
        statusText: 'Active', statusCriticality: 3, revocable: true,
      },
      {
        ID: 'bbbb-2222', name: 'old-token', prefix: 'pat_efgh5678',
        scopes: ['read', 'write'], createdAt: '2026-06-01T00:00:00Z',
        expiresAt: null, lastUsedAt: '2026-07-01T00:00:00Z',
        revokedAt: '2026-07-15T00:00:00Z',
        statusText: 'Revoked', statusCriticality: 1, revocable: false,
      },
    ],
  },
});

describe('ApiTokens.vue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // csrfFetch (POST mint/revoke) would otherwise fire a GET /auth/user
    // handshake the strict route table throws on. Seed the token so it skips it.
    _resetCsrfTokenCacheForTests();
    _seedCsrfTokenForTests('TEST-CSRF');
  });

  it('lists the signed-in user\'s existing tokens', async () => {
    const fetchMock = mockFetch({
      '/auth/user': USER_OK,
      '/pats/MyPATs': TWO_TOKENS,
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ApiTokens);
    await flushPromises();
    expect(wrapper.text()).toContain('ci-token');
    expect(wrapper.text()).toContain('pat_abcd1234');
    expect(wrapper.text()).toContain('old-token');
    // revoked row surfaces its status, active row is revocable
    expect(wrapper.text()).toMatch(/revoked/i);
  });

  it('shows a sign-in prompt (and no mint form) when unauthenticated', async () => {
    const fetchMock = mockFetch({
      '/auth/user': () => ({ ok: false, status: 401, body: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ApiTokens);
    await flushPromises();
    expect(wrapper.text()).toMatch(/sign in/i);
    // mint action must not be reachable while unauthenticated
    expect(wrapper.find('[data-test="mint-btn"]').exists()).toBe(false);
  });

  it('mints a token and reveals the plaintext exactly once', async () => {
    let listCalls = 0;
    const fetchMock = mockFetch({
      '/auth/user': USER_OK,
      '/pats/MyPATs': () => {
        listCalls++;
        return { body: { value: [] } };
      },
      'POST /pats/mintPAT': () => ({
        body: { ID: 'cccc-3333', token: 'pat_supersecretPLAINTEXT', prefix: 'pat_super', expiresAt: '2026-11-16T00:00:00Z' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ApiTokens);
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.form.name = 'my-new-token';
    vm.form.scope = 'read';
    vm.form.ttlDays = 90;
    await vm.onMint();
    await flushPromises();
    // plaintext shown once, with a copy-it-now style warning
    expect(wrapper.text()).toContain('pat_supersecretPLAINTEXT');
    expect(wrapper.text()).toMatch(/shown once|copy it now|won.?t be shown again/i);
    // list was reloaded after mint (initial + post-mint)
    expect(listCalls).toBeGreaterThanOrEqual(2);
    // dismissing clears the one-time secret from the DOM
    vm.dismissMinted();
    await flushPromises();
    expect(wrapper.text()).not.toContain('pat_supersecretPLAINTEXT');
  });

  it('sends read+write scopes when the user selects write access', async () => {
    let sentBody: any = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/user') return { ok: true, status: 200, json: async () => ({ name: 'Tom' }) };
      if (url === '/pats/MyPATs') return { ok: true, status: 200, json: async () => ({ value: [] }) };
      if (url === '/pats/mintPAT') {
        sentBody = JSON.parse(String(init?.body));
        return { ok: true, status: 200, json: async () => ({ ID: 'x', token: 'pat_x', prefix: 'pat_x', expiresAt: null }) };
      }
      throw new Error(`unmocked: ${init?.method || 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ApiTokens);
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.form.name = 'rw';
    vm.form.scope = 'readwrite';
    vm.form.ttlDays = 30;
    await vm.onMint();
    await flushPromises();
    expect(sentBody.scopes).toEqual(['read', 'write']);
    expect(sentBody.ttlDays).toBe(30);
    expect(sentBody.name).toBe('rw');
  });

  it('revokes a token via the bound action and reloads the list', async () => {
    let revokeUrl = '';
    let listCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/auth/user') return { ok: true, status: 200, json: async () => ({ name: 'Tom' }) };
      if (url === '/pats/MyPATs') { listCalls++; return { ok: true, status: 200, json: async () => TWO_TOKENS().body }; }
      if (url.includes('revokePAT')) { revokeUrl = url; return { ok: true, status: 200, json: async () => ({ ok: true, revokedAt: '2026-08-18T00:00:00Z' }) }; }
      throw new Error(`unmocked: ${init?.method || 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(ApiTokens);
    await flushPromises();
    const vm = wrapper.vm as any;
    await vm.onRevoke('aaaa-1111');
    await flushPromises();
    expect(revokeUrl).toContain('/pats/MyPATs(aaaa-1111)/PatService.revokePAT');
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });
});
