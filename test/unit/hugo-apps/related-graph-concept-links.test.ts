// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-concept-links.test.ts
//
// Phase 3 #446 — sidebar concept-rendering test.
// When the neighborhood payload's `teaches[i].published` is true, the
// sidebar must render the concept as an <a href="/concepts/<slug>/">.
// When `published` is false (or absent), it renders as a non-link
// element (a <span>) with the concept name. The negative case must
// NOT contain any `/concepts/<slug>/` href for that concept.

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

describe('RelatedGraph sidebar — concept links honor `published` flag', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalIO: typeof globalThis.IntersectionObserver;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalIO = globalThis.IntersectionObserver;
    // Set the page-slug the component reads from <html>
    document.documentElement.dataset.pageSlug = 'demo-tutorial';
    // Force the "no IntersectionObserver" branch so the component fetches
    // immediately on mount instead of waiting for a scroll trigger.
    // The component checks `typeof IntersectionObserver === 'undefined'`,
    // so we need to actually remove it (vi.stubGlobal with undefined still
    // leaves typeof as 'undefined' in happy-dom).
    // @ts-expect-error — intentional removal for the test
    delete globalThis.IntersectionObserver;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.IntersectionObserver = originalIO;
    delete document.documentElement.dataset.pageSlug;
    vi.restoreAllMocks();
    // Clear sessionStorage so prior tests' ETag cache doesn't bleed in.
    try { sessionStorage.clear(); } catch { /* ignore */ }
  });

  it('renders a published concept as <a href="/concepts/<slug>/">', async () => {
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

    const link = wrapper.find('a[href="/concepts/cap-handlers/"]');
    expect(link.exists()).toBe(true);
    expect(link.text()).toBe('CAP handlers');
  });

  it('renders an unpublished concept as a non-link with no /concepts/ href', async () => {
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

    // No anchor to /concepts/draft-concept/
    expect(wrapper.find('a[href="/concepts/draft-concept/"]').exists()).toBe(false);
    // But the name is still in the DOM (as plain text).
    expect(wrapper.text()).toContain('Draft Concept');
  });

  it('treats a missing `published` field as unpublished (backward compat)', async () => {
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
    expect(wrapper.text()).toContain('Legacy Concept');
  });
});
