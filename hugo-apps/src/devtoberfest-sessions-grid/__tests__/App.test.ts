// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  activeEditionId: 'e1', editions: [{ id: 'e1', name: '2026', isCurrent: true }],
  sessions: [
    {
      id: 's1', kind: 'session', title: 'With Video', week: '1',
      youtubeUrl: 'https://youtu.be/abc123', communityEventUrl: 'https://community.sap.com/x',
      abstract: 'A deep dive into SAP HANA Cloud modelling.',
      speakers: [{ id: 'sp1', name: 'Ada Lovelace', role: 'Developer Advocate', company: 'SAP', bio: 'Loves RAP.' }],
    },
    {
      id: 's2', kind: 'session', title: 'No Video', week: '1', youtubeUrl: '',
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

beforeEach(() => {
  mockFetch({ authenticated: false });
});

describe('Sessions grid', () => {
  it('renders a card per session with a youtube thumbnail when available', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('With Video');
    expect(wrapper.text()).toContain('No Video');
    const imgs = wrapper.findAll('img').map((i) => i.attributes('src') || '');
    // i.ytimg.com, not img.youtube.com — the latter is CSP-blocked (see completion.ts, commit 307be4e5).
    expect(imgs.some((s) => s.includes('i.ytimg.com/vi/abc123'))).toBe(true);
  });

  it('keyword search filters across title, abstract, speaker and bio', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const search = wrapper.find('input[type="search"]');

    // Abstract-only match (term not in any title).
    await search.setValue('hana cloud');
    await flushPromises();
    expect(wrapper.text()).toContain('With Video');
    expect(wrapper.text()).not.toContain('No Video');

    // Speaker name match.
    await search.setValue('grace hopper');
    await flushPromises();
    expect(wrapper.text()).toContain('No Video');
    expect(wrapper.text()).not.toContain('With Video');

    // Bio match.
    await search.setValue('rap');
    await flushPromises();
    expect(wrapper.text()).toContain('With Video');
    expect(wrapper.text()).not.toContain('No Video');

    // No match → empty state.
    await search.setValue('nonexistent-term');
    await flushPromises();
    expect(wrapper.text()).toContain('No sessions match your filters.');
  });

  it('shows the earned-points score for a joined user, not the Join CTA', async () => {
    mockFetch({ authenticated: true, joined: true, earnedPoints: 500, maxPoints: 800, completedSlugs: [], completedActivityIds: [] });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).not.toContain('Join Devtoberfest to earn points');
    expect(wrapper.text()).toContain('800 pts');
  });

  it('shows the Join CTA for an authenticated user who has not joined', async () => {
    mockFetch({ authenticated: true, joined: false, earnedPoints: 0, maxPoints: 800, completedSlugs: [], completedActivityIds: [] });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('Join Devtoberfest to earn points');
  });
});
