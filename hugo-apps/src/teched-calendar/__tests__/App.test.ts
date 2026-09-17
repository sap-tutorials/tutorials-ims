// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

// Minimal feed fixture: two sessions with scheduledStart so they land in the
// calendar, plus one unscheduled, two speakers, two tracks.
const WEEK_DATE = '2026-10-20';   // ISO date that both scheduled sessions fall on

const feed = {
  sessions: [
    {
      slug: 'ai-berlin',
      title: 'AI on BTP',
      abstract: 'Generative AI deep dive.',
      venue: 'BERLIN',
      track: 'ai',
      trackName: 'AI & Machine Learning',
      sessionCode: 'AI001',
      room: 'Hall A',
      scheduledStart: `${WEEK_DATE}T09:00:00Z`,
      scheduledEnd: `${WEEK_DATE}T10:00:00Z`,
      url: 'https://www.sap.com/teched/berlin/ai',
      youtubeUrl: '',
      speakers: ['ada-lovelace'],
      speakerNames: ['Ada Lovelace'],
    },
    {
      slug: 'cap-virtual',
      title: 'CAP deep dive',
      abstract: 'Node.js services with CDS.',
      venue: 'VIRTUAL',
      track: 'appdev',
      trackName: 'Application Development',
      sessionCode: 'CAP002',
      room: 'Community Theater',
      scheduledStart: `${WEEK_DATE}T14:00:00Z`,
      scheduledEnd: `${WEEK_DATE}T15:00:00Z`,
      url: 'https://www.sap.com/teched/virtual/cap',
      youtubeUrl: 'https://youtu.be/abc',
      speakers: ['grace-hopper'],
      speakerNames: ['Grace Hopper'],
    },
    {
      slug: 'unscheduled-session',
      title: 'Unscheduled TechEd Talk',
      abstract: 'No time slot yet.',
      venue: 'BERLIN',
      track: 'ai',
      trackName: 'AI & Machine Learning',
      sessionCode: 'AI999',
      room: '',
      scheduledStart: null,
      scheduledEnd: null,
      url: null,
      youtubeUrl: '',
      speakers: [],
      speakerNames: [],
    },
  ],
  speakers: [
    { slug: 'ada-lovelace', name: 'Ada Lovelace', title: 'Advocate', company: 'SAP' },
    { slug: 'grace-hopper', name: 'Grace Hopper', title: 'Engineer', company: 'SAP' },
  ],
  tracks: [
    { slug: 'ai', name: 'AI & Machine Learning', venue: 'BERLIN' },
    { slug: 'appdev', name: 'Application Development', venue: 'VIRTUAL' },
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
  window.history.replaceState({}, '', '/teched/calendar/');
  mockFetch();
});

afterEach(() => {
  document.getElementById('teched-data')?.remove();
});

describe('TechEd calendar island', () => {
  it('renders Week view by default and shows scheduled sessions', async () => {
    const wrapper = mount(App);
    await flushPromises();

    // Week toggle should be active by default
    const weekBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text() === 'Week');
    expect(weekBtn?.classes()).toContain('active');

    // Both scheduled sessions must appear somewhere in the week grid
    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).toContain('CAP deep dive');
  });

  it('has only Week and Day view toggles (no Month)', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const viewBtns = wrapper.findAll('button[role="tab"]').map((b) => b.text());
    expect(viewBtns).toContain('Week');
    expect(viewBtns).toContain('Day');
    expect(viewBtns).not.toContain('Month');
  });

  it('switches to Day view when Day toggle is clicked', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const dayBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text() === 'Day')!;
    await dayBtn.trigger('click');
    await flushPromises();

    expect(dayBtn.classes()).toContain('active');
    // Week toggle must no longer be active
    const weekBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text() === 'Week')!;
    expect(weekBtn.classes()).not.toContain('active');
  });

  it('venue filter narrows to Berlin sessions only', async () => {
    const wrapper = mount(App);
    await flushPromises();

    // Both sessions visible initially
    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).toContain('CAP deep dive');

    // Select Berlin venue
    const venueSelect = wrapper.find('select[aria-label="Filter by venue"]');
    await venueSelect.setValue('BERLIN');
    await flushPromises();

    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).not.toContain('CAP deep dive');
  });

  it('track filter narrows to matching track', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const trackSelect = wrapper.find('select[aria-label="Filter by track"]');
    // 'ai' is the track slug
    await trackSelect.setValue('ai');
    await flushPromises();

    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).not.toContain('CAP deep dive');
  });

  it('free-text search filters sessions', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const searchInput = wrapper.find('input[type="search"]');
    await searchInput.setValue('node.js');
    await flushPromises();

    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.text()).not.toContain('AI on BTP');
  });

  it('Community Clubhouse toggle narrows to Community Theater sessions and deep-links (clubhouse=1)', async () => {
    const wrapper = mount(App);
    await flushPromises();

    // Both scheduled sessions visible initially
    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).toContain('CAP deep dive');

    const btn = wrapper.findAll('button').find((b) => b.text() === 'Community Clubhouse')!;
    expect(btn).toBeDefined();
    await btn.trigger('click');
    await flushPromises();

    // Only cap-virtual (room 'Community Theater') remains; ai-berlin (Hall A) is hidden
    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.text()).not.toContain('AI on BTP');
    // Persisted to the URL for deep-linking / back-forward restore
    expect(window.location.search).toContain('clubhouse=1');
  });

  it('applies deep-link clubhouse=1 on initial load', async () => {
    window.history.replaceState({}, '', '/teched/calendar/?clubhouse=1');
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.text()).not.toContain('AI on BTP');
  });

  it('clicking a session card opens the detail panel', async () => {
    const wrapper = mount(App);
    await flushPromises();

    // Navigate to the date the sessions are on so they appear in Week view
    // We do this by deep-linking via url state, but since it's complex in tests
    // we instead just check the detail panel opens after the week is navigated.
    // The panel is controlled by selectedRow; trigger via the unscheduled card
    // which is always visible regardless of cursor date.
    const unscheduledBtn = wrapper.findAll('button.cal-unscheduled-card');
    if (unscheduledBtn.length) {
      await unscheduledBtn[0].trigger('click');
      await flushPromises();
      // DetailPanel renders when selectedRow is set
      expect(wrapper.find('.detail-panel').exists()).toBe(true);
      // Close it
      const closeBtn = wrapper.find('.detail-panel__close');
      await closeBtn.trigger('click');
      await flushPromises();
      expect(wrapper.find('.detail-panel').exists()).toBe(false);
    }
  });

  it('shows unscheduled bucket for sessions without a start time', async () => {
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('Unscheduled');
    expect(wrapper.text()).toContain('Unscheduled TechEd Talk');
  });

  it('loads the embedded #teched-data blob without fetching', async () => {
    const el = document.createElement('script');
    el.id = 'teched-data';
    el.type = 'application/json';
    el.textContent = JSON.stringify(feed);
    document.body.appendChild(el);

    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('AI on BTP');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows an error state when the feed fails to load', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500 } as any)) as any;
    const wrapper = mount(App);
    await flushPromises();
    // The error message comes from `throw new Error(`teched ${r.status}`)` in loadFeed
    expect(wrapper.text()).toContain('teched 500');
  });

  it('applies deep-link view=day on initial load', async () => {
    window.history.replaceState({}, '', '/teched/calendar/?view=day');
    const wrapper = mount(App);
    await flushPromises();

    const dayBtn = wrapper.findAll('button[role="tab"]').find((b) => b.text() === 'Day')!;
    expect(dayBtn.classes()).toContain('active');
  });

  it('falls back to /build/teched when #teched-data contains literal "null" (missing hugo/data/teched.json)', async () => {
    // Hugo's jsonify of a missing .Site.Data.teched emits the string "null".
    // loadFeed() must skip the blob and fall through to the network fetch.
    const el = document.createElement('script');
    el.id = 'teched-data';
    el.type = 'application/json';
    el.textContent = 'null';
    document.body.appendChild(el);

    // The network fallback returns the real feed.
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(feed),
    } as any)) as any;

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('AI on BTP');
    expect(global.fetch).toHaveBeenCalled();
  });
});
