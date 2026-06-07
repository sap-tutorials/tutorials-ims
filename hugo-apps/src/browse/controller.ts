// hugo-apps/src/browse/controller.ts
//
// Wires SSR'd DOM controls to the shared useNavigatorFilters state.
// Pairs with BrowsePage.vue (Path C architecture): Vue owns the grid;
// plain DOM event listeners own everything else (filter rail, search,
// sort, pagination, clear-all, rails fade, grid title count).
//
// Why this is a separate module: BrowsePage's Vue tree only covers
// #browse-root. The filter rail (#browse-filter-rail), sort dropdown,
// search input, pagination, and rails container are SSR'd by Hugo and
// live OUTSIDE the Vue mount point. Direct DOM wiring is the simplest
// way to keep them in sync with the shared reactive state without
// requiring full-page hydration parity.

import { watch, type Ref } from 'vue'
import type { Sort } from './browseUrl'
import type { useNavigatorFilters } from '@shared/composables/useNavigatorFilters'

type FiltersApi = ReturnType<typeof useNavigatorFilters>

interface ControllerOpts {
  filters: FiltersApi
  sort: Ref<Sort>
  railsHidden: Ref<boolean>
}

export function wireBrowseController(opts: ControllerOpts) {
  const { filters, sort, railsHidden } = opts

  // ── Filter rail checkboxes (Type, Level, Quick filters) ──────────────
  // Use splice/in-place mutation on the reactive arrays so reactivity
  // fires (matches the toggleFilter pattern in TutorialNavigator.vue).
  function toggleArr(arr: string[], value: string, on: boolean) {
    const idx = arr.indexOf(value)
    if (on && idx < 0) arr.push(value)
    else if (!on && idx >= 0) arr.splice(idx, 1)
  }

  document.querySelectorAll<HTMLInputElement>(
    '#browse-filter-rail input[type="checkbox"]'
  ).forEach(cb => {
    cb.addEventListener('change', () => {
      const name = cb.name
      const value = cb.value
      if (name === 'type')        toggleArr(filters.filters.types, value, cb.checked)
      else if (name === 'level')  toggleArr(filters.filters.levels, value, cb.checked)
      else if (name === 'new')    filters.filters.isNew = cb.checked
      else if (name === 'noLicense') filters.filters.noLicense = cb.checked
    })
  })

  // Sync SSR'd checkbox checked state from current filter state. After
  // useNavigatorFilters' onMounted restores from URL, the checkboxes need
  // to reflect that state. Watch runs immediately (avoiding race with
  // useNavigatorFilters' nextTick-deferred URL restore) AND on subsequent
  // state changes (e.g. clear-all from elsewhere).
  function syncCheckboxesFromState() {
    document.querySelectorAll<HTMLInputElement>(
      '#browse-filter-rail input[type="checkbox"]'
    ).forEach(cb => {
      const name = cb.name
      const value = cb.value
      if (name === 'type')           cb.checked = filters.filters.types.includes(value)
      else if (name === 'level')     cb.checked = filters.filters.levels.includes(value)
      else if (name === 'new')       cb.checked = filters.filters.isNew
      else if (name === 'noLicense') cb.checked = filters.filters.noLicense
    })
  }
  watch(
    [
      () => filters.filters.types,
      () => filters.filters.levels,
      () => filters.filters.isNew,
      () => filters.filters.noLicense,
    ],
    syncCheckboxesFromState,
    { immediate: true, deep: true }
  )

  // ── Banner search input ─────────────────────────────────────────────
  const searchInput = document.querySelector<HTMLInputElement>('.browse-banner__search')
  if (searchInput) {
    // Restore SSR'd input value from state. Watch runs immediately (avoiding
    // race with useNavigatorFilters' URL restore) and on state changes.
    watch(filters.searchQuery, (v) => {
      if (searchInput.value !== v) searchInput.value = v
    }, { immediate: true })
    searchInput.addEventListener('input', () => {
      filters.searchQuery.value = searchInput.value
    })
  }

  // ── Sort dropdown ───────────────────────────────────────────────────
  const sortSelect = document.querySelector<HTMLSelectElement>('.browse-sort__select')
  if (sortSelect) {
    // Restore SSR'd select value from state. Watch runs immediately
    // (avoiding race with useNavigatorFilters' URL restore).
    watch(sort, (v) => {
      if (sortSelect.value !== v) sortSelect.value = v
    }, { immediate: true })
    sortSelect.addEventListener('change', () => {
      sort.value = sortSelect.value as Sort
    })
  }

  // ── Pagination links — delegate clicks to goToPage ──────────────────
  // SSR currently emits a single Next link; future expansion is fine
  // because we attach by class.
  document.querySelectorAll<HTMLAnchorElement>('.browse-pagination a').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      try {
        const url = new URL(a.href, window.location.origin)
        const page = Number(url.searchParams.get('page') ?? '1')
        if (Number.isFinite(page) && page > 0) filters.goToPage(page)
      } catch {
        // Malformed href — ignore.
      }
    })
  })

  // ── Clear-all button ────────────────────────────────────────────────
  const clearBtn = document.querySelector<HTMLButtonElement>('[data-action="clear-filters"]')
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      filters.clearFilters()
      // The watch() above will re-sync checkboxes; explicitly clear search
      // input as belt-and-suspenders (it's already kept in sync via watch).
      if (searchInput) searchInput.value = ''
    })
  }

  // ── Rails fade-out: toggle [data-rails-hidden] on the SSR'd container ──
  const railsContainer = document.querySelector<HTMLElement>('[data-rails-container]')
  if (railsContainer) {
    watch(railsHidden, (hidden) => {
      if (hidden) railsContainer.setAttribute('data-rails-hidden', '')
      else railsContainer.removeAttribute('data-rails-hidden')
    }, { immediate: true })
  }

  // ── Grid title items count ──────────────────────────────────────────
  // SSR'd "All N items" stays stale as filters narrow the result set.
  const titleEl = document.querySelector<HTMLElement>('.browse-grid-title')
  if (titleEl) {
    watch(filters.displayedTotalCount, (n) => {
      titleEl.textContent = `All ${n} items`
    })
  }

  // ── Mobile filter drawer (#216) ─────────────────────────────────────
  // Below 1024px the SSR'd #browse-filter-rail is hidden by browse.css.
  // The Filters button (#browse-filter-toggle) moves the rail into
  // <ui5-dialog#browse-filter-drawer> as a Light-DOM child on first open;
  // because ui5-dialog uses Light DOM slot content, the rail's checkboxes
  // remain document descendants and the existing wiring above continues
  // to work unchanged. Close (Esc / backdrop / dialog 'close' event)
  // moves the rail back to its original parent so desktop view at >=1024px
  // is unaffected when the viewport is later resized.
  const filterToggle = document.querySelector<HTMLButtonElement>('#browse-filter-toggle')
  const filterDrawer = document.querySelector<HTMLElement>('#browse-filter-drawer')
  const filterRail = document.querySelector<HTMLElement>('#browse-filter-rail')
  if (filterToggle && filterDrawer && filterRail) {
    const originalParent = filterRail.parentElement
    const originalNextSibling = filterRail.nextSibling

    function openDrawer() {
      if (filterRail!.parentElement !== filterDrawer) {
        filterDrawer!.appendChild(filterRail!)
      }
      ;(filterDrawer as any).open = true
      filterToggle!.setAttribute('aria-expanded', 'true')
    }

    function restoreRail() {
      if (filterRail!.parentElement === filterDrawer && originalParent) {
        // insertBefore handles the null-nextSibling case (appendChild equivalent).
        originalParent.insertBefore(filterRail!, originalNextSibling)
      }
      filterToggle!.setAttribute('aria-expanded', 'false')
    }

    filterToggle.addEventListener('click', openDrawer)
    // ui5-dialog 'close' event fires after Esc, backdrop click, or open=false.
    filterDrawer.addEventListener('close', restoreRail)

    // Active-filter count badge on the toggle button. Hidden when zero.
    const countBadge = filterToggle.querySelector<HTMLElement>('.browse-filter-toggle__count')
    if (countBadge) {
      function updateCount() {
        const f = filters.filters
        const n =
          f.types.length + f.levels.length +
          f.products.length + f.topics.length +
          (f.isNew ? 1 : 0) + (f.noLicense ? 1 : 0) +
          (filters.searchQuery.value ? 1 : 0)
        if (n === 0) {
          countBadge!.hidden = true
          countBadge!.textContent = ''
        } else {
          countBadge!.hidden = false
          countBadge!.textContent = String(n)
        }
      }
      watch(
        [
          () => filters.filters.types,
          () => filters.filters.levels,
          () => filters.filters.products,
          () => filters.filters.topics,
          () => filters.filters.isNew,
          () => filters.filters.noLicense,
          filters.searchQuery,
        ],
        updateCount,
        { immediate: true, deep: true }
      )
    }
  }

  // ── Per-rail collapse + Customize popover (#285) ────────────────────
  // Each <section data-rail data-rail-id="featured|recent"> has:
  //   - a chevron toggle in .browse-rail__header (collapse)
  //   - an entry in the Customize popover (visibility)
  //
  // State persists in localStorage['browse.rails.v1'] = {
  //   collapsed: { featured: bool, recent: bool },
  //   visible:   { featured: bool, recent: bool }
  // }
  // Defaults (no key, parse error, or missing field): expanded + visible.
  wireRailControls()
}

/* ── Rail-controls helper (#285) ───────────────────────────────────────
   Pulled into its own function so the wireBrowseController body stays
   readable. No closure over wireBrowseController's state — these controls
   are purely DOM-driven and have no hook into the Vue filter state. */

interface RailsPrefs {
  collapsed: Record<string, boolean>
  visible: Record<string, boolean>
}

const RAILS_LS_KEY = 'browse.rails.v1'

function loadRailsPrefs(): RailsPrefs {
  const fallback: RailsPrefs = { collapsed: {}, visible: {} }
  try {
    const raw = localStorage.getItem(RAILS_LS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return {
      collapsed: typeof parsed?.collapsed === 'object' && parsed.collapsed !== null ? parsed.collapsed : {},
      visible: typeof parsed?.visible === 'object' && parsed.visible !== null ? parsed.visible : {},
    }
  } catch {
    return fallback
  }
}

function saveRailsPrefs(prefs: RailsPrefs): void {
  try {
    localStorage.setItem(RAILS_LS_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage unavailable / quota — silently no-op; prefs are best-effort.
  }
}

function wireRailControls(): void {
  const prefs = loadRailsPrefs()

  // Apply persisted state on first paint, before any user click.
  document.querySelectorAll<HTMLElement>('[data-rail][data-rail-id]').forEach(rail => {
    const id = rail.dataset.railId!
    if (prefs.collapsed[id]) {
      rail.setAttribute('data-collapsed', '')
      const btn = rail.querySelector<HTMLButtonElement>('.browse-rail__toggle')
      if (btn) btn.setAttribute('aria-expanded', 'false')
    }
    // Default visibility = true unless explicitly stored as false.
    if (prefs.visible[id] === false) {
      rail.setAttribute('data-rail-hidden', '')
    }
  })

  // Chevron click: toggle [data-collapsed] and persist.
  document.querySelectorAll<HTMLButtonElement>('[data-rail] [data-action="toggle-rail"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rail = btn.closest<HTMLElement>('[data-rail][data-rail-id]')
      if (!rail) return
      const id = rail.dataset.railId!
      const wasCollapsed = rail.hasAttribute('data-collapsed')
      if (wasCollapsed) {
        rail.removeAttribute('data-collapsed')
        btn.setAttribute('aria-expanded', 'true')
        prefs.collapsed[id] = false
      } else {
        rail.setAttribute('data-collapsed', '')
        btn.setAttribute('aria-expanded', 'false')
        prefs.collapsed[id] = true
      }
      saveRailsPrefs(prefs)
    })
  })

  // Customize popover: opens on Customize button click; checkboxes set
  // [data-rail-hidden] on the matching <section data-rail-id>.
  const customizeBtn = document.querySelector<HTMLButtonElement>('#browse-customize-toggle')
  const customizePopover = document.querySelector<HTMLElement>('#browse-customize-popover')
  if (customizeBtn && customizePopover) {
    // Sync popover checkboxes to current visibility state on first paint.
    customizePopover.querySelectorAll<HTMLInputElement>('input[name="rail-visible"]').forEach(cb => {
      cb.checked = prefs.visible[cb.value] !== false  // default true
    })

    customizeBtn.addEventListener('click', () => {
      // ui5-popover's `open` API: set the `opener` ref then `open = true`.
      // The web-component reads opener as either an element ref or its id.
      ;(customizePopover as any).opener = customizeBtn
      ;(customizePopover as any).open = true
      customizeBtn.setAttribute('aria-expanded', 'true')
    })
    customizePopover.addEventListener('close', () => {
      customizeBtn.setAttribute('aria-expanded', 'false')
    })

    customizePopover.querySelectorAll<HTMLInputElement>('input[name="rail-visible"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.value
        const rail = document.querySelector<HTMLElement>(`[data-rail][data-rail-id="${id}"]`)
        if (!rail) return
        if (cb.checked) {
          rail.removeAttribute('data-rail-hidden')
          prefs.visible[id] = true
        } else {
          rail.setAttribute('data-rail-hidden', '')
          prefs.visible[id] = false
        }
        saveRailsPrefs(prefs)
      })
    })
  }
}
