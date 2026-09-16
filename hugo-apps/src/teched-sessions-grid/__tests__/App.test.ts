// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  sessions: [
    {
      slug: 'ai-berlin', title: 'AI on BTP', abstract: 'Generative AI deep dive.',
      venue: 'BERLIN', track: 'ai', sessionCode: 'AI001', room: 'Hall A',
      scheduledStart: '2026-10-20T09:00:00Z', url: 'https://www.sap.com/teched/berlin/ai',
      youtubeUrl: '', speakers: ['ada-lovelace'],
    },
    {
      slug: 'cap-virtual', title: 'CAP deep dive', abstract: 'Node.js services with CDS.',
      venue: 'VIRTUAL', track: 'appdev', sessionCode: 'CAP002', room: '',
      scheduledStart: '2026-10-21T14:00:00Z', url: 'https://www.sap.com/teched/virtual/cap',
      youtubeUrl: 'https://youtu.be/abc', speakers: ['grace-hopper'],
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
  // Reset URL so deep-link state doesn't leak between tests.
  window.history.replaceState({}, '', '/teched/');
  mockFetch();
});

afterEach(() => {
  // Remove any embedded-blob <script> a test planted so the fetch-based tests
  // (which assume no blob) don't accidentally read it.
  document.getElementById('teched-data')?.remove();
});

describe('TechEd sessions grid', () => {
  it('renders a single unified grid with a card per session (no per-venue headings)', async () => {
    const wrapper = mount(App);
    await flushPromises();
    // No separate section headings — one grid only.
    expect(wrapper.text()).not.toContain('TechEd Berlin');
    expect(wrapper.text()).not.toContain('TechEd Virtual');
    // Both session cards are present.
    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).toContain('CAP deep dive');
    // resolved speaker + track names surface on the cards
    expect(wrapper.text()).toContain('Ada Lovelace');
    expect(wrapper.text()).toContain('AI & Machine Learning');
    expect(wrapper.findAll('article').length).toBe(2);
    // venue badges still visible per card
    expect(wrapper.text()).toContain('Berlin');
    expect(wrapper.text()).toContain('Virtual');
  });

  it('venue toggle narrows to a single venue', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const berlinBtn = wrapper.findAll('button').find((b) => b.text() === 'Berlin')!;
    await berlinBtn.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).not.toContain('CAP deep dive');
  });

  it('keyword search filters across title, abstract and speaker', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const search = wrapper.find('input[type="search"]');

    await search.setValue('cds'); // abstract-only match
    await flushPromises();
    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.text()).not.toContain('AI on BTP');

    await search.setValue('ada'); // speaker name match
    await flushPromises();
    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).not.toContain('CAP deep dive');

    await search.setValue('no-such-term'); // empty state
    await flushPromises();
    expect(wrapper.text()).toContain('No sessions match your filters.');
  });

  it('track chip filters to that track and reflects in the URL', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const chip = wrapper.findAll('button').find((b) => b.text() === 'AI & Machine Learning')!;
    await chip.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).not.toContain('CAP deep dive');
    expect(window.location.search).toContain('track=ai');
  });

  it('applies deep-link filters from the URL on load', async () => {
    window.history.replaceState({}, '', '/teched/?venue=VIRTUAL');
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.text()).not.toContain('AI on BTP');
  });

  it('reads the embedded #teched-data blob without fetching', async () => {
    // Bake the blob the way hugo/layouts/teched/list.html does: the WHOLE feed
    // object under id="teched-data". The island must consume it and skip the
    // /build/teched network fallback entirely (the fallback 404 is what
    // produced the "Could not load TechEd sessions: teched 404" bug).
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
    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.findAll('article').length).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows an error state when the feed fails to load', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500 } as any)) as any;
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('Could not load TechEd sessions');
  });
});
