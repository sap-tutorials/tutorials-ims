// hugo-apps/src/browse/__tests__/controller.rail-controls.test.ts
//
// @vitest-environment happy-dom
//
// Covers the per-rail collapse + Customize popover wiring in
// controller.ts (#285). Verifies:
//   - On first paint with no localStorage, rails render expanded + visible.
//   - Chevron click toggles [data-collapsed] on the parent <section>,
//     toggles aria-expanded on the button, and persists to localStorage.
//   - Customize popover checkbox un-check sets [data-rail-hidden] on the
//     matching rail and persists; re-check clears it.
//   - On wire-up, persisted prefs (collapsed:true, visible:false) are
//     applied to the DOM before any user interaction.
//
// Builds a minimal fixture DOM in createElement-only style. Avoids
// importing wireBrowseController's filter wiring (this test is scoped
// to the rail-controls subset; full controller integration is exercised
// elsewhere).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, reactive } from 'vue'
import { wireBrowseController } from '../controller'
import type { Sort } from '../browseUrl'

function el<T extends HTMLElement = HTMLElement>(
  tag: string,
  attrs: Record<string, string> = {},
  children: Node[] = []
): T {
  const node = document.createElement(tag) as T
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) node.appendChild(c)
  return node
}

function buildFixtureDom() {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)

  // Two rails: featured + recent. Each with a chevron toggle button.
  function makeRail(id: string, title: string): HTMLElement {
    const toggleBtn = el('button', {
      type: 'button',
      class: 'browse-rail__toggle',
      'aria-expanded': 'true',
      'aria-controls': `browse-rail-content-${id}`,
      'data-action': 'toggle-rail',
    }, [
      el('span', { class: 'browse-rail__chevron', 'aria-hidden': 'true' }, [
        document.createTextNode('▾'),
      ]),
      el('h2', { class: 'browse-rail__title' }, [document.createTextNode(title)]),
    ])
    const header = el('header', { class: 'browse-rail__header' }, [toggleBtn])
    const cards = el('div', { class: 'browse-rail-curation', id: `browse-rail-content-${id}` })
    return el('section', {
      class: 'browse-rail',
      'data-rail': '',
      'data-rail-id': id,
    }, [header, cards])
  }

  const railsContainer = el('div', { 'data-rails-container': '' }, [
    makeRail('featured', 'Featured missions'),
    makeRail('recent', 'Recently added'),
  ])

  // Customize button + popover.
  const customizeBtn = el('button', {
    type: 'button',
    class: 'browse-customize-toggle',
    id: 'browse-customize-toggle',
    'aria-expanded': 'false',
    'aria-controls': 'browse-customize-popover',
  }, [document.createTextNode('Customize')])

  const popoverFeatured = Object.assign(
    el('input'),
    { type: 'checkbox', name: 'rail-visible', value: 'featured', checked: true },
  )
  const popoverRecent = Object.assign(
    el('input'),
    { type: 'checkbox', name: 'rail-visible', value: 'recent', checked: true },
  )
  const popoverBody = el('div', { class: 'browse-customize-popover__body' }, [
    el('label', {}, [popoverFeatured, document.createTextNode(' Featured missions')]),
    el('label', {}, [popoverRecent, document.createTextNode(' Recently added')]),
  ])
  const popover = el('ui5-popover', {
    id: 'browse-customize-popover',
    placement: 'Bottom',
    'horizontal-align': 'End',
  }, [popoverBody])

  // Filter rail + grid header — minimal stubs so wireBrowseController
  // doesn't bail out before reaching wireRailControls().
  const rail = el('aside', { id: 'browse-filter-rail' }, [
    el('form', { class: 'browse-filter-form' }, [
      Object.assign(el('button', {
        type: 'button',
        class: 'browse-filter-clear',
        'data-action': 'clear-filters',
      }), { textContent: 'Clear all' }),
    ]),
  ])
  const drawer = el('ui5-dialog', { id: 'browse-filter-drawer', stretch: '' })
  const filterToggle = el('button', {
    type: 'button',
    class: 'browse-filter-toggle',
    id: 'browse-filter-toggle',
    'aria-expanded': 'false',
    'aria-controls': 'browse-filter-drawer',
  })
  const gridHeader = el('header', { class: 'browse-grid-header' }, [
    filterToggle,
    el('h2', { class: 'browse-grid-title' }),
    customizeBtn,
  ])

  document.body.appendChild(railsContainer)
  document.body.appendChild(rail)
  document.body.appendChild(gridHeader)
  document.body.appendChild(popover)
  document.body.appendChild(drawer)

  return {
    railsContainer,
    railFeatured: railsContainer.querySelector<HTMLElement>('[data-rail-id="featured"]')!,
    railRecent: railsContainer.querySelector<HTMLElement>('[data-rail-id="recent"]')!,
    chevronFeatured: railsContainer.querySelector<HTMLButtonElement>(
      '[data-rail-id="featured"] [data-action="toggle-rail"]',
    )!,
    customizeBtn,
    popover,
    popoverFeatured,
    popoverRecent,
  }
}

interface MinimalFiltersApi {
  searchQuery: ReturnType<typeof ref<string>>
  filters: ReturnType<typeof reactive<{
    levels: string[]; types: string[]; products: string[]; topics: string[]
    isNew: boolean; noLicense: boolean
  }>>
  displayedTotalCount: ReturnType<typeof ref<number>>
  hasActiveFilters: ReturnType<typeof ref<boolean>>
  goToPage: (n: number) => void
  clearFilters: () => void
}
function makeFiltersApi(): MinimalFiltersApi {
  const filters = reactive({
    levels: [] as string[], types: [] as string[],
    products: [] as string[], topics: [] as string[],
    isNew: false, noLicense: false,
  })
  return {
    searchQuery: ref(''),
    filters,
    displayedTotalCount: ref(100),
    hasActiveFilters: ref(false),
    goToPage: vi.fn(),
    clearFilters: () => {
      filters.levels.splice(0); filters.types.splice(0)
      filters.products.splice(0); filters.topics.splice(0)
      filters.isNew = false; filters.noLicense = false
    },
  }
}

const LS_KEY = 'browse.rails.v1'

describe('per-rail controls (#285)', () => {
  let dom: ReturnType<typeof buildFixtureDom>

  beforeEach(() => {
    localStorage.clear()
    dom = buildFixtureDom()
  })

  afterEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
    localStorage.clear()
  })

  function wire() {
    wireBrowseController({
      filters: makeFiltersApi() as any,
      sort: ref<Sort>('relevance'),
      railsHidden: ref(false),
    })
  }

  it('chevron click sets [data-collapsed] and persists to localStorage', () => {
    wire()
    expect(dom.railFeatured.hasAttribute('data-collapsed')).toBe(false)
    expect(dom.chevronFeatured.getAttribute('aria-expanded')).toBe('true')

    dom.chevronFeatured.click()

    expect(dom.railFeatured.hasAttribute('data-collapsed')).toBe(true)
    expect(dom.chevronFeatured.getAttribute('aria-expanded')).toBe('false')
    const stored = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(stored.collapsed?.featured).toBe(true)

    // Toggle back.
    dom.chevronFeatured.click()
    expect(dom.railFeatured.hasAttribute('data-collapsed')).toBe(false)
    expect(dom.chevronFeatured.getAttribute('aria-expanded')).toBe('true')
    const stored2 = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(stored2.collapsed?.featured).toBe(false)
  })

  it('persisted [collapsed.featured=true] is applied on wire-up before any click', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ collapsed: { featured: true } }))
    wire()
    expect(dom.railFeatured.hasAttribute('data-collapsed')).toBe(true)
    expect(dom.chevronFeatured.getAttribute('aria-expanded')).toBe('false')
    // The recent rail keeps its default expanded state.
    expect(dom.railRecent.hasAttribute('data-collapsed')).toBe(false)
  })

  it('Customize popover un-check sets [data-rail-hidden] and persists; re-check clears it', () => {
    wire()
    expect(dom.railFeatured.hasAttribute('data-rail-hidden')).toBe(false)

    dom.popoverFeatured.checked = false
    dom.popoverFeatured.dispatchEvent(new Event('change'))

    expect(dom.railFeatured.hasAttribute('data-rail-hidden')).toBe(true)
    const stored = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(stored.visible?.featured).toBe(false)

    dom.popoverFeatured.checked = true
    dom.popoverFeatured.dispatchEvent(new Event('change'))

    expect(dom.railFeatured.hasAttribute('data-rail-hidden')).toBe(false)
    const stored2 = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(stored2.visible?.featured).toBe(true)
  })

  it('persisted [visible.recent=false] hides the recent rail on wire-up', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ visible: { recent: false } }))
    wire()
    expect(dom.railRecent.hasAttribute('data-rail-hidden')).toBe(true)
    expect(dom.popoverRecent.checked).toBe(false)
    // featured remains visible.
    expect(dom.railFeatured.hasAttribute('data-rail-hidden')).toBe(false)
    expect(dom.popoverFeatured.checked).toBe(true)
  })

  it('Customize button click opens the popover and updates aria-expanded', () => {
    wire()
    expect(dom.customizeBtn.getAttribute('aria-expanded')).toBe('false')

    dom.customizeBtn.click()

    expect(dom.customizeBtn.getAttribute('aria-expanded')).toBe('true')
    // ui5-popover open API: opener is set, open is true (read via the
    // property setter — happy-dom stores it on the element).
    expect((dom.popover as any).open).toBe(true)
    expect((dom.popover as any).opener).toBe(dom.customizeBtn)

    // Simulate the popover's 'close' event (Esc / backdrop / open=false).
    dom.popover.dispatchEvent(new Event('close'))
    expect(dom.customizeBtn.getAttribute('aria-expanded')).toBe('false')
  })

  it('handles a corrupted localStorage entry gracefully (defaults to expanded + visible)', () => {
    localStorage.setItem(LS_KEY, '{not json')
    wire()
    expect(dom.railFeatured.hasAttribute('data-collapsed')).toBe(false)
    expect(dom.railFeatured.hasAttribute('data-rail-hidden')).toBe(false)
    expect(dom.railRecent.hasAttribute('data-collapsed')).toBe(false)
    expect(dom.railRecent.hasAttribute('data-rail-hidden')).toBe(false)
  })
})
