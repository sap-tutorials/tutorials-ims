// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-videos.test.ts
//
// Phase 4.4 (#447 §9) — sidebar "Other resources" widens to include
// video rows alongside learning-journey + blog-post + discovery-mission
// rows. Mirrors related-graph-missions.test.ts for the Phase 4.3
// surface, but the fixture row type is 'video' and the telemetry event
// is `kg.video.linked_from_sidebar`.
//
// The component renders `· by ChannelTitle · Date` for video rows (the
// same meta shape as blog-post rows, intentionally — both surfaces are
// "person-authored content"). Each branch is mutually exclusive — a
// video row must not pick up learning-journey, blog-post, or
// discovery-mission meta fields.
//
// Visual rhythm: the sidebar branch intentionally does NOT render
// `thumbnailUrl` (concept page does, sidebar does not — spec §9). The
// 6th test asserts that even if `thumbnailUrl` ships on the wire, no
// <img> appears in the rendered sidebar row.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue'

type VideoResource = {
  type: 'video'
  slug: string
  title: string
  url: string
  channelTitle?: string | null
  publishedAt?: string | null
  thumbnailUrl?: string | null
  overlapCount?: number | null
}

function makePayload(overrides: { otherResources?: VideoResource[] }) {
  return {
    tutorial: { slug: 'cap-handlers-tutorial', title: 'CAP Handlers' },
    graphVersion: 'v-test-4',
    teaches: [
      { slug: 'cap-service-handlers', name: 'CAP service handlers', published: true },
    ],
    prerequisitesOf: [],
    sharedConcepts: [],
    whatToLearnNext: [],
    otherResources: overrides.otherResources ?? [],
  }
}

describe('RelatedGraph sidebar — video rows in "Other resources"', () => {
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

  it('renders video rows with "· by Channel · Date" meta', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'video',
          slug: 'vid-abc123',
          title: 'CAP Service Handlers — Deep Dive',
          url: 'https://www.youtube.com/watch?v=abc123',
          channelTitle: 'SAP Developers',
          publishedAt: '2026-05-10T14:00:00Z',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const txt = wrapper.text()
    expect(txt).toContain('Other resources')
    expect(txt).toContain('CAP Service Handlers — Deep Dive')
    expect(txt).toContain('by SAP Developers')
    // formatDate('2026-05-10T14:00:00Z') → "May 10, 2026" via en-US locale
    expect(txt).toMatch(/May 10, 2026/)
  })

  it('does NOT render learning-journey / blog-post / discovery-mission meta for a video row', async () => {
    // Mutual exclusion: the v-if/v-else-if chain in RelatedGraph.vue
    // ensures a video row never picks up `level`/`durationHours`/
    // `authorName`/`postedAt-as-by-Author`/`effortLevel`/`categoryLabel`
    // from a sibling type's branch.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'video',
          slug: 'vid-abc123',
          title: 'A Video',
          url: 'https://www.youtube.com/watch?v=abc123',
          channelTitle: 'SAP Developers',
          publishedAt: '2026-05-10T14:00:00Z',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const txt = wrapper.text()
    // No learning-journey meta:
    expect(txt).not.toMatch(/Intermediate|Beginner|Advanced/)
    expect(txt).not.toMatch(/\d+h\b/)
    // No discovery-mission meta:
    expect(txt).not.toMatch(/effort \d+/)
    // Video branch DOES say "by Channel" — the blog-post branch ALSO
    // emits "by Author" form. They render identically, so we cannot
    // distinguish them by the meta string alone. We rely on the fact
    // that only ONE branch fires per row (v-if/v-else-if).
  })

  it('renders external link with target="_blank" rel="noopener"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'video',
          slug: 'vid-abc123',
          title: 'CAP Service Handlers — Deep Dive',
          url: 'https://www.youtube.com/watch?v=abc123',
          channelTitle: 'SAP Developers',
          publishedAt: '2026-05-10T14:00:00Z',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find('a[href="https://www.youtube.com/watch?v=abc123"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('fires kg.video.linked_from_sidebar on click with correct detail shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'video',
          slug: 'vid-abc123',
          title: 'CAP Service Handlers — Deep Dive',
          url: 'https://www.youtube.com/watch?v=abc123',
          channelTitle: 'SAP Developers',
          publishedAt: '2026-05-10T14:00:00Z',
        }],
      }),
    } as unknown as Response)

    const events: CustomEvent[] = []
    const handler = (e: Event) => { events.push(e as CustomEvent) }
    window.addEventListener('kg.video.linked_from_sidebar', handler)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    // Plan note: handler closes over `r`; the test selects the anchor by
    // its href (the fixture's URL is unique) — no data-* attribute needed.
    const link = wrapper.find('a[href="https://www.youtube.com/watch?v=abc123"]')
    await link.trigger('click')

    expect(events).toHaveLength(1)
    expect(events[0].detail).toMatchObject({
      tutorialSlug: 'cap-handlers-tutorial',
      videoSlug: 'vid-abc123',
    })

    window.removeEventListener('kg.video.linked_from_sidebar', handler)
  })

  it('renders gracefully when channelTitle/publishedAt are absent', async () => {
    // Defensive: chassis says channelTitle/publishedAt are optional on
    // the wire. The component must not crash if they're null/undefined;
    // the row title still renders.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'video',
          slug: 'vid-bare',
          title: 'A Video Without Meta',
          url: 'https://www.youtube.com/watch?v=bare',
          channelTitle: null,
          publishedAt: null,
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('A Video Without Meta')
  })

  it('does NOT render a thumbnail in the sidebar even if thumbnailUrl is on the wire', async () => {
    // Spec §9: sidebar branch preserves visual rhythm by NOT rendering
    // thumbnails. The concept page DOES render. `thumbnailUrl` may ship
    // on the wire (same payload as the concept page) — the sidebar
    // template must ignore it.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'video',
          slug: 'vid-thumb',
          title: 'A Video With Thumb',
          url: 'https://www.youtube.com/watch?v=thumb',
          channelTitle: 'SAP Developers',
          publishedAt: '2026-05-10T14:00:00Z',
          thumbnailUrl: 'https://i.ytimg.com/vi/thumb/hqdefault.jpg',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    // The "Other resources" section in the sidebar must contain NO <img>
    // even though thumbnailUrl is in the data.
    const otherSection = wrapper.find('.kg-section-other')
    expect(otherSection.exists()).toBe(true)
    expect(otherSection.findAll('img').length).toBe(0)
  })

  it('hides the Other resources section entirely when otherResources is empty', async () => {
    // Sanity-check the hide-when-empty discipline holds even with the
    // video branch added — the section header itself should not render
    // for a payload with no otherResources entries.
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
})
