// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-other-resources.test.ts
//
// Phase 4.1 (#447 §2.6) — sidebar "Other resources" section.
// When the neighborhood payload's `otherResources` is non-empty, the
// sidebar renders an "Other resources" section with one row per resource.
// When the array is empty (or missing), the section is omitted entirely.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue'

function makePayload(overrides: {
  otherResources?: Array<{
    type: 'learning-journey'
    slug: string
    title: string
    url: string
    level?: string | null
    durationHours?: number | null
    overlapCount?: number | null
  }>
}) {
  return {
    tutorial: { slug: 'cap-handlers-tutorial', title: 'CAP Handlers' },
    graphVersion: 'v-test-1',
    // teaches must be non-empty so the sidebar doesn't hide-on-empty
    // (the panel is gated on teaches.length > 0 in isEmpty()).
    teaches: [
      { slug: 'cap-service-handlers', name: 'CAP service handlers', published: true },
    ],
    prerequisitesOf: [],
    sharedConcepts: [],
    whatToLearnNext: [],
    otherResources: overrides.otherResources ?? [],
  }
}

describe('RelatedGraph sidebar — "Other resources" section', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    document.documentElement.dataset.pageSlug = 'cap-handlers-tutorial'
    // Force the no-IntersectionObserver branch so the component fetches
    // immediately on mount.
    vi.stubGlobal('IntersectionObserver', undefined)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.pageSlug
    vi.restoreAllMocks()
    try { sessionStorage.clear() } catch { /* ignore */ }
  })

  it('renders the "Other resources" section when otherResources is non-empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [
          {
            type: 'learning-journey',
            slug: 'cap-quickstart',
            title: 'CAP Quickstart Journey',
            url: 'https://learning.sap.com/learning-journeys/cap-quickstart',
            level: 'intermediate',
            durationHours: 7.25,
          },
        ],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('Other resources')
    expect(wrapper.text()).toContain('CAP Quickstart Journey')
  })

  it('does NOT render the section when otherResources is empty', async () => {
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

  it('external links use target="_blank" rel="noopener"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [
          {
            type: 'learning-journey',
            slug: 'cap-quickstart',
            title: 'CAP Quickstart Journey',
            url: 'https://learning.sap.com/learning-journeys/cap-quickstart',
            level: 'intermediate',
            durationHours: 7.25,
          },
        ],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find(
      'a[href="https://learning.sap.com/learning-journeys/cap-quickstart"]',
    )
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('fires kg.learning_journey.linked_from_sidebar on click', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [
          {
            type: 'learning-journey',
            slug: 'cap-quickstart',
            title: 'CAP Quickstart Journey',
            url: 'https://learning.sap.com/learning-journeys/cap-quickstart',
            level: 'intermediate',
            durationHours: 7.25,
          },
        ],
      }),
    } as unknown as Response)

    const events: CustomEvent[] = []
    const handler = (e: Event) => { events.push(e as CustomEvent) }
    window.addEventListener('kg.learning_journey.linked_from_sidebar', handler)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find(
      'a[href="https://learning.sap.com/learning-journeys/cap-quickstart"]',
    )
    await link.trigger('click')

    expect(events).toHaveLength(1)
    expect(events[0].detail).toMatchObject({
      tutorialSlug: 'cap-handlers-tutorial',
      journeySlug: 'cap-quickstart',
    })

    window.removeEventListener('kg.learning_journey.linked_from_sidebar', handler)
  })
})
