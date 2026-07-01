// @vitest-environment happy-dom
//
// test/unit/hugo-apps/related-graph-help-doc-row.test.ts
//
// Phase 4.7 (#748 §4.8.2) — sidebar "Other resources" widens to include
// help-doc rows alongside the six prior types (learning-journey /
// blog-post / discovery-mission / video / api-doc / sample).
//
// The happy path renders through ResourceRow driven by the server's
// typeConfig (RESOURCE_TYPE_CONFIG entry for `help-doc` was added in
// Task 2). This test file exercises BOTH paths:
//   - typeConfig present (happy path — ResourceRow's server-supplied
//     metaText carries `· CAP · Before Create`).
//   - typeConfig absent (legacy fallback — SidebarPanel renders its 7th
//     v-else-if branch inline with tinted badge).
//
// Also covers: telemetry dispatch (kg.help-doc.linked_from_sidebar) on
// click, target=_blank rel=noopener on the row link, correct sourceLabel
// + tint class rendering, and mutual exclusion (help-doc rows never
// leak cross-type meta fields).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RelatedGraph from '../../../hugo-apps/src/related-graph/RelatedGraph.vue'

type HelpDocResource = {
  type: 'help-doc'
  slug: string
  title: string
  url: string
  source?: 'help-sap-com' | 'cap-cloud-sap' | 'ui5-sap-com' | null
  sourceLabel?: string | null
  anchor?: string | null
  anchorLabel?: string | null
  snippet?: string | null
  product?: string | null
  metaText?: string | null
}

function makePayload(overrides: {
  otherResources?: HelpDocResource[]
  withTypeConfig?: boolean
}) {
  const base = {
    tutorial: { slug: 'cap-handlers-tutorial', title: 'CAP Handlers' },
    graphVersion: 'v-test-7',
    teaches: [
      { slug: 'cap-handlers', name: 'CAP Handlers', published: true },
    ],
    prerequisitesOf: [],
    sharedConcepts: [],
    whatToLearnNext: [],
    otherResources: overrides.otherResources ?? [],
  } as Record<string, unknown>

  if (overrides.withTypeConfig !== false) {
    base.typeConfig = [
      {
        type: 'help-doc',
        icon: '📚',
        singular: 'Help doc',
        plural: 'Help docs',
        priority: 70,
        metaTemplate: 'Source · Anchor',
      },
    ]
  }
  return base
}

describe('RelatedGraph sidebar — help-doc rows (Phase 4.7)', () => {
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

  it('renders a help-doc row with title and CAP sourceLabel via ResourceRow (happy path)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'help-doc',
          slug: 'hd-cap-handlers',
          title: 'Handlers',
          url: 'https://cap.cloud.sap/docs/node.js/handlers',
          source: 'cap-cloud-sap',
          sourceLabel: 'CAP',
          anchor: 'before-create',
          anchorLabel: 'Before Create',
          // Simulated server-rendered metaText (RESOURCE_TYPE_CONFIG.renderMeta
          // output for a help-doc row with sourceLabel + anchorLabel):
          metaText: ' · CAP · Before Create',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const txt = wrapper.text()
    expect(txt).toContain('Other resources')
    expect(txt).toContain('Handlers')
    // Happy path renders metaText verbatim, so the ` · CAP · Before Create`
    // segment appears via ResourceRow's <span class="kg-resource-row__meta">.
    expect(txt).toContain('CAP')
    expect(txt).toContain('Before Create')
  })

  it('renders external link with target="_blank" rel="noopener"', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'help-doc',
          slug: 'hd-ui5',
          title: 'sap.m.Table',
          url: 'https://ui5.sap.com/#/api/sap.m.Table',
          source: 'ui5-sap-com',
          sourceLabel: 'UI5',
          metaText: ' · UI5',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find('a[href="https://ui5.sap.com/#/api/sap.m.Table"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('fires kg.help-doc.linked_from_sidebar on click with correct detail shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'help-doc',
          slug: 'hd-cap-handlers',
          title: 'Handlers',
          url: 'https://cap.cloud.sap/docs/node.js/handlers',
          source: 'cap-cloud-sap',
          sourceLabel: 'CAP',
          metaText: ' · CAP',
        }],
      }),
    } as unknown as Response)

    const events: CustomEvent[] = []
    const handler = (e: Event) => { events.push(e as CustomEvent) }
    window.addEventListener('kg.help-doc.linked_from_sidebar', handler)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find('a[href="https://cap.cloud.sap/docs/node.js/handlers"]')
    await link.trigger('click')

    expect(events).toHaveLength(1)
    expect(events[0].detail).toMatchObject({
      tutorialSlug: 'cap-handlers-tutorial',
      helpDocSlug: 'hd-cap-handlers',
    })

    window.removeEventListener('kg.help-doc.linked_from_sidebar', handler)
  })

  it('legacy fallback (no typeConfig) renders help-sap-com tint class on the badge', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        withTypeConfig: false,
        otherResources: [{
          type: 'help-doc',
          slug: 'hd-help',
          title: 'CAP overview',
          url: 'https://help.sap.com/docs/cap/overview',
          source: 'help-sap-com',
          sourceLabel: 'SAP Help',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const html = wrapper.html()
    expect(html).toContain('SAP Help')
    // Legacy fallback branch renders the .kg-help-source--help-sap-com tint class:
    expect(html).toContain('kg-help-source--help-sap-com')
  })

  it('legacy fallback (no typeConfig) renders cap-cloud-sap tint on CAP-source rows', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        withTypeConfig: false,
        otherResources: [{
          type: 'help-doc',
          slug: 'hd-cap',
          title: 'Handlers',
          url: 'https://cap.cloud.sap/docs/node.js/handlers',
          source: 'cap-cloud-sap',
          sourceLabel: 'CAP',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const html = wrapper.html()
    expect(html).toContain('CAP')
    expect(html).toContain('kg-help-source--cap-cloud-sap')
  })

  it('mutual exclusion: help-doc row does NOT render other-type meta fields (legacy fallback)', async () => {
    // In the legacy fallback path, the SidebarPanel v-else-if chain must
    // route a `help-doc` row to only the help-doc branch — never to
    // learning-journey / blog-post / discovery-mission / video / api-doc /
    // sample.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        withTypeConfig: false,
        otherResources: [{
          type: 'help-doc',
          slug: 'hd-x',
          title: 'Some doc',
          url: 'https://cap.cloud.sap/docs/x',
          source: 'cap-cloud-sap',
          sourceLabel: 'CAP',
          // Cross-type leak fields — must NOT render.
          // @ts-expect-error — intentional cross-type leak
          authorName: 'Should Not Render',
          // @ts-expect-error — intentional cross-type leak
          channelTitle: 'Should Not Render',
          // @ts-expect-error — intentional cross-type leak
          apiType: 'Should Not Render',
        } as HelpDocResource],
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
    // No api-doc "Official reference" lead (help-doc has its own source labels):
    expect(txt).not.toContain('Official reference')
  })

  it('appends the anchor fragment to the href when anchor is set', async () => {
    // Spec §4.8.2 / plan §3.3 Step 9: sidebar links for help-doc rows must
    // compose url + '#' + anchor so deep-links to specific doc sections
    // survive the click-out. Covers the happy path (ResourceRow).
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'help-doc',
          slug: 'hd-cap-anchor',
          title: 'Handlers',
          url: 'https://cap.cloud.sap/docs/node.js/handlers',
          source: 'cap-cloud-sap',
          sourceLabel: 'CAP',
          anchor: 'before-create',
          anchorLabel: 'Before Create',
          metaText: ' · CAP · Before Create',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find(
      'a[href="https://cap.cloud.sap/docs/node.js/handlers#before-create"]',
    )
    expect(link.exists()).toBe(true)
  })

  it('does not append a fragment when anchor is null', async () => {
    // Same rule, negative case: no anchor means the raw url is used as-is,
    // with no stray '#'.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => makePayload({
        otherResources: [{
          type: 'help-doc',
          slug: 'hd-no-anchor',
          title: 'Overview',
          url: 'https://help.sap.com/docs/cap/overview',
          source: 'help-sap-com',
          sourceLabel: 'SAP Help',
          anchor: null,
          metaText: ' · SAP Help',
        }],
      }),
    } as unknown as Response)

    const wrapper = mount(RelatedGraph)
    await flushPromises()
    await flushPromises()

    const link = wrapper.find(
      'a[href="https://help.sap.com/docs/cap/overview"]',
    )
    expect(link.exists()).toBe(true)
    // Belt-and-suspenders: the href should have no trailing '#'.
    expect(link.attributes('href')).not.toContain('#')
  })
})
