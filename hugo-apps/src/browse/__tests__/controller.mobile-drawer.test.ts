// hugo-apps/src/browse/__tests__/controller.mobile-drawer.test.ts
//
// @vitest-environment happy-dom
//
// Covers the #216 mobile-filter-drawer wiring in controller.ts. Verifies:
//   - Filters button click moves #browse-filter-rail into <ui5-dialog>
//     and sets dialog.open = true
//   - dialog 'close' event re-parents the rail back to its original
//     position (so a desktop resize sees it where Hugo placed it)
//   - active-filter count badge updates from 0 → N as filters mutate,
//     and toggles `hidden` correctly
//
// Builds a minimal fixture DOM via createElement (no HTML-write property
// so the project's PreToolUse hook stays happy). The full BrowsePage
// hydration test lives in BrowsePage.hydration.test.ts; this file only
// exercises the controller's drawer block in isolation.

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
  // Clear any prior body content.
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild)
  }

  // Filter rail with one Type checkbox + Clear button.
  const railForm = el('form', { class: 'browse-filter-form' }, [
    el('fieldset', { class: 'browse-filter-group' }, [
      el('legend', {}, [document.createTextNode('Type')]),
      el('label', {}, [
        Object.assign(el('input'), { type: 'checkbox', name: 'type', value: 'mission' }),
        document.createTextNode(' Mission'),
      ]),
    ]),
    Object.assign(el('button', {
      type: 'button',
      class: 'browse-filter-clear',
      'data-action': 'clear-filters',
    }), { textContent: 'Clear all' }),
  ])
  const rail = el('aside', { id: 'browse-filter-rail' }, [railForm])

  // Grid header: Filters toggle + title + sort.
  const countBadge = el('span', { class: 'browse-filter-toggle__count', hidden: '' })
  const filterToggle = el('button', {
    type: 'button',
    class: 'browse-filter-toggle',
    id: 'browse-filter-toggle',
    'aria-expanded': 'false',
    'aria-controls': 'browse-filter-drawer',
  }, [
    document.createTextNode('Filters '),
    countBadge,
  ])
  const sortSelect = el('select', { class: 'browse-sort__select', name: 'sort' }, [
    Object.assign(el('option'), { value: 'relevance', textContent: 'Relevance' }),
  ])
  const gridHeader = el('header', { class: 'browse-grid-header' }, [
    filterToggle,
    el('h2', { class: 'browse-grid-title' }, [document.createTextNode('All 100 items')]),
    el('label', { class: 'browse-sort' }, [sortSelect]),
  ])

  // Banner search input.
  const searchInput = Object.assign(
    el('input', { class: 'browse-banner__search', type: 'search' }),
    { value: '' }
  )

  // The mobile drawer.
  const drawer = el('ui5-dialog', { id: 'browse-filter-drawer', stretch: '' })

  // Original parent for the rail (mimics Hugo's <div class="browse-shell">).
  const shell = el('div', { class: 'browse-shell' }, [
    rail,
    el('main', { id: 'browse-results' }, [gridHeader]),
  ])

  document.body.appendChild(searchInput)
  document.body.appendChild(shell)
  document.body.appendChild(drawer)

  return { rail, drawer, filterToggle, countBadge, gridHeader, shell, searchInput }
}

interface MinimalFiltersApi {
  searchQuery: ReturnType<typeof ref<string>>
  filters: ReturnType<typeof reactive<{
    levels: string[]
    types: string[]
    products: string[]
    topics: string[]
    categories: string[]
    isNew: boolean
    noLicense: boolean
  }>>
  displayedTotalCount: ReturnType<typeof ref<number>>
  hasActiveFilters: ReturnType<typeof ref<boolean>>
  goToPage: (n: number) => void
  clearFilters: () => void
}

function makeFiltersApi(): MinimalFiltersApi {
  const searchQuery = ref('')
  const filters = reactive({
    levels: [] as string[],
    types: [] as string[],
    products: [] as string[],
    topics: [] as string[],
    categories: [] as string[],
    isNew: false,
    noLicense: false,
  })
  const displayedTotalCount = ref(100)
  const hasActiveFilters = ref(false)
  return {
    searchQuery,
    filters,
    displayedTotalCount,
    hasActiveFilters,
    goToPage: vi.fn(),
    clearFilters: () => {
      filters.levels.splice(0)
      filters.types.splice(0)
      filters.products.splice(0)
      filters.topics.splice(0)
      filters.categories.splice(0)
      filters.isNew = false
      filters.noLicense = false
      searchQuery.value = ''
    },
  }
}

describe('mobile filter drawer (#216)', () => {
  let dom: ReturnType<typeof buildFixtureDom>
  let api: MinimalFiltersApi
  let sort: ReturnType<typeof ref<Sort>>
  let railsHidden: ReturnType<typeof ref<boolean>>

  beforeEach(() => {
    dom = buildFixtureDom()
    api = makeFiltersApi()
    sort = ref<Sort>('relevance')
    railsHidden = ref(false)
    wireBrowseController({
      filters: api as any,
      sort,
      railsHidden,
    })
  })

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild)
    }
  })

  it('Filters click moves rail into the dialog and opens it', () => {
    expect(dom.rail.parentElement).toBe(dom.shell)
    expect((dom.drawer as any).open).toBeFalsy()

    dom.filterToggle.click()

    expect(dom.rail.parentElement).toBe(dom.drawer)
    expect((dom.drawer as any).open).toBe(true)
    expect(dom.filterToggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('dialog close event returns rail to original parent', () => {
    dom.filterToggle.click()
    expect(dom.rail.parentElement).toBe(dom.drawer)

    dom.drawer.dispatchEvent(new Event('close'))

    expect(dom.rail.parentElement).toBe(dom.shell)
    expect(dom.filterToggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('count badge is hidden when no filters are active', () => {
    expect(dom.countBadge.hidden).toBe(true)
    expect(dom.countBadge.textContent).toBe('')
  })

  it('count badge shows N when N filters are active', async () => {
    api.filters.types.push('mission')
    api.filters.levels.push('beginner')
    api.filters.isNew = true
    // Vue reactive watchers run synchronously after mutation in tests.
    await new Promise(r => setTimeout(r, 0))

    expect(dom.countBadge.hidden).toBe(false)
    expect(dom.countBadge.textContent).toBe('3')
  })

  it('count badge clears back to hidden when filters are removed', async () => {
    api.filters.types.push('mission')
    await new Promise(r => setTimeout(r, 0))
    expect(dom.countBadge.textContent).toBe('1')

    api.filters.types.splice(0)
    await new Promise(r => setTimeout(r, 0))
    expect(dom.countBadge.hidden).toBe(true)
    expect(dom.countBadge.textContent).toBe('')
  })

  it('count badge counts searchQuery as one filter', async () => {
    api.searchQuery.value = 'cap'
    await new Promise(r => setTimeout(r, 0))
    expect(dom.countBadge.textContent).toBe('1')
    expect(dom.countBadge.hidden).toBe(false)
  })

  it('moves the rail back even after multiple open/close cycles', () => {
    dom.filterToggle.click()
    dom.drawer.dispatchEvent(new Event('close'))
    dom.filterToggle.click()
    dom.drawer.dispatchEvent(new Event('close'))
    expect(dom.rail.parentElement).toBe(dom.shell)
  })

  it('checkbox state inside the drawer is still wired (Light DOM)', async () => {
    dom.filterToggle.click()
    // After move, the type checkbox is now inside the dialog.
    const cb = dom.drawer.querySelector<HTMLInputElement>('input[name="type"][value="mission"]')
    expect(cb).toBeTruthy()
    cb!.checked = true
    cb!.dispatchEvent(new Event('change'))
    await new Promise(r => setTimeout(r, 0))
    expect(api.filters.types).toContain('mission')
  })
})
