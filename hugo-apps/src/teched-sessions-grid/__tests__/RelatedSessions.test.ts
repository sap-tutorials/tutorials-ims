// @vitest-environment happy-dom
// hugo-apps/src/teched-sessions-grid/__tests__/RelatedSessions.test.ts
//
// Tests for the "Related Devtoberfest sessions" block rendered on TechEd
// session cards (issue #2355 Unit 4).
//
// Covers:
//   - RelatedSessions.vue renders links when sessions are provided
//   - RelatedSessions.vue renders nothing when sessions is empty/absent/null
//   - App.vue integrates: cards with relatedDevtoberfestSessions show the block
//   - App.vue integrates: cards without it show nothing (existing cards unaffected)
//   - filterSessions() haystack includes related Devtoberfest session titles
//   - relatedDevtoberfestSessions survives the enrichment ...s spread in App.vue
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import RelatedSessions from '../RelatedSessions.vue';
import App from '../App.vue';
import { filterSessions } from '../filter';

// ---------------------------------------------------------------------------
// RelatedSessions unit tests (no global mock setup needed)
// ---------------------------------------------------------------------------
describe('RelatedSessions', () => {
  const relatedItems = [
    { sessionId: 'dtf-001', title: 'Devtoberfest: CAP Basics', sessionCode: 'DTF001' },
    { sessionId: 'dtf-002', title: 'Devtoberfest: BTP Setup' },
  ];

  it('renders a heading and links when sessions are provided', () => {
    const wrapper = mount(RelatedSessions, { props: { sessions: relatedItems } });
    expect(wrapper.text()).toContain('Related Devtoberfest Sessions');
    expect(wrapper.text()).toContain('Devtoberfest: CAP Basics');
    expect(wrapper.text()).toContain('Devtoberfest: BTP Setup');
  });

  it('renders links pointing to /devtoberfest/sessions/?session=<sessionId>', () => {
    const wrapper = mount(RelatedSessions, { props: { sessions: relatedItems } });
    const links = wrapper.findAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].attributes('href')).toBe('/devtoberfest/sessions/?session=dtf-001');
    expect(links[1].attributes('href')).toBe('/devtoberfest/sessions/?session=dtf-002');
  });

  it('links open in the same tab (target="_self")', () => {
    const wrapper = mount(RelatedSessions, { props: { sessions: relatedItems } });
    wrapper.findAll('a').forEach((a) => {
      expect(a.attributes('target')).toBe('_self');
    });
  });

  it('shows sessionCode badge when present', () => {
    const wrapper = mount(RelatedSessions, { props: { sessions: relatedItems } });
    expect(wrapper.text()).toContain('DTF001');
    // dtf-002 has no sessionCode — no badge for it
    expect(wrapper.findAll('.tsg-related-code')).toHaveLength(1);
  });

  it('renders nothing when sessions is an empty array', () => {
    const wrapper = mount(RelatedSessions, { props: { sessions: [] } });
    // The outer v-if div must not be present — check via find rather than
    // brittle html() string matching (Vue's comment node serialization may vary).
    expect(wrapper.find('.tsg-related').exists()).toBe(false);
  });

  it('renders nothing when sessions is undefined', () => {
    const wrapper = mount(RelatedSessions, { props: { sessions: undefined } });
    expect(wrapper.find('.tsg-related').exists()).toBe(false);
  });

  it('renders nothing when sessions is null', () => {
    const wrapper = mount(RelatedSessions, { props: { sessions: null } });
    expect(wrapper.find('.tsg-related').exists()).toBe(false);
  });

  it('URL-encodes sessionId in the href', () => {
    const wrapper = mount(RelatedSessions, {
      props: {
        sessions: [{ sessionId: 'dtf/has spaces&special', title: 'Encoded session' }],
      },
    });
    const href = wrapper.find('a').attributes('href');
    expect(href).toBe('/devtoberfest/sessions/?session=dtf%2Fhas%20spaces%26special');
  });

  it('skips the link (no anchor) for items with empty sessionId', () => {
    // The v-if="item.sessionId" guard prevents rendering a broken href.
    const wrapper = mount(RelatedSessions, {
      props: {
        sessions: [{ sessionId: '', title: 'Broken item' }],
      },
    });
    // The li still renders but there should be no <a> inside it
    expect(wrapper.find('.tsg-related').exists()).toBe(true);
    expect(wrapper.find('a').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterSessions haystack tests for relatedDevtoberfestSessions
// ---------------------------------------------------------------------------
describe('filterSessions — related Devtoberfest session title indexing', () => {
  const sessions = [
    {
      slug: 'te-ai',
      title: 'AI in the Cloud',
      venue: 'BERLIN',
      relatedDevtoberfestSessions: [
        { sessionId: 'dtf-42', title: 'Devtoberfest CAP Basics' },
      ],
    },
    {
      slug: 'te-btp',
      title: 'BTP Setup Guide',
      venue: 'VIRTUAL',
      relatedDevtoberfestSessions: [],
    },
  ];

  it('finds a TechEd session by its related Devtoberfest session title', () => {
    const result = filterSessions(sessions, { query: 'cap basics' });
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('te-ai');
  });

  it('returns no results when the query matches neither session nor related titles', () => {
    const result = filterSessions(sessions, { query: 'fiori elements xyz' });
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// App.vue integration tests: related sessions block
// ---------------------------------------------------------------------------

// Feed with one session carrying relatedDevtoberfestSessions, one without
const feedWithRelated = {
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
      url: 'https://www.sap.com/teched/berlin/ai',
      youtubeUrl: '',
      speakers: ['ada-lovelace'],
      relatedDevtoberfestSessions: [
        { sessionId: 'dtf-99', title: 'Devtoberfest Crosslink Session', sessionCode: 'DTF099', sharedConceptCount: 3 },
      ],
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
      url: 'https://www.sap.com/teched/virtual/cap',
      youtubeUrl: 'https://youtu.be/abc',
      speakers: ['grace-hopper'],
      // No relatedDevtoberfestSessions — the flag is OFF for this session
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

describe('App.vue — related Devtoberfest sessions integration', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/teched/');
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(feedWithRelated),
    } as any)) as any;
  });

  afterEach(() => {
    document.getElementById('teched-data')?.remove();
  });

  it('renders the related sessions block for a card that has them', async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).toContain('Related Devtoberfest Sessions');
    expect(wrapper.text()).toContain('Devtoberfest Crosslink Session');
  });

  it('renders a link to /devtoberfest/sessions/?session=<id> for the related item', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const dtfLinks = wrapper.findAll('a[href*="/devtoberfest/sessions/?session="]');
    expect(dtfLinks.length).toBeGreaterThanOrEqual(1);
    expect(dtfLinks[0].attributes('href')).toBe('/devtoberfest/sessions/?session=dtf-99');
  });

  it('does NOT render the related sessions block for cards without relatedDevtoberfestSessions', async () => {
    const wrapper = mount(App);
    await flushPromises();
    // Only one card (AI on BTP) has the block; CAP deep dive does not.
    const headings = wrapper.findAll('.tsg-related-heading');
    expect(headings.length).toBe(1);
  });

  it('renders no related block when the feed carries empty arrays (flag OFF)', async () => {
    const feedFlagOff = {
      ...feedWithRelated,
      sessions: feedWithRelated.sessions.map((s) => ({
        ...s,
        relatedDevtoberfestSessions: [],
      })),
    };
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve(feedFlagOff),
    } as any)) as any;

    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.text()).not.toContain('Related Devtoberfest Sessions');
    expect(wrapper.findAll('a[href*="/devtoberfest/sessions/"]').length).toBe(0);
  });

  it('relatedDevtoberfestSessions survives the session enrichment spread in App.vue', async () => {
    // Regression guard: if the loadData enrichment map ever switches from ...s
    // to explicit field picks, this test fails immediately.
    const wrapper = mount(App);
    await flushPromises();
    // The easiest observable proxy: the related block renders — which means the
    // field was NOT dropped during the speakerNames/trackName enrichment step.
    expect(wrapper.find('.tsg-related').exists()).toBe(true);
  });

  it('keyword search finds a TechEd card via its related Devtoberfest session title', async () => {
    const wrapper = mount(App);
    await flushPromises();
    const search = wrapper.find('input[type="search"]');

    // "Crosslink" is only in the relatedDevtoberfestSessions title, not the
    // session's own title/abstract/speakers/track.
    await search.setValue('crosslink');
    await flushPromises();
    expect(wrapper.text()).toContain('AI on BTP');
    // CAP deep dive has no related sessions and no "crosslink" anywhere
    expect(wrapper.text()).not.toContain('CAP deep dive');
  });
});
