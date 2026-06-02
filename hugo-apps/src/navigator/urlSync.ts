// hugo-apps/src/navigator/urlSync.ts
//
// Pure URL ↔ NavState translation for the Tutorial Navigator.
// The SFC (TutorialNavigator.vue) holds reactive state; this module owns
// the URL contract (parse, serialize, persist). No Vue, no DOM, no
// `window` access except in the two thin wrappers at the bottom.
//
// Spec: docs/superpowers/specs/2026-06-02-navigator-url-sync-design.md

export const PARAM = {
  q: 'q',
  types: 'type',
  levels: 'level',
  products: 'product',
  topics: 'topic',
  isNew: 'new',
  noLicense: 'noLicense',
  page: 'page',
} as const

/** localStorage key for the consolidated v1 filter persistence object. */
export const LS_KEY_V1 = 'navigator.filters.v1'

/** Legacy keys the old SFC code wrote — read for migration, never written. */
export const LS_KEY_LEGACY_NEW = 'navigator.options.new'
export const LS_KEY_LEGACY_NO_LICENSE = 'navigator.options.noLicense'

export interface NavState {
  q: string
  types: string[]
  levels: string[]
  products: string[]
  topics: string[]
  isNew: boolean
  noLicense: boolean
  /** 1-indexed; 1 means "no page param emitted". */
  page: number
}

export const EMPTY_STATE: NavState = Object.freeze({
  q: '',
  types: [],
  levels: [],
  products: [],
  topics: [],
  isNew: false,
  noLicense: false,
  page: 1,
}) as NavState

// Implementation in subsequent tasks.
export function parseNavState(_href: string, _ls?: Storage | null): NavState {
  throw new Error('not implemented')
}

function setOrDelete(sp: URLSearchParams, key: string, values: string[]): void {
  if (values.length === 0) sp.delete(key)
  else sp.set(key, [...values].sort().join(','))
}

export function serializeNavState(href: string, state: NavState): string {
  const url = new URL(href)
  const sp = url.searchParams

  if (state.q) sp.set(PARAM.q, state.q); else sp.delete(PARAM.q)
  if (state.isNew) sp.set(PARAM.isNew, '1'); else sp.delete(PARAM.isNew)
  if (state.noLicense) sp.set(PARAM.noLicense, '1'); else sp.delete(PARAM.noLicense)
  if (state.page > 1) sp.set(PARAM.page, String(state.page)); else sp.delete(PARAM.page)

  setOrDelete(sp, PARAM.types,    state.types)
  setOrDelete(sp, PARAM.levels,   state.levels)
  setOrDelete(sp, PARAM.products, state.products)
  setOrDelete(sp, PARAM.topics,   state.topics)

  return url.toString()
}

export function persistFilters(_state: NavState, _ls: Storage): void {
  throw new Error('not implemented')
}

export function readPersistedFilters(_ls: Storage): Partial<NavState> {
  throw new Error('not implemented')
}

export function readNavStateFromWindow(): NavState {
  throw new Error('not implemented')
}

export function writeNavStateToWindow(_state: NavState): void {
  throw new Error('not implemented')
}
