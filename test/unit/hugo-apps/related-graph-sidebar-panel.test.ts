// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-sidebar-panel.test.ts
//
// Task 11 of KG widget redesign (#850): SidebarPanel.vue is extracted from
// RelatedGraph.vue. Redesign changes: drop the "teaches" section, reorder
// to Prereq → Other → Shared → Next, and render Other-resources rows via
// <ResourceRow> (Task 10) using server-supplied typeConfig + metaText.
import { mount } from '@vue/test-utils';
import { describe, it, expect } from 'vitest';
import SidebarPanel from '../../../hugo-apps/src/related-graph/SidebarPanel.vue';

const configEntries = [
  { type: 'learning-journey', icon: '🎓', singular: 'Learning journey', plural: 'Learning journeys', priority: 10, metaTemplate: 'Level · Duration' },
  { type: 'blog-post', icon: '📝', singular: 'Blog post', plural: 'Blog posts', priority: 20, metaTemplate: 'Author · Date' },
  { type: 'discovery-mission', icon: '🔍', singular: 'Discovery mission', plural: 'Discovery missions', priority: 30, metaTemplate: 'Effort · Category' },
  { type: 'video', icon: '▶️', singular: 'Video', plural: 'Videos', priority: 40, metaTemplate: 'Channel · Date' },
  { type: 'api-doc', icon: '📖', singular: 'API reference', plural: 'API references', priority: 50, metaTemplate: 'Official reference · Category' },
  { type: 'sample', icon: '🧪', singular: 'Sample', plural: 'Samples', priority: 60, metaTemplate: 'Language · Stars · Last commit month' },
];

function makeData(overrides: Record<string, any> = {}) {
  return {
    tutorial: { slug: 't', title: 'Tutorial title' },
    graphVersion: 'v1',
    // Even though the wire may still ship `teaches`, the sidebar must not render it.
    teaches: [{ slug: 'c1', name: 'Concept 1', description: null, published: false }],
    prerequisitesOf: [{ slug: 'p1', title: 'Prereq 1', weight: 1, reason: 'because' }],
    sharedConcepts: [{ slug: 's1', title: 'Shared 1', weight: 1, reason: 'because' }],
    whatToLearnNext: [{ slug: 'n1', title: 'Next 1', weight: 1, reason: 'because' }],
    otherResources: [
      { type: 'blog-post', slug: 'b1', title: 'Blog 1', url: 'https://ex.com/b1',
        authorName: 'Alice', postedAt: '2026-06-03T12:00:00Z',
        overlapCount: 3, metaText: ' · by Alice · Jun 3, 2026' },
    ],
    typeConfig: configEntries,
    ...overrides,
  };
}

describe('SidebarPanel', () => {
  it('renders four sections in exact order: Prereq → Other → Shared → Next', () => {
    const w = mount(SidebarPanel, { props: { data: makeData() } });
    const headings = w.findAll('h3').map(h => h.text());
    expect(headings).toEqual([
      'Prerequisites you might want first',
      'Other resources',
      'Tutorials covering related concepts',
      'What to learn next',
    ]);
  });

  it('does NOT render a "teaches" section even if the wire carries teaches: [...]', () => {
    const w = mount(SidebarPanel, { props: { data: makeData() } });
    const text = w.text();
    expect(text).not.toMatch(/This tutorial teaches/i);
    // No <h3> should have anything about "teaches".
    const headings = w.findAll('h3').map(h => h.text().toLowerCase());
    for (const h of headings) {
      expect(h).not.toContain('teaches');
    }
  });

  it('renders one ResourceRow per otherResources entry', () => {
    const data = makeData({
      otherResources: [
        { type: 'blog-post', slug: 'b1', title: 'Blog 1', url: 'https://ex.com/b1', overlapCount: 3, metaText: ' · A' },
        { type: 'video', slug: 'v1', title: 'Video 1', url: 'https://ex.com/v1', overlapCount: 2, metaText: ' · B' },
      ],
    });
    const w = mount(SidebarPanel, { props: { data } });
    // ResourceRow renders <li class="kg-resource-row">
    const rows = w.findAll('li.kg-resource-row');
    expect(rows.length).toBe(2);
  });

  it('empty section is hidden entirely (no heading, no ul)', () => {
    const data = makeData({ sharedConcepts: [], whatToLearnNext: [] });
    const w = mount(SidebarPanel, { props: { data } });
    const headings = w.findAll('h3').map(h => h.text());
    expect(headings).not.toContain('Tutorials covering related concepts');
    expect(headings).not.toContain('What to learn next');
  });

  it('renders the sidebar header with kg-sidebar aside class', () => {
    const w = mount(SidebarPanel, { props: { data: makeData() } });
    const aside = w.find('aside.kg-sidebar');
    expect(aside.exists()).toBe(true);
  });

  it('emits open-expanded when the ⤢ button is clicked', () => {
    const w = mount(SidebarPanel, { props: { data: makeData() } });
    const btn = w.find('.kg-sidebar__expand-btn');
    expect(btn.exists()).toBe(true);
    btn.trigger('click');
    expect(w.emitted('open-expanded')).toBeTruthy();
  });
});
