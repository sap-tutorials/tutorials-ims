// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-concept-links.test.ts
//
// Phase 3 #446 — concept-link rendering test. ORIGINALLY covered the sidebar
// rendering: published concepts became <a href="/concepts/<slug>/">, others
// rendered as <span>. Task 11 of #850 REMOVED the "This tutorial teaches"
// section from the sidebar entirely, so these tests now assert the opposite:
// no concept link (published or not) appears in the sidebar. The published-
// concept link-out lives on the ExpandedPanel's teaches section and on the
// tutorial's own concept chip strip — separate surfaces with their own
// tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue';

function makePayload(overrides: {
  teaches: Array<{ slug: string; name: string; published?: boolean; description?: string | null }>;
}) {
  return {
    tutorial: { slug: 'demo-tutorial', title: 'Demo Tutorial' },
    graphVersion: 'v-test-1',
    teaches: overrides.teaches,
    prerequisitesOf: [],
    sharedConcepts: [],
    whatToLearnNext: [],
  };
}

describe('RelatedGraph sidebar — concept links are no longer rendered (post-#850)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Set the page-slug the component reads from <html>
    document.documentElement.dataset.pageSlug = 'demo-tutorial';
    // Force the "no IntersectionObserver" branch so the component fetches
    // immediately on mount instead of waiting for a scroll trigger. The
    // component checks `typeof IntersectionObserver === 'undefined'`; setting
    // the global to `undefined` satisfies that check (typeof undefined ===
    // 'undefined'). Using vi.stubGlobal is robust against happy-dom adding
    // an IntersectionObserver shim in a future release — `delete` would
    // silently stop working in that case.
    vi.stubGlobal('IntersectionObserver', undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.pageSlug;
    vi.restoreAllMocks();
    // Clear sessionStorage so prior tests' ETag cache doesn't bleed in.
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });

  it('does NOT render a published concept as a link in the sidebar (teaches section removed)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        makePayload({
          teaches: [
            { slug: 'cap-handlers', name: 'CAP handlers', published: true },
          ],
        }),
    } as unknown as Response);

    const wrapper = mount(RelatedGraph);
    await flushPromises();
    await flushPromises();

    // Task 11 of #850 removed the teaches section from the sidebar; the
    // concept must not render as a link OR as a span here.
    expect(wrapper.find('a[href="/concepts/cap-handlers/"]').exists()).toBe(false);
    expect(wrapper.find('span.kg-sidebar-concept-text').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('CAP handlers');
  });

  it('does NOT render an unpublished concept in the sidebar', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        makePayload({
          teaches: [
            { slug: 'draft-concept', name: 'Draft Concept', published: false },
          ],
        }),
    } as unknown as Response);

    const wrapper = mount(RelatedGraph);
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('a[href="/concepts/draft-concept/"]').exists()).toBe(false);
    expect(wrapper.find('span.kg-sidebar-concept-text').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Draft Concept');
  });

  it('does NOT render a legacy concept (missing published field) in the sidebar', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        makePayload({
          teaches: [{ slug: 'legacy-concept', name: 'Legacy Concept' }],
        }),
    } as unknown as Response);

    const wrapper = mount(RelatedGraph);
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('a[href="/concepts/legacy-concept/"]').exists()).toBe(false);
    expect(wrapper.find('span.kg-sidebar-concept-text').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Legacy Concept');
  });
});
