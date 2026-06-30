// @vitest-environment happy-dom
// test/unit/related-graph-island.test.ts
//
// Component-level tests for the Knowledge Graph sidebar island
// (PR 7 of issue #381). Mirrors the structure of
// hugo-apps/src/validation/Validation.test.ts: mount the real .vue with
// @vue/test-utils + happy-dom, mock fetch + IntersectionObserver +
// sessionStorage, drive lifecycle by triggering observer entries.
//
// UI5 web components (ui5-list, ui5-list-item) render as unknown
// elements in happy-dom — that's fine; we assert on plain DOM nodes
// (sections / list items) plus the wrapper.vm reactive state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import RelatedGraph from '../../hugo-apps/src/related-graph/RelatedGraph.vue'
import type { NeighborhoodResult } from '../../hugo-apps/src/related-graph/types'

// ── Test fixtures ─────────────────────────────────────────────────────

const POPULATED: NeighborhoodResult = {
  tutorial: { slug: 'cap-handlers', title: 'CAP Handlers' },
  graphVersion: 'g-2026-06-19-001',
  teaches: [
    { slug: 'concept-cap-service-handlers', name: 'CAP Service Handlers', description: 'Before/on/after handlers' },
    { slug: 'concept-custom-logic', name: 'Custom Logic Patterns', description: null },
  ],
  prerequisitesOf: [
    { slug: 'cap-first-service', title: 'Build Your First CAP Service', weight: 0.9, reason: null },
  ],
  sharedConcepts: [
    { slug: 'cap-validate-input', title: 'Validate Input with @assert', weight: 0.8, reason: null },
    { slug: 'cap-tenant-context', title: 'Read Tenant Context in Handlers', weight: 0.7, reason: null },
  ],
  whatToLearnNext: [
    { slug: 'cap-outbox', title: 'Outbox Pattern in CAP', weight: 0.85, reason: null },
  ],
}

const EMPTY: NeighborhoodResult = {
  tutorial: { slug: 'cap-handlers', title: 'CAP Handlers' },
  graphVersion: 'g-2026-06-19-001',
  teaches: [],
  prerequisitesOf: [],
  sharedConcepts: [],
  whatToLearnNext: [],
}

// ── Mocks ─────────────────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>
let observerCallback: IntersectionObserverCallback | null = null
let observeSpy: ReturnType<typeof vi.fn>
let disconnectSpy: ReturnType<typeof vi.fn>
let dispatchedEvents: Array<{ type: string; detail: any }>
let sessionStorageStore: Record<string, string>

function makeResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  const hdrs = new Headers(headers)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: hdrs,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function setupIntersectionObserver() {
  observerCallback = null
  observeSpy = vi.fn()
  disconnectSpy = vi.fn()
  // Vitest's `vi.fn()` returns a non-constructible spy, so we hand-roll
  // a class that captures the callback and the observe/disconnect calls.
  class MockIntersectionObserver {
    constructor(cb: IntersectionObserverCallback) {
      observerCallback = cb
    }
    observe = observeSpy
    disconnect = disconnectSpy
    unobserve = vi.fn()
    takeRecords = vi.fn().mockReturnValue([])
  }
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
}

function fireIntersect(isIntersecting = true) {
  if (!observerCallback) throw new Error('observerCallback not registered yet')
  observerCallback(
    [{ isIntersecting, target: document.createElement('div') } as IntersectionObserverEntry],
    {} as IntersectionObserver
  )
}

function setupSessionStorage() {
  sessionStorageStore = {}
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => sessionStorageStore[k] ?? null,
    setItem: (k: string, v: string) => {
      sessionStorageStore[k] = v
    },
    removeItem: (k: string) => {
      delete sessionStorageStore[k]
    },
    clear: () => {
      sessionStorageStore = {}
    },
  })
}

function setupEventCapture() {
  dispatchedEvents = []
  const realDispatch = window.dispatchEvent.bind(window)
  vi.spyOn(window, 'dispatchEvent').mockImplementation((evt: Event) => {
    dispatchedEvents.push({
      type: evt.type,
      detail: (evt as CustomEvent).detail,
    })
    return realDispatch(evt)
  })
}

// ── Setup / teardown ──────────────────────────────────────────────────

beforeEach(() => {
  document.documentElement.setAttribute('data-page-slug', 'cap-handlers')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  setupIntersectionObserver()
  setupSessionStorage()
  setupEventCapture()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-page-slug')
})

// ── Tests ─────────────────────────────────────────────────────────────

describe('<RelatedGraph>', () => {
  it('reads slug from document.documentElement.dataset.pageSlug', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(POPULATED))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("slug='cap-handlers'")
    expect(url).toContain('/graph/neighborhood')
    wrapper.unmount()
  })

  it('renders nothing when teaches is empty (hide-on-empty)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(EMPTY))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()
    expect(wrapper.find('aside.kg-sidebar').exists()).toBe(false)
    expect(wrapper.find('section').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders nothing when service responds 503 (kill-switch)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, 503))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()
    expect(wrapper.find('aside.kg-sidebar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders nothing and warns on network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()
    expect(wrapper.find('aside.kg-sidebar').exists()).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    wrapper.unmount()
    warnSpy.mockRestore()
  })

  it('renders four sections with the expected item counts on populated data', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(POPULATED))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()

    const aside = wrapper.find('aside.kg-sidebar')
    expect(aside.exists()).toBe(true)

    const sections = aside.findAll('section')
    expect(sections.length).toBe(4)

    // Headings: order matches spec (teaches, prerequisitesOf, sharedConcepts, whatToLearnNext)
    const headingTexts = sections.map(s => s.find('h3').text())
    expect(headingTexts[0]).toMatch(/teach/i)
    expect(headingTexts[1]).toMatch(/prerequisite/i)
    expect(headingTexts[2]).toMatch(/related concept|covering related/i)
    expect(headingTexts[3]).toMatch(/learn next/i)

    // Item counts per section
    expect(sections[0].findAll('li').length).toBe(POPULATED.teaches.length)
    expect(sections[1].findAll('li').length).toBe(POPULATED.prerequisitesOf.length)
    expect(sections[2].findAll('li').length).toBe(POPULATED.sharedConcepts.length)
    expect(sections[3].findAll('li').length).toBe(POPULATED.whatToLearnNext.length)

    wrapper.unmount()
  })

  it('emits kg.sidebar.click on item click with type + targetSlug', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(POPULATED))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()

    const sections = wrapper.findAll('aside.kg-sidebar section')
    // Second section is prerequisitesOf
    const link = sections[1].find('a')
    await link.trigger('click')

    const click = dispatchedEvents.find(e => e.type === 'kg.sidebar.click')
    expect(click).toBeDefined()
    expect(click!.detail.type).toBe('prerequisitesOf')
    expect(click!.detail.targetSlug).toBe('cap-first-service')
    expect(click!.detail.slug).toBe('cap-handlers')

    wrapper.unmount()
  })

  it('emits kg.sidebar.hover_concept on concept hover', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(POPULATED))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()

    const sections = wrapper.findAll('aside.kg-sidebar section')
    const firstConceptItem = sections[0].find('li')
    await firstConceptItem.trigger('mouseenter')

    const hover = dispatchedEvents.find(e => e.type === 'kg.sidebar.hover_concept')
    expect(hover).toBeDefined()
    expect(hover!.detail.slug).toBe('cap-handlers')
    expect(hover!.detail.conceptSlug).toBe('concept-cap-service-handlers')

    wrapper.unmount()
  })

  it('emits kg.sidebar.shown once when content renders', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(POPULATED))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()

    const shown = dispatchedEvents.filter(e => e.type === 'kg.sidebar.shown')
    expect(shown.length).toBe(1)
    expect(shown[0].detail.slug).toBe('cap-handlers')
    expect(shown[0].detail.sectionCounts).toEqual({
      teaches: 2,
      prerequisitesOf: 1,
      sharedConcepts: 2,
      whatToLearnNext: 1,
    })
    wrapper.unmount()
  })

  it('captures ETag from first fetch and sends If-None-Match on next fetch', async () => {
    // First mount: server returns ETag
    fetchMock.mockResolvedValueOnce(
      makeResponse(POPULATED, 200, { ETag: '"v1"' })
    )
    const w1 = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()
    w1.unmount()

    // Sanity: cache populated
    expect(sessionStorageStore['kg.sidebar.cap-handlers']).toBeDefined()

    // Second mount: should send If-None-Match. Server returns 304 → reuse prior data.
    fetchMock.mockResolvedValueOnce(makeResponse(null, 304))
    const w2 = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()

    // Second fetch carried If-None-Match
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit
    const headers = secondInit.headers as Record<string, string>
    expect(headers['If-None-Match']).toBe('"v1"')

    // Cached data was reused — sidebar rendered
    expect(w2.find('aside.kg-sidebar').exists()).toBe(true)
    w2.unmount()
  })

  it('does not fetch until IntersectionObserver fires (lazy-load)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(POPULATED))
    const wrapper = mount(RelatedGraph)
    // Allow onMounted microtasks to resolve
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(observeSpy).toHaveBeenCalledTimes(1)

    fireIntersect(true)
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Observer disconnects after first intersect (one-shot)
    expect(disconnectSpy).toHaveBeenCalled()
    wrapper.unmount()
  })

  // ── Skeleton loading state (KG widget UX polish) ─────────────────────
  // The skeleton aside renders between observer-fire and fetch-resolve so
  // readers see something while /graph/neighborhood is in flight. Pre-fire
  // the placeholder is still the 1 px anchor (the IO hasn't even armed
  // the fetch). Post-resolve the skeleton swaps for the real <aside> (or
  // collapses if the payload is empty / 503 / errored).

  it('renders the 1 px anchor BEFORE the observer fires (no skeleton yet)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(POPULATED))
    const wrapper = mount(RelatedGraph)
    await flushPromises()
    // No fetch yet, no skeleton yet — just the anchor.
    expect(wrapper.find('aside.kg-sidebar').exists()).toBe(false)
    expect(wrapper.find('aside.kg-sidebar--skeleton').exists()).toBe(false)
    expect(wrapper.find('div.kg-sidebar-anchor').exists()).toBe(true)
    wrapper.unmount()
  })

  it('renders the skeleton aside while the fetch is in flight', async () => {
    // Resolve fetch on the next tick so we can observe the in-flight state.
    let resolveFetch!: (r: Response) => void
    const pending = new Promise<Response>(r => { resolveFetch = r })
    fetchMock.mockReturnValueOnce(pending)

    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    // Microtask drain — fetchTriggered flips true, state stays 'loading'.
    await flushPromises()

    expect(wrapper.find('aside.kg-sidebar--skeleton').exists()).toBe(true)
    // The skeleton header carries the same H2 as the real widget so the
    // header doesn't pop in at swap time.
    const h2 = wrapper.find('aside.kg-sidebar--skeleton h2')
    expect(h2.exists()).toBe(true)
    expect(h2.text()).toMatch(/related learning/i)
    // Section structure mirrors SKELETON_SECTIONS=[3,5,5,5] = 18 rows total.
    expect(wrapper.findAll('aside.kg-sidebar--skeleton section').length).toBe(4)
    expect(wrapper.findAll('aside.kg-sidebar--skeleton li').length).toBe(3 + 5 + 5 + 5)
    // aria-busy is set so screen readers announce the loading state.
    expect(
      wrapper.find('aside.kg-sidebar--skeleton').attributes('aria-busy'),
    ).toBe('true')

    // Resolve the fetch — skeleton should swap for the real aside.
    resolveFetch(makeResponse(POPULATED))
    await flushPromises()
    expect(wrapper.find('aside.kg-sidebar--skeleton').exists()).toBe(false)
    expect(wrapper.find('aside.kg-sidebar:not(.kg-sidebar--skeleton)').exists()).toBe(true)
    wrapper.unmount()
  })

  it('collapses the skeleton to the 1 px anchor when the fetch returns empty', async () => {
    let resolveFetch!: (r: Response) => void
    const pending = new Promise<Response>(r => { resolveFetch = r })
    fetchMock.mockReturnValueOnce(pending)

    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()
    expect(wrapper.find('aside.kg-sidebar--skeleton').exists()).toBe(true)

    resolveFetch(makeResponse(EMPTY))
    await flushPromises()
    expect(wrapper.find('aside.kg-sidebar--skeleton').exists()).toBe(false)
    expect(wrapper.find('aside.kg-sidebar').exists()).toBe(false)
    expect(wrapper.find('div.kg-sidebar-anchor').exists()).toBe(true)
    wrapper.unmount()
  })

  it('collapses the skeleton to the 1 px anchor when the service returns 503', async () => {
    let resolveFetch!: (r: Response) => void
    const pending = new Promise<Response>(r => { resolveFetch = r })
    fetchMock.mockReturnValueOnce(pending)

    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()
    expect(wrapper.find('aside.kg-sidebar--skeleton').exists()).toBe(true)

    resolveFetch(makeResponse({}, 503))
    await flushPromises()
    expect(wrapper.find('aside.kg-sidebar--skeleton').exists()).toBe(false)
    expect(wrapper.find('aside.kg-sidebar').exists()).toBe(false)
    wrapper.unmount()
  })

  // ── Popover replaces native title= (item 4) ──────────────────────────
  // The KgReasonPopover child renders the link with NO `title=` attribute
  // — the per-link reason copy is now carried on the popover body, not
  // the native browser tooltip. Anchor still works as a link.

  it('does not set the native title= attribute on tutorial links', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(POPULATED))
    const wrapper = mount(RelatedGraph)
    fireIntersect(true)
    await flushPromises()
    const links = wrapper.findAll('aside.kg-sidebar a[href^="/tutorials/"]')
    expect(links.length).toBeGreaterThan(0)
    for (const a of links) {
      // No native tooltip — the popover carries the reason now.
      expect(a.attributes('title')).toBeUndefined()
    }
    wrapper.unmount()
  })
})
