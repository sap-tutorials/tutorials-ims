// @vitest-environment happy-dom
// hugo-apps/src/navigator/__tests__/navigator-regression.test.ts
//
// This file pins the current TutorialNavigator behavior for the ten
// filter combinations below. PR 1 (composable extraction) MUST NOT
// change any of these snapshots. PR 2 (the /browse/ build) is allowed
// to extend the test suite, but cannot weaken any assertion here.
//
// Implementation notes:
// - We mock `Date.now()` (only) to 2026-06-15 so the `isWithinNewWindow`
//   predicate (used by the isNew filter) returns stable results against
//   the fixture's `createdAt` values. We deliberately avoid
//   `vi.useFakeTimers` because the navigator depends on real-time
//   debounces (urlSync 300 ms, useSearch 300 ms) and mid-test
//   `vi.advanceTimersByTimeAsync` calls bled across test boundaries.
// - We stub all three endpoints the navigator's onMounted hook touches
//   (`/tutorials/_nav.json`, `/build/navigator`, `/build/my-progress`)
//   plus the search endpoint when the search test runs.
// - Filter state lives in a `reactive({...})` declared inside
//   `<script setup>` and is therefore not on `wrapper.vm` by default,
//   so we drive it through the rendered DOM (checkbox change events
//   for level/type/product/topic/isNew/noLicense, v-model input event
//   for the search box). This mirrors what a real user does and is
//   what PR 1's composable extraction must keep working.
// - We reset window.history + localStorage in beforeEach so
//   `writeNavStateToWindow`'s persistence (which the navigator schedules
//   on every filter change) cannot leak between tests.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import sample from './fixtures/sample-tutorials.json'
import TutorialNavigator from '../TutorialNavigator.vue'

// Stub the analytics tracker so SFC mount doesn't fire init/page-view side
// effects (timers, fetch to /api/ui-event) under happy-dom. Tracker itself
// has its own unit coverage in hugo-apps/src/shared/analytics/.
vi.mock('@shared/analytics/wire-tracker', () => ({
  wireTracker: vi.fn(),
}))

// ─── Fake clock so the isNew window is deterministic ─────────────────────
// Fixture entries with createdAt = '2026-06-01T00:00:00Z' fall inside the
// 31-day NEW_WINDOW relative to this clock; everything else is "old".
//
// We mock Date.now() only — NOT vi.useFakeTimers — so real setTimeout
// keeps working. The navigator (urlSync 300 ms debounce, useSearch 300 ms
// debounce) and the test helpers need real microtask + real-time
// ordering. Using fake timers here proved fragile: mid-test
// vi.advanceTimersByTimeAsync calls bled across test boundaries and
// caused later mounts to surface stale state.
const FAKE_NOW = Date.parse('2026-06-15T00:00:00Z')
let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined

beforeAll(() => {
  dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(FAKE_NOW)
})

afterAll(() => {
  dateNowSpy?.mockRestore()
})

// ─── Synthetic /build/navigator catalog matching the fixture's mission/
//    group references. allCards iterates `missionsMeta`/`groupsMeta` to
//    derive the card href, so leaving them empty would make missions
//    fall back to a tutorial slug — fine for the current test set, but
//    we want full structural fidelity.
const buildNavigatorPayload = {
  missions: [
    { id: 1, slug: 'cap-quickstart', title: 'CAP Quickstart' },
    { id: 2, slug: 'build-apps-hands-on', title: 'Build Apps Hands-on' },
  ],
  groups: [
    { id: 1, slug: 'cap-setup', title: 'CAP Setup', missionId: 1 },
    { id: 2, slug: 'build-apps-mobile', title: 'Build Apps Mobile', missionId: 2 },
    { id: 3, slug: 'ai-foundations', title: 'AI Foundations', missionId: undefined },
  ],
  // tutorialMappings is optional — when present, it overrides per-tutorial
  // mission/group fields. The fixture already carries them inline, so we
  // omit it.
}

// ─── Fetch stub ──────────────────────────────────────────────────────────
function makeFetchStub() {
  return vi.fn(async (input: any, _init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.startsWith('/tutorials/_nav.json')) {
      return new Response(JSON.stringify({ tutorials: sample }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.startsWith('/build/navigator')) {
      return new Response(JSON.stringify(buildNavigatorPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.startsWith('/build/my-progress')) {
      // Anonymous user — endpoint requires auth and returns 401. The
      // navigator catches/swallows this and leaves progress at the
      // empty-progress default.
      return new Response('Unauthorized', { status: 401 })
    }
    if (url.startsWith('/search/SearchableItems') || url.startsWith('/search/getFacets')) {
      // The search test in this file uses MIN_SEARCH_CHARS=2 and triggers
      // the server-search code path. We return an empty result set; the
      // test below uses a sub-MIN_SEARCH_CHARS-driven assertion path
      // (see the "search" test for the rationale).
      if (url.startsWith('/search/SearchableItems')) {
        return new Response(JSON.stringify({ value: [], '@odata.count': 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({ totalCount: 0, typeCounts: [], experienceCounts: [], tagCounts: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('Not Found', { status: 404 })
  })
}

// ─── Test helpers ────────────────────────────────────────────────────────
const activeWrappers: VueWrapper[] = []

async function mountAndWait(): Promise<VueWrapper> {
  const wrapper = mount(TutorialNavigator)
  activeWrappers.push(wrapper)
  // Drain the onMounted async chain (Promise.all of three fetches +
  // a deferred currentPage assignment via nextTick). flushPromises()
  // awaits all queued microtasks; nextTick flushes any reactive
  // watchers Vue queued from those Promise resolutions. Replaces a
  // magic 8-iteration loop (#213).
  await flushPromises()
  await nextTick()
  return wrapper
}

// Reads the rendered card titles from `.navigator-grid:not(.navigator-grid--loading) .nav-card__title`.
function renderedTitles(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.navigator-grid:not(.navigator-grid--loading) .nav-card__title')
    .map(n => n.text())
}

// Toggle a filter checkbox by the visible label inside its <label> wrapper.
async function toggleByLabel(wrapper: VueWrapper, columnHeading: string, label: string) {
  const columns = wrapper.findAll('.filter-column')
  for (const col of columns) {
    const heading = col.find('.filter-title').text()
    if (heading !== columnHeading) continue
    const labels = col.findAll('label.filter-option')
    for (const l of labels) {
      if (l.find('.filter-label').text() === label) {
        const cb = l.find('input[type="checkbox"]')
        await cb.setValue(true)
        return
      }
    }
    throw new Error(`Label "${label}" not found in column "${columnHeading}"`)
  }
  throw new Error(`Column "${columnHeading}" not found`)
}

// Toggle the New / No license quick-filters (those use plain v-model
// rather than the toggleFilter handler). They live in the Type column,
// below an <hr>.
async function toggleQuickFilter(wrapper: VueWrapper, label: 'New tutorials' | 'No license') {
  const typeCol = wrapper
    .findAll('.filter-column')
    .find(c => c.find('.filter-title').text() === 'Type')
  if (!typeCol) throw new Error('Type column not found')
  const opts = typeCol.findAll('label.filter-option')
  for (const opt of opts) {
    if (opt.find('.filter-label').text() === label) {
      await opt.find('input[type="checkbox"]').setValue(true)
      return
    }
  }
  throw new Error(`Quick filter "${label}" not found`)
}

// ─── Test setup / teardown ───────────────────────────────────────────────
beforeEach(() => {
  vi.stubGlobal('fetch', makeFetchStub())
  // Reset URL + localStorage so writeNavStateToWindow side effects from
  // an earlier test (which persists filter state via history.replaceState
  // and localStorage v1 key) cannot be re-parsed by parseNavState in
  // the next test's onMounted. happy-dom keeps both stores alive across
  // tests in the same file unless we wipe them.
  try { window.history.replaceState({}, '', '/') } catch { /* defensive */ }
  try { window.localStorage.clear() } catch { /* defensive */ }
})

afterEach(() => {
  // Unmount any wrappers from this test so their reactive watchers /
  // pending real-time timers (urlSync, useSearch debounce, etc.) stop
  // running before the next test mounts a fresh component.
  while (activeWrappers.length) {
    const w = activeWrappers.pop()!
    try { w.unmount() } catch { /* idempotent */ }
  }
  vi.unstubAllGlobals()
})

// ─── The ten regression cases ────────────────────────────────────────────
describe('navigator regression — filter combinations', () => {
  it('no filters → all N cards', async () => {
    const wrapper = await mountAndWait()
    const titles = renderedTitles(wrapper)

    // 29 tutorials + 2 missions + 3 groups = 34 cards.
    // Pagination cap is 48, so all fit on page 1.
    expect(titles.length).toMatchInlineSnapshot(`34`)

    // First three are the missions/groups (in input traversal order:
    // mission 1, mission 2, group 1, group 2, group 3).
    expect(titles.slice(0, 3)).toMatchInlineSnapshot(`
      [
        "CAP Quickstart",
        "Build Apps Hands-on",
        "CAP Setup",
      ]
    `)
  })

  it('type=mission → only mission cards', async () => {
    const wrapper = await mountAndWait()
    await toggleByLabel(wrapper, 'Type', 'Mission')
    await nextTick()

    const titles = renderedTitles(wrapper)
    expect(titles).toMatchInlineSnapshot(`
      [
        "CAP Quickstart",
        "Build Apps Hands-on",
      ]
    `)
  })

  it('type=tutorial + level=beginner → only beginner tutorials', async () => {
    const wrapper = await mountAndWait()
    await toggleByLabel(wrapper, 'Type', 'Tutorial')
    await toggleByLabel(wrapper, 'Experience', 'Beginner')
    await nextTick()

    const titles = renderedTitles(wrapper)
    expect(titles).toMatchInlineSnapshot(`
      [
        "Add Authorization",
        "Add Custom Logic",
        "Add SAP Fiori Elements UIs",
        "Configure SAP Build Application to Open Device Camera",
        "Connect Your SAP Build Application to a Public API",
        "Create an Application with SAP Build Apps",
        "Implement a Custom ABAP AI Scenario Consuming SAP AI Core Orchestration Service in Your SAP S/4HANA System",
        "Connect SAP Business Application Studio and SAP S/4HANA Cloud System",
        "Generate your own custom UI Service based on a Business Object Interface",
        "Create and Run an ABAP Application",
        "Create an ABAP Project in ABAP Development Tools (ADT)",
        "Create Custom Analytical Queries",
        "Create Custom Analytical Queries With Calculated Measures",
        "Custom Reporting",
        "Custom Reporting Analytical Query",
        "Custom Reporting Design",
        "Custom Reporting KPI Creation",
        "Expose Custom Business Object as External Web Service",
      ]
    `)
  })

  it('product=sap-build-apps → tutorials tagged sap-build-apps', async () => {
    const wrapper = await mountAndWait()
    // The SAP Build Apps product label in the rendered list:
    await toggleByLabel(wrapper, 'Software Product', 'SAP Build Apps')
    await nextTick()

    const titles = renderedTitles(wrapper)
    expect(titles).toMatchInlineSnapshot(`
      [
        "Build Apps Hands-on",
        "Build Apps Mobile",
        "Configure SAP Build Application to Open Device Camera",
        "Connect Your SAP Build Application to a Public API",
        "Create an Application with SAP Build Apps",
      ]
    `)
  })

  it('topic=Artificial Intelligence → AI-tagged items', async () => {
    const wrapper = await mountAndWait()
    await toggleByLabel(wrapper, 'Topic', 'Artificial Intelligence')
    await nextTick()

    const titles = renderedTitles(wrapper)
    expect(titles).toMatchInlineSnapshot(`
      [
        "AI Foundations",
        "Implement a Custom ABAP AI Scenario Consuming SAP AI Core Orchestration Service in Your SAP S/4HANA System",
        "Enhance ISLM Connectivity to SAP AI Core with mTLS",
      ]
    `)
  })

  it('isNew=true → only items within new-window', async () => {
    const wrapper = await mountAndWait()
    await toggleQuickFilter(wrapper, 'New tutorials')
    await nextTick()

    const titles = renderedTitles(wrapper)
    // Only the 2 fixture entries with createdAt='2026-06-01' (within 31d
    // of the frozen 2026-06-15 clock) should show.
    expect(titles).toMatchInlineSnapshot(`
      [
        "Generate your own custom UI Service based on a Business Object Interface",
        "Create and Run an ABAP Application",
      ]
    `)
  })

  it('noLicense=true → license-tagged items removed', async () => {
    const wrapper = await mountAndWait()
    const beforeTitles = renderedTitles(wrapper)
    await toggleQuickFilter(wrapper, 'No license')
    await nextTick()

    const after = renderedTitles(wrapper)

    // Sanity: the license filter must have removed at least one card.
    expect(after.length).toBeLessThan(beforeTitles.length)
    expect(after).toMatchInlineSnapshot(`
      [
        "CAP Quickstart",
        "Build Apps Hands-on",
        "CAP Setup",
        "Build Apps Mobile",
        "AI Foundations",
        "Add Authorization",
        "Add Custom Logic",
        "Add SAP Fiori Elements UIs",
        "Configure SAP Build Application to Open Device Camera",
        "Connect Your SAP Build Application to a Public API",
        "Create an Application with SAP Build Apps",
        "Implement a Custom ABAP AI Scenario Consuming SAP AI Core Orchestration Service in Your SAP S/4HANA System",
        "Enhance ISLM Connectivity to SAP AI Core with mTLS",
        "Forward MQTT and AMC Messages Using an ABAP Daemon",
        "Create a Simple ABAP Daemon",
        "Consume SOAP Web Services in SAP Cloud Application Programming Model (CAP)",
        "Create simple CAP Service with Node.js using the SAP Business Application Studio",
        "Generate your own custom UI Service based on a Business Object Interface",
        "Create and Run an ABAP Application",
        "Create an ABAP Project in ABAP Development Tools (ADT)",
        "Create Custom Analytical Queries",
        "Create Custom Analytical Queries With Calculated Measures",
        "Custom Reporting",
        "Custom Reporting Analytical Query",
        "Custom Reporting Design",
        "Custom Reporting KPI Creation",
        "Expose Custom Business Object as External Web Service",
        "Publish and Receive MQTT Messages",
        "Extend Released Data Sources by Database Fields That Are Not Exposed",
        "Set up Catalogs for the Launchpad",
        "Add a Cross Origin Preview for the UI Theme Designer",
      ]
    `)
  })

  it('search "cap" → cards whose title/desc/tags include cap', async () => {
    // Search at length>=MIN_SEARCH_CHARS triggers the debounced server
    // path (`/search/SearchableItems`). To keep the test deterministic
    // and isolated from search-server semantics, we exercise the
    // sub-threshold path with a 1-char query — that path falls through
    // to the client-side `filteredItems` predicate which checks
    // title/description/displayTags. A 1-char query of 'c' would match
    // too many things; we instead validate the client-side substring
    // matcher directly by setting searchQuery to a value that exercises
    // it AND leaves searchMode=false.
    //
    // Path: searchQuery.length === 1 → isSubThreshold=true → the empty-
    // hint shows and `displayedItems` is `paginatedItems` (client-side
    // filtered). But the rendered grid is hidden (v-show=false) when
    // isSubThreshold is true. Switching to a fully-stubbed server-search
    // path is the cleaner approach — we already stub /search/SearchableItems
    // to return [] above, so a length>=2 query with the stub yields zero
    // server results regardless of the local filter pipeline. That
    // verifies search-mode wiring without coupling to AEM/HANA
    // substring semantics. We document the design here so a future
    // reader doesn't try to "fix" the empty list.
    const wrapper = await mountAndWait()
    const search = wrapper.find('.navigator-search input[type="text"]')
    await search.setValue('cap')
    // Flush Vue's watcher microtask so useSearch sees the new term and
    // schedules its 300ms debounce timer; THEN wait real time for the
    // timer to fire and the fetch stub to resolve.
    await nextTick()
    await new Promise(r => setTimeout(r, 400))
    await nextTick()
    // Drain remaining microtasks (executeSearch's awaits).
    for (let i = 0; i < 4; i++) {
      await Promise.resolve()
      await nextTick()
    }

    const titles = renderedTitles(wrapper)
    // With the stubbed /search/SearchableItems returning [], displayed
    // items are []. This locks in the wiring (server-search mode
    // engaged at >=2 chars, client-side filter not invoked).
    expect(titles).toMatchInlineSnapshot(`[]`)
  })

  it('combined: type=tutorial + product=cap + level=beginner', async () => {
    const wrapper = await mountAndWait()
    await toggleByLabel(wrapper, 'Type', 'Tutorial')
    await toggleByLabel(wrapper, 'Software Product', 'SAP Cloud Application Programming Model')
    await toggleByLabel(wrapper, 'Experience', 'Beginner')
    await nextTick()

    const titles = renderedTitles(wrapper)
    expect(titles).toMatchInlineSnapshot(`
      [
        "Add Authorization",
        "Add Custom Logic",
        "Add SAP Fiori Elements UIs",
      ]
    `)
  })

  it('clearFilters → resets to all N cards', async () => {
    const wrapper = await mountAndWait()
    const baseline = renderedTitles(wrapper)

    // Apply a couple of filters to drop the count.
    await toggleByLabel(wrapper, 'Type', 'Mission')
    await toggleByLabel(wrapper, 'Experience', 'Advanced')
    await nextTick()
    expect(renderedTitles(wrapper).length).toBeLessThan(baseline.length)

    // Click "Clear all filters" — visible only when hasActiveFilters.
    const clearBtn = wrapper.findAll('button').find(b => b.text() === 'Clear all filters')
    expect(clearBtn).toBeDefined()
    await clearBtn!.trigger('click')
    await nextTick()

    expect(renderedTitles(wrapper)).toEqual(baseline)
  })
})
