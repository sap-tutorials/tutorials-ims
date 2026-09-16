// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import App from '../App.vue';

const feed = {
  sessions: [
    {
      slug: 'ai-berlin',
      title: 'AI on BTP',
      abstract: 'Generative AI deep dive.',
      venue: 'BERLIN',
      track: 'ai',
      sessionCode: 'AI001',
      room: 'Hall A',
      scheduledStart: '2026-10-20T09:00:00Z',
      scheduledEnd: '2026-10-20T10:00:00Z',
      url: 'https://www.sap.com/teched/berlin/ai',
      youtubeUrl: '',
      speakers: ['ada-lovelace'],
    },
    {
      slug: 'cap-virtual',
      title: 'CAP deep dive',
      abstract: 'Node.js services with CDS.',
      venue: 'VIRTUAL',
      track: 'appdev',
      sessionCode: 'CAP002',
      room: '',
      scheduledStart: '2026-10-21T14:00:00Z',
      scheduledEnd: null,
      url: 'https://www.sap.com/teched/virtual/cap',
      youtubeUrl: 'https://youtu.be/abc',
      speakers: ['grace-hopper'],
    },
    {
      slug: 'hana-berlin',
      title: 'HANA Cloud Tutorial',
      abstract: 'Building with HANA Cloud.',
      venue: 'BERLIN',
      track: 'data',
      sessionCode: 'HANA003',
      room: 'Hall B',
      scheduledStart: '2026-10-22T11:00:00Z',
      scheduledEnd: '2026-10-22T12:00:00Z',
      url: 'https://www.sap.com/teched/berlin/hana',
      youtubeUrl: '',
      speakers: ['ada-lovelace'],
    },
  ],
  speakers: [
    { slug: 'ada-lovelace', name: 'Ada Lovelace', title: 'Advocate', company: 'SAP' },
    { slug: 'grace-hopper', name: 'Grace Hopper', title: 'Engineer', company: 'SAP' },
  ],
  tracks: [
    { slug: 'ai', name: 'AI & Machine Learning', venue: 'BERLIN' },
    { slug: 'appdev', name: 'Application Development', venue: 'VIRTUAL' },
    { slug: 'data', name: 'Data & Analytics', venue: 'BERLIN' },
  ],
};

function mockFetch() {
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(feed),
    } as any),
  ) as any;
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  document.getElementById('teched-data')?.remove();
});

describe('TechEd schedule table', () => {
  it('renders a table with rows for each session', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const rows = wrapper.findAll('tbody tr');
    expect(rows.length).toBe(3);
    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.text()).toContain('HANA Cloud Tutorial');
  });

  it('renders expected column headers', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const headerText = wrapper.find('thead').text();
    expect(headerText).toContain('Venue');
    expect(headerText).toContain('Title');
    expect(headerText).toContain('Track');
    expect(headerText).toContain('When');
    expect(headerText).toContain('Room');
    expect(headerText).toContain('Links');
  });

  it('renders resolved track names in rows', async () => {
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('AI & Machine Learning');
    expect(wrapper.text()).toContain('Application Development');
  });

  it('sorts rows ascending/descending by clicking Title header', async () => {
    const wrapper = mount(App);
    await flushPromises();

    // Default sort is by scheduledStart asc; click Title to sort by title
    const titleBtn = wrapper.findAll('thead button').find((b) => b.text().includes('Title'))!;
    await titleBtn.trigger('click');
    await flushPromises();

    const rows = wrapper.findAll('tbody tr');
    const titles = rows.map((r) => r.find('td:nth-child(2)').text());
    const sorted = [...titles].sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(sorted);

    // Click again to reverse
    await titleBtn.trigger('click');
    await flushPromises();
    const rowsDesc = wrapper.findAll('tbody tr');
    const titlesDesc = rowsDesc.map((r) => r.find('td:nth-child(2)').text());
    expect(titlesDesc[0]).toBe(sorted[sorted.length - 1]);
  });

  it('venue toggle filters to Berlin only', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const berlinBtn = wrapper.findAll('button').find((b) => b.text() === 'Berlin')!;
    await berlinBtn.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).toContain('HANA Cloud Tutorial');
    expect(wrapper.text()).not.toContain('CAP deep dive');
  });

  it('venue toggle filters to Virtual only', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const virtualBtn = wrapper.findAll('button').find((b) => b.text() === 'Virtual')!;
    await virtualBtn.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.text()).not.toContain('AI on BTP');
    expect(wrapper.text()).not.toContain('HANA Cloud Tutorial');
  });

  it('free-text search filters rows by title', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const search = wrapper.find('input[type="search"]');
    await search.setValue('hana');
    await flushPromises();

    expect(wrapper.text()).toContain('HANA Cloud Tutorial');
    expect(wrapper.text()).not.toContain('AI on BTP');
    expect(wrapper.text()).not.toContain('CAP deep dive');
  });

  it('free-text search filters rows by abstract', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const search = wrapper.find('input[type="search"]');
    await search.setValue('cds');
    await flushPromises();

    expect(wrapper.text()).toContain('CAP deep dive');
    expect(wrapper.text()).not.toContain('AI on BTP');
  });

  it('track dropdown filter narrows results', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const trackSelect = wrapper.find('select[aria-label="Filter by track"]');
    await trackSelect.setValue('ai');
    await flushPromises();

    expect(wrapper.text()).toContain('AI on BTP');
    expect(wrapper.text()).not.toContain('CAP deep dive');
    expect(wrapper.text()).not.toContain('HANA Cloud Tutorial');
  });

  it('Clear button appears when filters are active and resets them', async () => {
    const wrapper = mount(App);
    await flushPromises();

    // No clear button initially
    const clearBefore = wrapper.findAll('button').find((b) => b.text() === 'Clear');
    expect(clearBefore).toBeUndefined();

    const search = wrapper.find('input[type="search"]');
    await search.setValue('ai');
    await flushPromises();

    const clearBtn = wrapper.findAll('button').find((b) => b.text() === 'Clear');
    expect(clearBtn).toBeDefined();

    await clearBtn!.trigger('click');
    await flushPromises();

    expect(wrapper.findAll('tbody tr').length).toBe(3);
  });

  it('row click opens DetailPanel with the session title', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const firstRow = wrapper.find('tbody tr');
    await firstRow.trigger('click');
    await flushPromises();

    // DetailPanel renders with the title
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
  });

  it('row Enter keydown opens DetailPanel', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const firstRow = wrapper.find('tbody tr');
    await firstRow.trigger('keydown.enter');
    await flushPromises();

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
  });

  it('reads the embedded #teched-data blob without fetching', async () => {
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
    expect(wrapper.findAll('tbody tr').length).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows an error state when the feed fails to load', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500 } as any),
    ) as any;

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('Could not load TechEd schedule');
  });

  it('shows loading state before data arrives', () => {
    // Don't flush — check intermediate loading state
    const wrapper = mount(App);
    expect(wrapper.text()).toContain('Loading TechEd schedule');
  });

  it('shows empty state when no sessions match filters', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const search = wrapper.find('input[type="search"]');
    await search.setValue('zzz-no-match-xyz');
    await flushPromises();

    expect(wrapper.text()).toContain('No sessions match your filters.');
    expect(wrapper.find('table').exists()).toBe(false);
  });

  it('displays session count in the toolbar', async () => {
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('3 of 3');
  });

  it('falls back to /build/teched when #teched-data contains literal "null" (missing hugo/data/teched.json)', async () => {
    // Hugo's jsonify of a nil .Site.Data.teched emits the string "null" — truthy
    // and non-empty, but JSON.parse("null") returns null. loadFeed() must skip the
    // blob and fall through to the network fetch (mocked in beforeEach to return feed).
    const el = document.createElement('script');
    el.id = 'teched-data';
    el.type = 'application/json';
    el.textContent = 'null';
    document.body.appendChild(el);

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('AI on BTP');
    expect(global.fetch).toHaveBeenCalled();
  });
});
