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

  // --- Track color tests ---------------------------------------------------

  it('track badges for different tracks have distinct background colors', async () => {
    const wrapper = mount(App);
    await flushPromises();

    // Find all .tsg-badge--track elements across the unified grid (one per session)
    const trackBadges = wrapper.findAll('.tsg-badge--track');
    expect(trackBadges.length).toBe(2);

    const bg0 = (trackBadges[0].element as HTMLElement).style.background;
    const bg1 = (trackBadges[1].element as HTMLElement).style.background;

    // Both badges must have a non-empty background (inline style applied)
    expect(bg0).toBeTruthy();
    expect(bg1).toBeTruthy();

    // The two different tracks must have distinct background colors
    expect(bg0).not.toBe(bg1);
  });

  it('track badge border color matches the track color from colorMap', async () => {
    const wrapper = mount(App);
    await flushPromises();

    const trackBadges = wrapper.findAll('.tsg-badge--track');
    expect(trackBadges.length).toBeGreaterThan(0);

    // Every track badge must have a non-empty borderColor inline style.
    // .tsg-badge--track now has `border: 1px solid transparent` in CSS so the
    // inline borderColor from trackBadgeStyle() renders visually.
    for (const badge of trackBadges) {
      const el = badge.element as HTMLElement;
      expect(el.style.borderColor).toBeTruthy();
    }

    // The two different tracks must have distinct border colors
    const bc0 = (trackBadges[0].element as HTMLElement).style.borderColor;
    const bc1 = (trackBadges[1].element as HTMLElement).style.borderColor;
    expect(bc0).not.toBe(bc1);
  });

  it('track chips show color dots instead of a separate legend row', async () => {
    const wrapper = mount(App);
    await flushPromises();

    // Separate legend row must be gone entirely
    expect(wrapper.find('.tsg-legend').exists()).toBe(false);

    // Each chip must contain a .tsg-chip-dot
    const chips = wrapper.findAll('.tsg-chip');
    expect(chips.length).toBe(feed.tracks.length);
    for (const chip of chips) {
      expect(chip.find('.tsg-chip-dot').exists()).toBe(true);
    }

    // Number of dots matches number of tracks in the fixture
    const dots = wrapper.findAll('.tsg-chip-dot');
    expect(dots.length).toBe(feed.tracks.length);

    // Dots for distinct tracks have distinct, truthy background colors
    const bg0 = (dots[0].element as HTMLElement).style.background;
    const bg1 = (dots[1].element as HTMLElement).style.background;
    expect(bg0).toBeTruthy();
    expect(bg1).toBeTruthy();
    expect(bg0).not.toBe(bg1);
  });

  // --- Detail panel tests ---------------------------------------------------

  it('clicking a card opens the detail panel with the session title', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const card = wrapper.findAll('article')[0];
    await card.trigger('click');
    await flushPromises();
    // Panel should be present as a dialog with the session title
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[role="dialog"]').text()).toContain('AI on BTP');
  });

  it('closing the panel via the close button dismisses it', async () => {
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.findAll('article')[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    // Click the close button (aria-label="Close")
    const closeBtn = wrapper.find('[aria-label="Close"]');
    await closeBtn.trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('pressing Escape closes the panel', async () => {
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.findAll('article')[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    // Dispatch a keydown Escape on the window
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('clicking the backdrop closes the panel', async () => {
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.findAll('article')[0].trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    // The backdrop is the .detail-panel__backdrop element
    const backdrop = wrapper.find('.detail-panel__backdrop');
    await backdrop.trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('clicking a card updates the URL with ?session=<slug>', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const card = wrapper.findAll('article')[0]; // ai-berlin
    await card.trigger('click');
    await flushPromises();
    expect(window.location.search).toContain('session=ai-berlin');
  });

  it('?session=<slug> deep-link opens the panel on mount', async () => {
    window.history.replaceState({}, '', '/teched/?session=cap-virtual');
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[role="dialog"]').text()).toContain('CAP deep dive');
  });

  it('?session= with unknown slug does not open the panel', async () => {
    window.history.replaceState({}, '', '/teched/?session=no-such-session');
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('Enter key on a card opens the detail panel', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const card = wrapper.findAll('article')[1]; // cap-virtual
    await card.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[role="dialog"]').text()).toContain('CAP deep dive');
  });

  it('Space key on a card opens the detail panel', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const card = wrapper.findAll('article')[0]; // ai-berlin
    await card.trigger('keydown', { key: ' ' });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('[role="dialog"]').text()).toContain('AI on BTP');
  });

  // --- Speaker author-link tests (#2355 unit 8) ----------------------------

  it('renders speaker name as a link when authorLogin is set', async () => {
    const feedWithLogin = {
      ...feed,
      speakers: [
        { slug: 'ada-lovelace', name: 'Ada Lovelace', title: 'Advocate', company: 'SAP', authorLogin: 'ada-lovelace' },
        { slug: 'grace-hopper', name: 'Grace Hopper', title: 'Engineer', company: 'SAP', authorLogin: null },
      ],
    };
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(feedWithLogin),
    } as any)) as any;
    const wrapper = mount(App);
    await flushPromises();
    // Ada has authorLogin → should render as <a>
    const adaLink = wrapper.find('a[href="/authors/ada-lovelace/"]');
    expect(adaLink.exists()).toBe(true);
    expect(adaLink.text()).toBe('Ada Lovelace');
    // Grace has no authorLogin → no <a> with her name as href
    expect(wrapper.find('a[href="/authors/grace-hopper/"]').exists()).toBe(false);
    // Grace's name still appears as plain text
    expect(wrapper.text()).toContain('Grace Hopper');
  });

  it('renders speaker name as plain text when authorLogin is absent', async () => {
    // All speakers without authorLogin → zero author-page links rendered
    const feedNoLogin = {
      ...feed,
      speakers: [
        { slug: 'ada-lovelace', name: 'Ada Lovelace', title: 'Advocate', company: 'SAP' },
      ],
    };
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(feedNoLogin),
    } as any)) as any;
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('a[href="/authors/ada-lovelace/"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Ada Lovelace');
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

