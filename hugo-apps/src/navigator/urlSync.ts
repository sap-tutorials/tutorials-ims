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
function asArray(raw: string | null, lower = false): string[] | undefined {
  if (raw === null) return undefined        // param absent — fall through
  if (raw === '') return []                 // explicit-empty — URL wins
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
  return lower ? parts.map(s => s.toLowerCase()) : parts
}

function asBool(raw: string | null): boolean | undefined {
  if (raw === null) return undefined
  return raw === '1'                        // strict — anything else is false
}

function asPage(raw: string | null): number {
  if (raw === null) return 1
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 2 ? n : 1
}

export function parseNavState(href: string, ls: Storage | null = null): NavState {
  const sp = new URL(href).searchParams

  const persisted = ls ? readPersistedFilters(ls) : {}

  const types     = asArray(sp.get(PARAM.types), true)    ?? persisted.types     ?? []
  const levels    = asArray(sp.get(PARAM.levels))         ?? persisted.levels    ?? []
  const products  = asArray(sp.get(PARAM.products))       ?? persisted.products  ?? []
  const topics    = asArray(sp.get(PARAM.topics))         ?? persisted.topics    ?? []
  const isNew     = asBool(sp.get(PARAM.isNew))           ?? persisted.isNew     ?? false
  const noLicense = asBool(sp.get(PARAM.noLicense))       ?? persisted.noLicense ?? false

  return {
    q: sp.get(PARAM.q) ?? '',                              // q is URL-only, never persisted
    types, levels, products, topics, isNew, noLicense,
    page: asPage(sp.get(PARAM.page)),
  }
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
