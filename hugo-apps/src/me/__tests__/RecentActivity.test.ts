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
const EMPTY = () => ({ body: [] });

describe('RecentActivity.vue auth gate', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders the signed-in view when authenticated', async () => {
    const fetchMock = mockFetch({
      '/auth/user': USER_OK,
      '/api/getMyCompletions()': () => ({ body: [{ slug: 'abc', title: 'ABC' }] }),
      '/api/getMyInProgress()': EMPTY,
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
    const fetchMock = mockFetch({ '/auth/user': LOGIN_HTML, '/api/getMyCompletions()': LOGIN_HTML, '/api/getMyInProgress()': LOGIN_HTML });
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
    const fetchMock = mockFetch({ '/auth/user': USER_OK, '/api/getMyCompletions()': LOGIN_HTML, '/api/getMyInProgress()': LOGIN_HTML });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();
    expect(wrapper.text()).toMatch(/not signed in/i);
    expect(wrapper.text()).not.toMatch(/network error|failed to load/i);
  });
});

describe('RecentActivity.vue partial completions (#2146)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders in-progress tutorials in the timeline with progress and an in-progress state', async () => {
    const fetchMock = mockFetch({
      '/auth/user': USER_OK,
      '/api/getMyCompletions()': EMPTY,
      '/api/getMyInProgress()': () => ({ body: [
        { kind: 'tutorial', slug: 'cap-events', title: 'CAP Events', experienceTag: 'intermediate', progressPercent: 57, lastTouchedAt: '2026-05-20T14:30:00Z' },
      ] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();

    const item = wrapper.find('ui5-timeline-item');
    expect(item.exists()).toBe(true);
    expect(item.attributes('name')).toBe('CAP Events');
    expect(item.attributes('subtitle-text')).toMatch(/In progress · 57%/);
    expect(item.attributes('icon')).toBe('play');
    expect(item.attributes('state')).toBe('Information');
  });

  it('merges completed and in-progress items and sorts by activity date desc', async () => {
    const fetchMock = mockFetch({
      '/auth/user': USER_OK,
      '/api/getMyCompletions()': () => ({ body: [
        { kind: 'tutorial', slug: 'done-old', title: 'Done Old', completionDate: '2026-04-01T10:00:00Z' },
      ] }),
      '/api/getMyInProgress()': () => ({ body: [
        { kind: 'tutorial', slug: 'partial-new', title: 'Partial New', progressPercent: 40, lastTouchedAt: '2026-05-20T14:30:00Z' },
      ] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();

    const items = wrapper.findAll('ui5-timeline-item');
    expect(items).toHaveLength(2);
    // partial-new (2026-05-20) is more recent than done-old (2026-04-01)
    expect(items[0].attributes('name')).toBe('Partial New');
    expect(items[1].attributes('name')).toBe('Done Old');
  });

  it('shows the empty state when neither completions nor partials exist', async () => {
    const fetchMock = mockFetch({
      '/auth/user': USER_OK,
      '/api/getMyCompletions()': EMPTY,
      '/api/getMyInProgress()': EMPTY,
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(RecentActivity);
    await flushPromises();
    expect(wrapper.text()).toMatch(/no recent activity/i);
  });
});
