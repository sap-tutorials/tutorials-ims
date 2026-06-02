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

export function serializeNavState(_href: string, _state: NavState): string {
  throw new Error('not implemented')
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
