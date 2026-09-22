// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  activeEditionId: 'e1',
  editions: [{ id: 'e1', name: '2026', isCurrent: true }],
  sessions: [
    { id: 's1', kind: 'session', title: 'Intro Session', trackName: 'ABAP', week: '1', scheduledStart: '2026-10-05T14:00:00Z', scheduledTimeZone: 'Europe/Berlin', activityId: 'a1', broadcastingPreference: 'Live' },
    { id: 's2', kind: 'session', title: 'Replay Session', trackName: 'ABAP', week: '1', scheduledStart: '2026-10-06T14:00:00Z', scheduledTimeZone: 'Europe/Berlin', broadcastingPreference: 'PreRecorded' },
  ],
  activities: [{ id: 'a1', kind: 'activity', title: 'Do Intro', trackName: 'ABAP', week: '1', points: 500, taskType: 'TUTORIAL', taskSlug: 'intro' }],
};

beforeEach(() => {
  // #2461 wired deep-linking: App parses window.location.search on mount and
  // writeUrl() calls history.replaceState. jsdom/happy-dom share one window
  // across tests in a file, so a prior test's query string leaks into the next
  // mount's initial filter state. Reset the URL before every test.
  window.history.replaceState({}, '', window.location.pathname);
  global.fetch = vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(String(url).includes('my-completions') ? { authenticated: false } : feed),
    } as any),
  ) as any;
});

describe('Schedule table', () => {
  it('renders both a session row and an activity row', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('Intro Session');
    expect(wrapper.text()).toContain('Do Intro');
    expect(wrapper.text()).toContain('500');
  });

  it('filters by week', async () => {
    const wrapper = mount(App);
    await flushPromises();
    // both rows are week 1 → filtering to a non-existent week hides them
    await wrapper.vm.$nextTick();
    (wrapper.vm as any).filters.week = '9';
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('Intro Session');
  });

  it('renders Live/Prerecorded format badges', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('Live');
    expect(wrapper.text()).toContain('Prerecorded');
  });

  it('filters by format (Live excludes Prerecorded)', async () => {
    const wrapper = mount(App);
    await flushPromises();
    (wrapper.vm as any).filters.format = 'Live';
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Intro Session');
    expect(wrapper.text()).not.toContain('Replay Session');
  });
});
