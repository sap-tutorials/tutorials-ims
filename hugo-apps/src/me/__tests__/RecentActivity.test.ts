// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import RecentActivity from '../RecentActivity.vue';

// Keyed fetch mock. A route result may set `contentType` (defaults to JSON) so a
// test can simulate the approuter's 200 + HTML login-redirect page for a lapsed
// session — the exact case the resp.ok-only gate mishandled.
function mockFetch(routes: Record<string, () => Promise<any>>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method || 'GET'} ${url}`;
    const handler = routes[key] ?? routes[url];
    if (!handler) throw new Error(`unmocked: ${key}`);
    const result = await handler();
    const contentType = result.contentType ?? 'application/json';
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => result.body,
    };
  });
}

const USER_OK = () => ({ body: { authenticated: true, name: 'Tom' } });
const LOGIN_HTML = () => ({ ok: true, status: 200, contentType: 'text/html', body: undefined });

describe('RecentActivity.vue auth gate', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders the signed-in view when authenticated', async () => {
    const fetchMock = mockFetch({
      '/auth/user': USER_OK,
      '/api/getMyCompletions()': () => ({ body: [{ slug: 'abc', title: 'ABC' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();
    expect(wrapper.text()).not.toMatch(/not signed in/i);
    expect(wrapper.text()).not.toMatch(/network error|failed to load/i);
  });

  it('shows the sign-in prompt on 401', async () => {
    const fetchMock = mockFetch({ '/auth/user': () => ({ ok: false, status: 401, body: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();
    expect(wrapper.text()).toMatch(/not signed in/i);
  });

  // Regression: lapsed session → 200 + HTML login page. Must show sign-in, not
  // fall through to a data fetch and surface an error.
  it('shows the sign-in prompt when /auth/user returns 200 + HTML', async () => {
    const fetchMock = mockFetch({ '/auth/user': LOGIN_HTML, '/api/getMyCompletions()': LOGIN_HTML });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();
    expect(wrapper.text()).toMatch(/not signed in/i);
    expect(wrapper.text()).not.toMatch(/network error|failed to load/i);
  });

  it('shows the sign-in prompt when /auth/user reports authenticated:false', async () => {
    const fetchMock = mockFetch({ '/auth/user': () => ({ body: { authenticated: false } }) });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();
    expect(wrapper.text()).toMatch(/not signed in/i);
  });

  // Regression: session lapses after the gate; the data endpoint returns
  // 200 + HTML. Fall back to the sign-in prompt, not a data error.
  it('shows the sign-in prompt when the data fetch returns 200 + HTML', async () => {
    const fetchMock = mockFetch({ '/auth/user': USER_OK, '/api/getMyCompletions()': LOGIN_HTML });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();
    expect(wrapper.text()).toMatch(/not signed in/i);
    expect(wrapper.text()).not.toMatch(/network error|failed to load/i);
  });
});
