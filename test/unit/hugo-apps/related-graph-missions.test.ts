// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-missions.test.ts
//
// Phase 4.3 (#447 §8) — sidebar "Other resources" widens to include
// discovery-mission rows alongside learning-journey + blog-post rows.
// Mirrors related-graph-blog-posts.test.ts for the Phase 4.2 surface, but
// the fixture row type is 'discovery-mission' and the telemetry event is
// `kg.discovery_mission.linked_from_sidebar`.
//
// The component renders `· effort N · CategoryLabel` for discovery-mission
// rows (vs. `· by Author · Date` for blog-post rows and `· Level · Hh` for
// learning-journey rows). Each branch is mutually exclusive — a mission row
// must not pick up learning-journey or blog-post meta fields.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue'

type DiscoveryMissionResource = {
  type: 'discovery-mission'
  slug: string
  title: string
  url: string
  effortLevel?: number | null
  categoryLabel?: string | null
  overlapCount?: number | null
}

function makePayload(overrides: { otherResources?: DiscoveryMissionResource[] }) {
  return {
    tutorial: { slug: 'cap-handlers-tutorial', title: 'CAP Handlers' },
    graphVersion: 'v-test-3',
    teaches: [
      { slug: 'cap-service-handlers', name: 'CAP service handlers', published: true },
    ],
    prerequisitesOf: [],
    sharedConcepts: [],
    whatToLearnNext: [],
    otherResources: overrides.otherResources ?? [],
  }
}

describe('RelatedGraph sidebar — discovery-mission rows in "Other resources"', () => {
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

  it('renders discovery-mission rows when otherResources includes type=discovery-mission', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'discovery-mission',
          slug: 'dm-3019',
          title: 'Get Started with SAP BTP Enterprise Account',
          url: 'https://discovery-center.cloud.sap/missiondetail/3019/',
          effortLevel: 2,
          categoryLabel: 'Onboarding',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('Other resources')
    expect(wrapper.text()).toContain('Get Started with SAP BTP Enterprise Account')
  })

  it('does NOT render learning-journey or blog-post meta for a discovery-mission row', async () => {
    // Mutual exclusion: the v-if/v-else-if chain in RelatedGraph.vue ensures
    // a mission row never picks up `level`/`durationHours`/`authorName`/
    // `postedAt` from a sibling type's branch.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'discovery-mission',
          slug: 'dm-3019',
          title: 'A Discovery Mission',
          url: 'https://discovery-center.cloud.sap/missiondetail/3019/',
          effortLevel: 2,
          categoryLabel: 'Onboarding',
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
    // No blog-post meta — the row format is "· by Author · Date", so the
    // distinguishing marker is the bullet-prefixed "· by ". The panel header
    // text ("Powered by the knowledge graph...") would falsely match a loose
    // /by .+/ regex.
    expect(txt).not.toMatch(/· by /)
  })

  it('renders external link with target="_blank" rel="noopener"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'discovery-mission',
          slug: 'dm-3019',
          title: 'Get Started with SAP BTP Enterprise Account',
          url: 'https://discovery-center.cloud.sap/missiondetail/3019/',
          effortLevel: 2,
          categoryLabel: 'Onboarding',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find(
      'a[href="https://discovery-center.cloud.sap/missiondetail/3019/"]',
    )
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('fires kg.discovery_mission.linked_from_sidebar on click with correct detail shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'discovery-mission',
          slug: 'dm-3019',
          title: 'Get Started with SAP BTP Enterprise Account',
          url: 'https://discovery-center.cloud.sap/missiondetail/3019/',
          effortLevel: 2,
          categoryLabel: 'Onboarding',
        }],
      }),
    } as unknown as Response)

    const events: CustomEvent[] = []
    const handler = (e: Event) => { events.push(e as CustomEvent) }
    window.addEventListener('kg.discovery_mission.linked_from_sidebar', handler)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    // Plan note: handler closes over `r`; the test selects the anchor by
    // its href (the fixture's URL is unique) — no data-* attribute needed.
    const link = wrapper.find(
      'a[href="https://discovery-center.cloud.sap/missiondetail/3019/"]',
    )
    await link.trigger('click')

    expect(events).toHaveLength(1)
    expect(events[0].detail).toMatchObject({
      tutorialSlug: 'cap-handlers-tutorial',
      missionSlug: 'dm-3019',
    })

    window.removeEventListener('kg.discovery_mission.linked_from_sidebar', handler)
  })

  it('renders gracefully when effortLevel/categoryLabel are absent', async () => {
    // Defensive: chassis says effortLevel/categoryLabel are optional on the
    // wire. The component must not crash if they're null/undefined; the row
    // title still renders.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'discovery-mission',
          slug: 'dm-bare',
          title: 'A Mission Without Meta',
          url: 'https://discovery-center.cloud.sap/missiondetail/bare/',
          effortLevel: null,
          categoryLabel: null,
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    expect(wrapper.text()).toContain('A Mission Without Meta')
  })

  it('hides the Other resources section entirely when otherResources is empty', async () => {
    // Sanity-check the hide-when-empty discipline holds even with the
    // mission branch added — the section header itself should not render
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
