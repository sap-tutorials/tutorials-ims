// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-expanded-panel.test.ts
//
// Task 12 of KG widget redesign (#850): ExpandedPanel.vue is the Joule-style
// right-side dialog opened from the SidebarPanel's ⤢ button. Teleports to
// #kg-expanded-root, fetches /graph/neighborhoodFull(slug='...') lazily on
// mount (unless a `data` prop is supplied — the test path), renders per-type
// <details> sections priority-ordered, and emits full telemetry.
import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ExpandedPanel from '../../../hugo-apps/src/related-graph/ExpandedPanel.vue';

const CONFIG_ENTRIES = [
  { type: 'learning-journey', icon: '🎓', singular: 'Learning journey', plural: 'Learning journeys', priority: 10, metaTemplate: 'Level · Duration' },
  { type: 'blog-post', icon: '📝', singular: 'Blog post', plural: 'Blog posts', priority: 20, metaTemplate: 'Author · Date' },
  { type: 'video', icon: '▶️', singular: 'Video', plural: 'Videos', priority: 40, metaTemplate: 'Channel · Date' },
];

function makeFullData(overrides: Record<string, any> = {}) {
  return {
    tutorial: { slug: 'test-slug', title: 'Test Tutorial Title' },
    graphVersion: 'v1',
    prerequisitesOf: [{ slug: 'p1', title: 'Prereq 1', weight: 1, reason: null }],
    sharedConcepts: [{ slug: 's1', title: 'Shared 1', weight: 1, reason: null }],
    whatToLearnNext: [{ slug: 'n1', title: 'Next 1', weight: 1, reason: null }],
    otherResourcesByType: [
      { type: 'learning-journey', config: CONFIG_ENTRIES[0], items: [
        { type: 'learning-journey', slug: 'j1', title: 'Journey 1', url: 'https://ex.com/j1', overlapCount: 3, metaText: ' · Advanced · 12h' },
      ]},
      { type: 'blog-post', config: CONFIG_ENTRIES[1], items: [
        { type: 'blog-post', slug: 'b1', title: 'Blog 1', url: 'https://ex.com/b1', overlapCount: 2, metaText: ' · by Alice · Jun 3, 2026' },
        { type: 'blog-post', slug: 'b2', title: 'Blog 2', url: 'https://ex.com/b2', overlapCount: 1, metaText: ' · by Bob · Jun 4, 2026' },
      ]},
      { type: 'video', config: CONFIG_ENTRIES[2], items: [
        { type: 'video', slug: 'v1', title: 'Video 1', url: 'https://ex.com/v1', overlapCount: 4, metaText: ' · by Channel · Jun 5, 2026' },
      ]},
    ],
    typeConfig: CONFIG_ENTRIES,
    ...overrides,
  };
}

let teleportTarget: HTMLDivElement;

beforeEach(() => {
  teleportTarget = document.createElement('div');
  teleportTarget.id = 'kg-expanded-root';
  document.body.appendChild(teleportTarget);
});

afterEach(() => {
  if (teleportTarget.parentNode) {
    document.body.removeChild(teleportTarget);
  }
  vi.restoreAllMocks();
});

describe('ExpandedPanel — dialog chrome', () => {
  it('renders role="dialog" with aria-modal="false"', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'Test Tutorial Title', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const dlg = teleportTarget.querySelector('[role="dialog"]');
    expect(dlg).toBeTruthy();
    expect(dlg!.getAttribute('aria-modal')).toBe('false');
    w.unmount();
  });

  it('header includes "Related learning — deep dive" and the tutorial title', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'Test Tutorial Title', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    expect(teleportTarget.textContent).toContain('Related learning — deep dive');
    expect(teleportTarget.textContent).toContain('Test Tutorial Title');
    w.unmount();
  });

  it('data-wide toggles on widen button click', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const dlg = teleportTarget.querySelector('[role="dialog"]') as HTMLElement;
    expect(dlg.dataset.wide).toBe('false');
    const widen = teleportTarget.querySelector('.kg-expanded__widen') as HTMLElement;
    widen.click();
    await flushPromises();
    expect(dlg.dataset.wide).toBe('true');
    widen.click();
    await flushPromises();
    expect(dlg.dataset.wide).toBe('false');
    w.unmount();
  });

  it('emits close when the ✕ button is clicked', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const closeBtn = teleportTarget.querySelector('.kg-expanded__close') as HTMLElement;
    closeBtn.click();
    expect(w.emitted('close')).toBeTruthy();
    w.unmount();
  });
});

describe('ExpandedPanel — content sections', () => {
  it('renders Prerequisites section first', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const headings = Array.from(teleportTarget.querySelectorAll('h3, h4, summary')).map(h => h.textContent?.trim());
    const firstSection = headings.find(h => h && !h.startsWith('Related learning'));
    expect(firstSection).toMatch(/Prerequisites/i);
    w.unmount();
  });

  it('per-type sections render in config.priority ascending order', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const summaries = Array.from(teleportTarget.querySelectorAll('details summary'))
      .map(s => s.textContent?.trim() ?? '');
    expect(summaries[0]).toContain('Learning journeys');
    expect(summaries[1]).toContain('Blog posts');
    expect(summaries[2]).toContain('Videos');
    w.unmount();
  });

  it('empty otherResourcesByType shows the subdued no-external-resources line', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData({ otherResourcesByType: [] }) },
      attachTo: document.body,
    });
    await flushPromises();
    expect(teleportTarget.textContent).toMatch(/No external resources are linked/i);
    w.unmount();
  });

  it('section headers include icon, plural, and count', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const summaries = Array.from(teleportTarget.querySelectorAll('details summary'))
      .map(s => s.textContent?.trim() ?? '');
    expect(summaries.find(s => s.includes('Blog posts'))).toMatch(/📝.*Blog posts.*2/);
    w.unmount();
  });

  it('each <details> starts open', async () => {
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const detailsEls = teleportTarget.querySelectorAll('details');
    for (const d of detailsEls) {
      expect(d.hasAttribute('open')).toBe(true);
    }
    w.unmount();
  });
});

describe('ExpandedPanel — loading + error states', () => {
  it('shows fetching skeleton when data prop is undefined and fetch not yet resolved', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(() => new Promise(() => {}) as any);
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T' },
      attachTo: document.body,
    });
    await flushPromises();
    expect(teleportTarget.querySelector('.kg-expanded__skeleton')).toBeTruthy();
    w.unmount();
  });

  it('shows retry message on fetch error', async () => {
    vi.spyOn(window, 'fetch').mockRejectedValue(new Error('network'));
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T' },
      attachTo: document.body,
    });
    await flushPromises();
    await flushPromises();
    expect(teleportTarget.textContent).toMatch(/Couldn't load/i);
    w.unmount();
  });
});

describe('ExpandedPanel — telemetry', () => {
  it('emits kg.expanded.opened on mount with data', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const openEvents = dispatch.mock.calls
      .map(c => c[0])
      .filter(e => e instanceof CustomEvent && e.type === 'kg.expanded.opened');
    expect(openEvents.length).toBeGreaterThan(0);
    expect((openEvents[0] as CustomEvent).detail).toEqual(expect.objectContaining({ slug: 'test-slug' }));
    w.unmount();
  });

  it('emits kg.expanded.closed with dwellMs on close click', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    await new Promise((r) => setTimeout(r, 20));
    const closeBtn = teleportTarget.querySelector('.kg-expanded__close') as HTMLElement;
    closeBtn.click();
    await flushPromises();
    const closeEvents = dispatch.mock.calls
      .map(c => c[0])
      .filter(e => e instanceof CustomEvent && e.type === 'kg.expanded.closed');
    expect(closeEvents.length).toBeGreaterThan(0);
    const detail = (closeEvents[0] as CustomEvent).detail as any;
    expect(detail.slug).toBe('test-slug');
    expect(detail.dwellMs).toBeGreaterThan(0);
    w.unmount();
  });

  it('emits kg.expanded.widened with wider:true then wider:false', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const widen = teleportTarget.querySelector('.kg-expanded__widen') as HTMLElement;
    widen.click();
    widen.click();
    await flushPromises();
    const widenEvents = dispatch.mock.calls
      .map(c => c[0])
      .filter(e => e instanceof CustomEvent && e.type === 'kg.expanded.widened');
    expect(widenEvents.length).toBe(2);
    expect((widenEvents[0] as CustomEvent).detail).toEqual(expect.objectContaining({ slug: 'test-slug', wider: true }));
    expect((widenEvents[1] as CustomEvent).detail).toEqual(expect.objectContaining({ slug: 'test-slug', wider: false }));
    w.unmount();
  });

  it('emits kg.expanded.click on row link click', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const link = teleportTarget.querySelector('.kg-resource-row__link') as HTMLElement;
    expect(link).toBeTruthy();
    link.click();
    await flushPromises();
    const clickEvents = dispatch.mock.calls
      .map(c => c[0])
      .filter(e => e instanceof CustomEvent && e.type === 'kg.expanded.click');
    expect(clickEvents.length).toBeGreaterThan(0);
    const detail = (clickEvents[0] as CustomEvent).detail as any;
    expect(detail).toEqual(expect.objectContaining({
      slug: 'test-slug',
      source: 'expanded',
    }));
    expect(typeof detail.resourceType).toBe('string');
    expect(typeof detail.targetSlug).toBe('string');
    w.unmount();
  });

  it('emits kg.expanded.section_toggled on <details> toggle', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const w = mount(ExpandedPanel, {
      props: { slug: 'test-slug', tutorialTitle: 'T', data: makeFullData() },
      attachTo: document.body,
    });
    await flushPromises();
    const details = teleportTarget.querySelector('details') as HTMLDetailsElement;
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    await flushPromises();
    const toggleEvents = dispatch.mock.calls
      .map(c => c[0])
      .filter(e => e instanceof CustomEvent && e.type === 'kg.expanded.section_toggled');
    expect(toggleEvents.length).toBeGreaterThan(0);
    const detail = (toggleEvents[0] as CustomEvent).detail as any;
    expect(detail.slug).toBe('test-slug');
    expect(typeof detail.resourceType).toBe('string');
    expect(typeof detail.open).toBe('boolean');
    w.unmount();
  });
});
