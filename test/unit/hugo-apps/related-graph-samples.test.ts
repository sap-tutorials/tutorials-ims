// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-samples.test.ts
//
// Phase 4.6 (#747 §5) — sidebar "Other resources" widens to include
// sample rows alongside learning-journey + blog-post + discovery-mission
// + video + api-doc rows. Mirrors related-graph-api-docs.test.ts for the
// Phase 4.5 surface, but the fixture row type is 'sample' and the
// telemetry event is `kg.sample.linked_from_sidebar`.
//
// The component renders `· Language · N stars · Updated Mon YYYY` for
// sample rows. Each meta segment is independently conditional — a row
// can have any subset of language / stars / lastCommitAt and the
// surrounding ` · ` separators stay clean. Each branch is mutually
// exclusive — a sample row must not pick up learning-journey, blog-post,
// discovery-mission, video, or api-doc meta fields.
//
// Visual rhythm: the sidebar branch does NOT render thumbnails (samples
// are GitHub repos and don't have them) and does NOT render the ↗
// link-out icon (concept page does; sidebar does not). Title-only with
// meta-row.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue'

type SampleResource = {
  type: 'sample'
  slug: string
  title: string
  url: string
  language?: string | null
  stars?: number | null
  lastCommitAt?: string | null
  overlapCount?: number | null
}

function makePayload(overrides: { otherResources?: SampleResource[] }) {
  return {
    tutorial: { slug: 'cap-handlers-tutorial', title: 'CAP Handlers' },
    graphVersion: 'v-test-6',
    teaches: [
      { slug: 'cap-handlers', name: 'CAP Handlers', published: true },
    ],
    prerequisitesOf: [],
    sharedConcepts: [],
    whatToLearnNext: [],
    otherResources: overrides.otherResources ?? [],
  }
}

describe('RelatedGraph sidebar — sample rows in "Other resources"', () => {
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

  it('mutual exclusion: sample row does NOT render other-type meta fields', async () => {
    // The v-if/v-else-if chain in RelatedGraph.vue ensures a sample row
    // never picks up `level`/`durationHours`/`authorName`/`postedAt-as-by-
    // Author`/`effortLevel`/`categoryLabel`/`channelTitle`/`publishedAt`/
    // `category`/`apiType` from a sibling type's branch even if a wire
    // payload leaks them.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'sample',
          slug: 'sa-1',
          title: 'My Sample',
          url: 'https://github.com/SAP-samples/x',
          language: 'JavaScript',
          // Even if these somehow leak into the data, the v-else-if branches
          // for the other types must not fire for a 'sample' row.
          // @ts-expect-error — intentional cross-type leak
          authorName: 'Should Not Render',
          // @ts-expect-error — intentional cross-type leak
          channelTitle: 'Should Not Render',
          // @ts-expect-error — intentional cross-type leak
          apiType: 'Should Not Render',
        } as SampleResource],
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
    // No api-doc lead:
    expect(txt).not.toContain('Official reference')
  })

  it('renders external link with target="_blank" rel="noopener"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'sample',
          slug: 'sa-1',
          title: 'X',
          url: 'https://github.com/SAP-samples/x',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find('a[href="https://github.com/SAP-samples/x"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('fires kg.sample.linked_from_sidebar on click with correct detail shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'sample',
          slug: 'sa-cap',
          title: 'cap-samples',
          url: 'https://github.com/SAP-samples/cap-samples',
          language: 'JavaScript',
        }],
      }),
    } as unknown as Response)

    const events: CustomEvent[] = []
    const handler = (e: Event) => { events.push(e as CustomEvent) }
    window.addEventListener('kg.sample.linked_from_sidebar', handler)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find('a[href="https://github.com/SAP-samples/cap-samples"]')
    await link.trigger('click')

    expect(events).toHaveLength(1)
    expect(events[0].detail).toMatchObject({
      tutorialSlug: 'cap-handlers-tutorial',
      sampleSlug: 'sa-cap',
    })

    window.removeEventListener('kg.sample.linked_from_sidebar', handler)
  })

  it('does NOT render a thumbnail in the sidebar for sample rows', async () => {
    // Spec §5: sidebar branch preserves visual rhythm by NOT rendering
    // thumbnails. samples are GitHub repos and have no thumbnails at all
    // on the wire; this test guards that no <img> is ever rendered for
    // the row.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'sample',
          slug: 'sa-x',
          title: 'X',
          url: 'https://github.com/SAP-samples/x',
          language: 'JavaScript',
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
})
