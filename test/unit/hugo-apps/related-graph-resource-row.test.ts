// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-resource-row.test.ts
//
// Task 10 of KG widget redesign (#850): ResourceRow.vue is a
// presentational, per-row component receiving a resolved TypeConfigEntry +
// row payload. Both SidebarPanel (Task 11) and ExpandedPanel (Task 12)
// mount ResourceRow — the type→icon/meta chain lives on the server
// (kg-resource-type-config.js), so this component has NO `v-if r.type ===`
// branches. metaText comes from the server rendered verbatim.
import { mount } from '@vue/test-utils';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ResourceRow from '../../../hugo-apps/src/related-graph/ResourceRow.vue';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RR_PATH = join(__dirname, '../../../hugo-apps/src/related-graph/ResourceRow.vue');

describe('ResourceRow', () => {
  const configEntry = {
    type: 'blog-post', icon: '📝', singular: 'Blog post',
    plural: 'Blog posts', priority: 20, metaTemplate: 'Author · Date',
  };
  const row = {
    type: 'blog-post', slug: 's', title: 'CDS entities: the modeling primer',
    url: 'https://example.com/post',
    authorName: 'Alice', postedAt: '2026-06-03T12:00:00Z',
    overlapCount: 3, metaText: ' · by Alice · Jun 3, 2026',
  };

  it('renders icon from config', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    expect(w.text()).toContain('📝');
  });
  it('renders title as link with row.url', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    const a = w.get('a');
    expect(a.attributes('href')).toBe('https://example.com/post');
    expect(a.text()).toContain('CDS entities');
  });
  it('renders metaText verbatim (does not compute)', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    expect(w.text()).toContain(' · by Alice · Jun 3, 2026');
  });
  it('renders external links with target=_blank rel=noopener', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    const a = w.get('a');
    expect(a.attributes('target')).toBe('_blank');
    expect(a.attributes('rel')).toContain('noopener');
  });
  it('icon carries aria-hidden=true (a11y)', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    expect(w.html()).toMatch(/aria-hidden="true"/);
    // Icon is inside a span; verify the span contains the emoji
    expect(w.find('[aria-hidden="true"]').text()).toBe('📝');
  });
  it('emits click event with the row payload when the link is clicked', () => {
    const w = mount(ResourceRow, { props: { config: configEntry, row } });
    w.get('a').trigger('click');
    expect(w.emitted('click')).toBeTruthy();
    expect(w.emitted('click')![0]).toEqual([row]);
  });
  it('handles missing metaText gracefully (no crash, no empty meta element)', () => {
    const bareRow = { ...row, metaText: undefined };
    const w = mount(ResourceRow, { props: { config: configEntry, row: bareRow } });
    // No text after the title should include the meta separator
    expect(w.find('.kg-resource-row__meta').exists()).toBe(false);
  });

  // Guard: source must not contain a v-if / v-else-if on r.type.
  it('source has no v-if / v-else-if on r.type or row.type', () => {
    const src = readFileSync(RR_PATH, 'utf8');
    expect(src).not.toMatch(/r\.type\s*===/);
    expect(src).not.toMatch(/row\.type\s*===/);
  });
});
