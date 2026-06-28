// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-blog-posts.test.ts
//
// Phase 4.2 (#447 §9) — sidebar "Other resources" widens to include blog-post
// rows alongside learning-journey rows. Mirrors related-graph-other-resources.test.ts
// for the Phase 4.1 surface, but the fixture row type is 'blog-post' and the
// telemetry event is `kg.blog_post.linked_from_sidebar`.
//
// The component renders `· by Author · Date` for blog-post rows (vs. `· Level
// · Hh` for learning-journey rows). Date is formatted with toLocaleDateString
// ('en-US', short month) — the test asserts the year only to avoid locale
// brittleness.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue'

type BlogPostResource = {
  type: 'blog-post'
  slug: string
  title: string
  url: string
  authorName?: string | null
  postedAt?: string | null
  overlapCount?: number | null
}

function makePayload(overrides: { otherResources?: BlogPostResource[] }) {
  return {
    tutorial: { slug: 'cap-handlers-tutorial', title: 'CAP Handlers' },
    graphVersion: 'v-test-2',
    teaches: [
      { slug: 'cap-service-handlers', name: 'CAP service handlers', published: true },
    ],
    prerequisitesOf: [],
    sharedConcepts: [],
    whatToLearnNext: [],
    otherResources: overrides.otherResources ?? [],
  }
}

describe('RelatedGraph sidebar — blog-post rows in "Other resources"', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    document.documentElement.dataset.pageSlug = 'cap-handlers-tutorial'
    vi.stubGlobal('IntersectionObserver', undefined)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.pageSlug
    vi.restoreAllMocks()
    try { sessionStorage.clear() } catch { /* ignore */ }
  })

  it('renders blog-post rows when otherResources includes type=blog-post', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'blog-post',
          slug: 'bp-99999',
          title: 'A Blog Post About CAP Handlers',
          url: 'https://community.sap.com/t5/blog/cap-handlers/ba-p/99999',
          authorName: 'Test Author',
          postedAt: '2026-05-15T09:32:11.000Z',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('Other resources')
    expect(wrapper.text()).toContain('A Blog Post About CAP Handlers')
  })

  it('renders "· by Author · {Date}" meta for blog-post rows', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'blog-post',
          slug: 'bp-99999',
          title: 'A Blog Post About CAP Handlers',
          url: 'https://community.sap.com/t5/blog/cap-handlers/ba-p/99999',
          authorName: 'Test Author',
          postedAt: '2026-05-15T09:32:11.000Z',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('Test Author')
    // Assert just the year to dodge locale-formatting brittleness across runners.
    expect(wrapper.text()).toContain('2026')
  })

  it('does NOT render learning-journey meta (·Level·Hh) for a blog-post row', async () => {
    // Defensive: makes sure the v-if/v-else-if branches don't double-fire on a
    // mis-typed row. If `level` somehow leaked into a blog-post fixture, the
    // learning-journey branch must NOT pick it up.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'blog-post',
          slug: 'bp-99999',
          title: 'A Blog Post',
          url: 'https://community.sap.com/p/99999',
          authorName: 'Author',
          postedAt: '2026-05-15T09:32:11.000Z',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    // No "Intermediate" / "Beginner" / "Advanced" / hour-suffix patterns.
    const txt = wrapper.text()
    expect(txt).not.toMatch(/Intermediate|Beginner|Advanced/)
    expect(txt).not.toMatch(/\d+h\b/)
  })

  it('renders external link with target="_blank" rel="noopener"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'blog-post',
          slug: 'bp-99999',
          title: 'A Blog Post About CAP Handlers',
          url: 'https://community.sap.com/t5/blog/cap-handlers/ba-p/99999',
          authorName: 'Test Author',
          postedAt: '2026-05-15T09:32:11.000Z',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find(
      'a[href="https://community.sap.com/t5/blog/cap-handlers/ba-p/99999"]',
    )
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('fires kg.blog_post.linked_from_sidebar on click with correct detail shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'blog-post',
          slug: 'bp-99999',
          title: 'A Blog Post About CAP Handlers',
          url: 'https://community.sap.com/t5/blog/cap-handlers/ba-p/99999',
          authorName: 'Test Author',
          postedAt: '2026-05-15T09:32:11.000Z',
        }],
      }),
    } as unknown as Response)

    const events: CustomEvent[] = []
    const handler = (e: Event) => { events.push(e as CustomEvent) }
    window.addEventListener('kg.blog_post.linked_from_sidebar', handler)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    // Plan note: handler closes over `r`; the test selects the anchor by its
    // href (the fixture's URL is unique) — no data-* attribute needed.
    const link = wrapper.find(
      'a[href="https://community.sap.com/t5/blog/cap-handlers/ba-p/99999"]',
    )
    await link.trigger('click')

    expect(events).toHaveLength(1)
    expect(events[0].detail).toMatchObject({
      tutorialSlug: 'cap-handlers-tutorial',
      blogSlug: 'bp-99999',
    })

    window.removeEventListener('kg.blog_post.linked_from_sidebar', handler)
  })

  it('renders gracefully when authorName/postedAt are absent', async () => {
    // Defensive: chassis says authorName/postedAt are optional on the wire.
    // The component must not crash if they're null/undefined; the row title
    // still renders.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'blog-post',
          slug: 'bp-no-meta',
          title: 'A Blog Post Without Meta',
          url: 'https://community.sap.com/p/no-meta',
          authorName: null,
          postedAt: null,
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('A Blog Post Without Meta')
  })
})
