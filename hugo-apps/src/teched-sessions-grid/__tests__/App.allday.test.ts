// @vitest-environment happy-dom
//
// All-day activities section (issue #2392 item 6). Proves the island renders
// all-day activities (e.g. the Developer Garage) in a distinct "All-day
// activities" section, separate from the timed sessions grid, and that filters
// still apply across both.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  sessions: [
    {
      slug: 'ai-berlin', title: 'AI on BTP', abstract: 'Generative AI deep dive.',
      venue: 'BERLIN', allDay: false, track: 'ai', sessionCode: 'AI001', room: 'Hall A',
      scheduledStart: '2026-10-20T09:00:00Z', url: 'https://www.sap.com/teched/berlin/ai',
      youtubeUrl: '', speakers: ['ada-lovelace'],
    },
    {
      slug: 'developer-garage', title: 'Developer Garage', abstract: 'Hands-on hardware and robotics all day.',
      venue: 'BERLIN', allDay: true, track: 'dc', sessionCode: 'allday-garage', room: 'Garage Ground Floor',
      scheduledStart: null, url: 'https://www.sap.com/teched/berlin/garage',
      youtubeUrl: '', speakers: [],
    },
  ],
  speakers: [
    { slug: 'ada-lovelace', name: 'Ada Lovelace', title: 'Advocate', company: 'SAP' },
  ],
  tracks: [
    { slug: 'ai', name: 'AI & Machine Learning', venue: 'BERLIN' },
    { slug: 'dc', name: 'Developer community', venue: 'BERLIN' },
  ],
};

function mockFetch() {
  global.fetch = vi.fn(() => Promise.resolve({
    ok: true,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(feed),
  } as any)) as any;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/teched/');
  mockFetch();
});

afterEach(() => {
  document.getElementById('teched-data')?.remove();
});

describe('TechEd all-day activities', () => {
  it('renders an "All-day activities" section listing the all-day items', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const allDaySection = wrapper.find('section[aria-label="All-day activities"]');
    expect(allDaySection.exists()).toBe(true);
    expect(allDaySection.text()).toContain('Developer Garage');
    // the timed session is NOT inside the all-day section
    expect(allDaySection.text()).not.toContain('AI on BTP');
  });

  it('excludes all-day items from the timed sessions grid', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const timedSection = wrapper.find('section[aria-label="TechEd Sessions"]');
    expect(timedSection.exists()).toBe(true);
    expect(timedSection.text()).toContain('AI on BTP');
    // the all-day activity is NOT in the timed grid
    expect(timedSection.text()).not.toContain('Developer Garage');
  });

  it('shows an "All-day" badge on all-day cards', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const badge = wrapper.find('.tsg-badge--allday');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toBe('All-day');
  });

  it('still counts all-day activities in the total and opens their detail panel', async () => {
    const wrapper = mount(App);
    await flushPromises();
    // 2 total sessions across both sections
    expect(wrapper.text()).toContain('2 sessions');
    const allDaySection = wrapper.find('section[aria-label="All-day activities"]');
    await allDaySection.find('article').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
  });

  it('filters apply across both sections (search narrows to the all-day activity)', async () => {
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('input[type="search"]').setValue('robotics'); // all-day abstract match
    await flushPromises();
    expect(wrapper.text()).toContain('Developer Garage');
    expect(wrapper.text()).not.toContain('AI on BTP');
    // the timed grid section is gone (no timed matches), all-day section remains
    expect(wrapper.find('section[aria-label="All-day activities"]').exists()).toBe(true);
    expect(wrapper.find('section[aria-label="TechEd Sessions"]').exists()).toBe(false);
  });
});
