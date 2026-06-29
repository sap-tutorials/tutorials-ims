// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-api-docs.test.ts
//
// Phase 4.5 (#746 §5) — sidebar "Other resources" widens to include
// api-doc rows alongside learning-journey + blog-post + discovery-mission
// + video rows. Mirrors related-graph-videos.test.ts for the Phase 4.4
// surface, but the fixture row type is 'api-doc' and the telemetry event
// is `kg.api-doc.linked_from_sidebar`.
//
// The component renders `· Official reference · Category` for api-doc
// rows (the "Official reference" lead is unconditional; `category` is
// optional and prefixed by ` · `). Each branch is mutually exclusive — an
// api-doc row must not pick up learning-journey, blog-post,
// discovery-mission, or video meta fields.
//
// Visual rhythm: the sidebar branch does NOT render thumbnails (api-docs
// don't have them) and does NOT render the ↗ link-out icon (concept page
// does; sidebar does not). Title-only with meta-row.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue'

type ApiDocResource = {
  type: 'api-doc'
  slug: string
  title: string
  url: string
  category?: string | null
  apiType?: string | null
  overlapCount?: number | null
}

function makePayload(overrides: { otherResources?: ApiDocResource[] }) {
  return {
    tutorial: { slug: 'cap-handlers-tutorial', title: 'CAP Handlers' },
    graphVersion: 'v-test-5',
    teaches: [
      { slug: 'cap-cqn', name: 'CAP CQN', published: true },
    ],
    prerequisitesOf: [],
    sharedConcepts: [],
    whatToLearnNext: [],
    otherResources: overrides.otherResources ?? [],
  }
}

describe('RelatedGraph sidebar — api-doc rows in "Other resources"', () => {
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

  it('renders an api-doc row with "· Official reference · Category" meta', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'api-doc',
          slug: 'ad-cap_cqn',
          title: 'CAP CQN Reference',
          url: 'https://api.sap.com/package/CAP_CQN_Reference',
          category: 'CAP',
          apiType: 'reference',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const txt = wrapper.text()
    expect(txt).toContain('Other resources')
    expect(txt).toContain('CAP CQN Reference')
    expect(txt).toContain('Official reference')
    expect(txt).toContain('CAP')
  })

  it('mutual exclusion: api-doc row does NOT render other-type meta fields', async () => {
    // The v-if/v-else-if chain in RelatedGraph.vue ensures an api-doc row
    // never picks up `level`/`durationHours`/`authorName`/`postedAt-as-by-
    // Author`/`effortLevel`/`categoryLabel`/`channelTitle`/`publishedAt`
    // from a sibling type's branch even if a wire payload leaks them.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'api-doc',
          slug: 'ad-1',
          title: 'My API Doc',
          url: 'https://api.sap.com/x',
          // Even if these somehow leak into the data, the v-else-if branches
          // for the other types must not fire for a 'api-doc' row.
          // (Casting to any to bypass the typed shape.)
          // @ts-expect-error — intentional cross-type leak
          authorName: 'Should Not Render',
          // @ts-expect-error — intentional cross-type leak
          channelTitle: 'Should Not Render',
        } as ApiDocResource],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const txt = wrapper.text()
    expect(txt).not.toContain('Should Not Render')
    // No learning-journey meta:
    expect(txt).not.toMatch(/Intermediate|Beginner|Advanced/)
    expect(txt).not.toMatch(/\d+h\b/)
    // No discovery-mission meta:
    expect(txt).not.toMatch(/effort \d+/)
  })

  it('renders external link with target="_blank" rel="noopener"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'api-doc',
          slug: 'ad-1',
          title: 'X',
          url: 'https://api.sap.com/x',
          category: 'CAP',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find('a[href="https://api.sap.com/x"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('fires kg.api-doc.linked_from_sidebar on click with correct detail shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'api-doc',
          slug: 'ad-cap_cqn',
          title: 'CAP CQN',
          url: 'https://api.sap.com/package/CAP_CQN_Reference',
          category: 'CAP',
        }],
      }),
    } as unknown as Response)

    const events: CustomEvent[] = []
    const handler = (e: Event) => { events.push(e as CustomEvent) }
    window.addEventListener('kg.api-doc.linked_from_sidebar', handler)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find('a[href="https://api.sap.com/package/CAP_CQN_Reference"]')
    await link.trigger('click')

    expect(events).toHaveLength(1)
    expect(events[0].detail).toMatchObject({
      tutorialSlug: 'cap-handlers-tutorial',
      apiDocSlug: 'ad-cap_cqn',
    })

    window.removeEventListener('kg.api-doc.linked_from_sidebar', handler)
  })

  it('hides the Other resources section entirely when otherResources is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({ otherResources: [] }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).not.toContain('Other resources')
  })

  it('does NOT render a thumbnail in the sidebar for api-doc rows', async () => {
    // Spec §5: sidebar branch preserves visual rhythm by NOT rendering
    // thumbnails. api-docs have no thumbnails at all on the wire; this
    // test guards that no <img> is ever rendered for the row.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'api-doc',
          slug: 'ad-x',
          title: 'X',
          url: 'https://api.sap.com/x',
          category: 'CAP',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const otherSection = wrapper.find('.kg-section-other')
    expect(otherSection.exists()).toBe(true)
    expect(otherSection.findAll('img').length).toBe(0)
  })

  it('renders gracefully when category is absent (Official reference still shown)', async () => {
    // Defensive: category is optional on the wire. The row title plus the
    // unconditional "· Official reference" prefix must still render even
    // without category.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'api-doc',
          slug: 'ad-bare',
          title: 'A Bare API Doc',
          url: 'https://api.sap.com/bare',
          category: null,
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const txt = wrapper.text()
    expect(txt).toContain('A Bare API Doc')
    expect(txt).toContain('Official reference')
  })
})
