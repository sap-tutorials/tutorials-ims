// @vitest-environment happy-dom
//
// Integration tests for the sessions-grid deep-linking (issue #2030): the URL
// is the source of truth on mount, and user interactions are written back to
// the query string via history.replaceState.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  activeEditionId: 'e1', editions: [{ id: 'e1', name: '2026', isCurrent: true }],
  sessions: [
    {
      id: 's1', kind: 'session', title: 'With Video', week: '1', trackName: 'Cloud & AI',
      youtubeUrl: 'https://youtu.be/abc123',
      abstract: 'A deep dive into SAP HANA Cloud modelling.',
      speakers: [{ id: 'sp1', name: 'Ada Lovelace', role: 'Developer Advocate', company: 'SAP', bio: 'Loves RAP.' }],
    },
    {
      id: 's2', kind: 'session', title: 'No Video', week: '2', trackName: 'DevOps', youtubeUrl: '',
      abstract: 'All about Kubernetes and Kyma.',
      speakers: [{ id: 'sp2', name: 'Grace Hopper', role: 'Engineer', company: 'Contoso', bio: 'Compiler pioneer.' }],
    },
  ],
  activities: [],
};

function mockFetch(my: any) {
  global.fetch = vi.fn((url: string) => Promise.resolve({
    ok: true,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(String(url).includes('my-completions') ? my : feed),
  } as any)) as any;
}

function setUrl(search: string) {
  window.history.replaceState({}, '', `/devtoberfest/sessions/${search}`);
}

beforeEach(() => {
  mockFetch({ authenticated: false });
  setUrl('');
});

describe('Sessions grid deep-linking', () => {
  it('restores the search + week + track filters from the URL on mount', async () => {
    setUrl('?q=hana%20cloud&week=1&track=Cloud%20%26%20AI');
    const wrapper = mount(App);
    await flushPromises();

    expect((wrapper.find('input[type="search"]').element as HTMLInputElement).value).toBe('hana cloud');
    expect(wrapper.text()).toContain('With Video');
    expect(wrapper.text()).not.toContain('No Video');
  });

  it('opens a session detail panel from ?session=<id> and canonicalises it into the URL', async () => {
    setUrl('?session=s2');
    const wrapper = mount(App);
    await flushPromises();

    // writeUrl() on mount reflects the applied session back into the query string.
    expect(window.location.search).toContain('session=s2');
    // The detail panel for s2 is open.
    expect(wrapper.text()).toContain('No Video');
  });

  it('writes filter changes back to the URL query string', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(window.location.search).toBe(''); // clean default URL

    await wrapper.find('input[type="search"]').setValue('kyma');
    await flushPromises();
    expect(new URLSearchParams(window.location.search).get('q')).toBe('kyma');

    // Clearing filters returns to a clean URL.
    await wrapper.find('input[type="search"]').setValue('');
    await flushPromises();
    expect(window.location.search).toBe('');
  });

  it('ignores an unknown ?session id (fail-open, no panel, clean URL)', async () => {
    setUrl('?session=does-not-exist');
    const wrapper = mount(App);
    await flushPromises();
    expect(window.location.search).toBe('');
    expect(wrapper.text()).toContain('With Video'); // grid still renders
  });
});
