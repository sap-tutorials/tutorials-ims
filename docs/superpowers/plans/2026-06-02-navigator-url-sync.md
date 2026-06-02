# Navigator URL Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Worktree (REQUIRED):** All work happens in `D:\projects\tutorials-poc\.claude\worktrees\issue-195-navigator-url-sync` on branch `fix/issue-195-navigator-url-sync`. Per [[feedback-parallel-agents-worktrees]], parallel agents on this repo MUST stay in their own worktree to avoid silent contamination.

**Goal:** Reflect the Tutorial Navigator's filter and search state in the URL via `history.replaceState`, with `localStorage` backstop for filters (not `q`), so users can share, bookmark, and reload filtered views.

**Architecture:** Extract a pure `urlSync.ts` module that owns parse/serialize/persist with full unit-test coverage (no Vue, no JSDOM). The SFC keeps a thin Vue glue layer (one `watch` + one debounce timer) and delegates URL handling entirely. The existing in-place `loadOptionsFromURL` / `syncOptionsToURL` helpers are deleted; their behavior subsumes into the new module with a localStorage migration ladder so existing user preferences survive.

**Tech Stack:** Vue 3 (composition API, `<script setup>`), TypeScript, Vitest (`unit` project — `npm test`), the project's existing `URLSearchParams` + `history.replaceState` idiom.

**Spec:** [docs/superpowers/specs/2026-06-02-navigator-url-sync-design.md](../specs/2026-06-02-navigator-url-sync-design.md) (commits `258ddb1`, `99a66b6`, `af0f84c`).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `hugo-apps/src/navigator/urlSync.ts` | CREATE | Pure URL ↔ NavState helpers + thin window wrappers |
| `hugo-apps/src/navigator/urlSync.test.ts` | CREATE | Vitest unit tests (no JSDOM); ~32 cases |
| `hugo-apps/src/navigator/TutorialNavigator.vue` | MODIFY | Delete in-place URL helpers; wire to `urlSync` |
| `hugo-apps/src/navigator/useSearch.ts` | UNCHANGED | — |
| `hugo-apps/src/navigator/useSearch.test.ts` | UNCHANGED | — |
| `hugo-apps/src/navigator/cardProgress.ts` | UNCHANGED | — |

The plan is split into **5 phases**. Each phase ends with `npm test` green and a commit.

---

## Phase 1 — `urlSync.ts` skeleton + types

Establish the module's public surface so downstream tests can import the types. Pure data, no logic yet.

### Task 1.1: Create the `urlSync.ts` module skeleton

**Files:**
- Create: `hugo-apps/src/navigator/urlSync.ts`

- [ ] **Step 1: Write the file**

```ts
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
```

- [ ] **Step 2: TypeScript typecheck via the test runner**

The project doesn't expose a standalone `tsc` script; the unit Vitest project will fail to load this module if the types are wrong. Run:

```bash
npm test -- --reporter=basic --run hugo-apps/src/navigator/urlSync
```

Expected: no test files match (skeleton has no tests yet) — exits 0 or with "no tests found." Crucially, TypeScript transpilation succeeds (no syntax errors in the new file).

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.ts
git commit -m "feat(navigator): urlSync.ts skeleton + NavState type (#195)"
```

---

## Phase 2 — `serializeNavState` (TDD)

Pure URL writer first because `parseNavState`'s round-trip tests will need it.

### Task 2.1: Test — `serializeNavState` empty state produces a bare URL

**Files:**
- Modify: Create `hugo-apps/src/navigator/urlSync.test.ts`
- Modify: `hugo-apps/src/navigator/urlSync.ts`

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/navigator/urlSync.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseNavState, serializeNavState, persistFilters, readPersistedFilters,
  EMPTY_STATE, PARAM, LS_KEY_V1, LS_KEY_LEGACY_NEW, LS_KEY_LEGACY_NO_LICENSE,
  type NavState,
} from './urlSync'

class FakeStorage implements Storage {
  private map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  key(i: number) { return [...this.map.keys()][i] ?? null }
  getItem(k: string) { return this.map.get(k) ?? null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
}

const HOST = 'https://nav.example.com/'

describe('serializeNavState', () => {
  it('empty state produces a bare URL', () => {
    expect(serializeNavState(HOST, EMPTY_STATE)).toBe(HOST)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- --run hugo-apps/src/navigator/urlSync.test.ts
```

Expected: FAIL with `Error: not implemented`.

- [ ] **Step 3: Implement minimal `serializeNavState`**

Replace the stub in `urlSync.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- --run hugo-apps/src/navigator/urlSync.test.ts
```

Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.ts hugo-apps/src/navigator/urlSync.test.ts
git commit -m "test(navigator): serializeNavState empty state (#195)"
```

### Task 2.2: Tests — single-value params

- [ ] **Step 1: Append tests to `urlSync.test.ts`**

```ts
  it('writes ?q= when q is non-empty', () => {
    const out = serializeNavState(HOST, { ...EMPTY_STATE, q: 'hello' })
    expect(new URL(out).searchParams.get('q')).toBe('hello')
  })

  it('writes ?new=1 when isNew is true; omits when false', () => {
    expect(new URL(serializeNavState(HOST, { ...EMPTY_STATE, isNew: true })).searchParams.get('new')).toBe('1')
    expect(new URL(serializeNavState(HOST, EMPTY_STATE)).searchParams.has('new')).toBe(false)
  })

  it('writes ?noLicense=1 when noLicense is true; omits when false', () => {
    expect(new URL(serializeNavState(HOST, { ...EMPTY_STATE, noLicense: true })).searchParams.get('noLicense')).toBe('1')
    expect(new URL(serializeNavState(HOST, EMPTY_STATE)).searchParams.has('noLicense')).toBe(false)
  })

  it('omits ?page= for page <= 1; emits for page >= 2', () => {
    expect(new URL(serializeNavState(HOST, EMPTY_STATE)).searchParams.has('page')).toBe(false)
    expect(new URL(serializeNavState(HOST, { ...EMPTY_STATE, page: 1 })).searchParams.has('page')).toBe(false)
    expect(new URL(serializeNavState(HOST, { ...EMPTY_STATE, page: 2 })).searchParams.get('page')).toBe('2')
    expect(new URL(serializeNavState(HOST, { ...EMPTY_STATE, page: 7 })).searchParams.get('page')).toBe('7')
  })
```

- [ ] **Step 2: Run tests**

```bash
npm test -- --run hugo-apps/src/navigator/urlSync.test.ts
```

Expected: 5 passing (no implementation changes needed — Phase 2.1 already covers these).

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.test.ts
git commit -m "test(navigator): serializeNavState single-value params (#195)"
```

### Task 2.3: Tests — multi-value sort + unknown-param preservation

- [ ] **Step 1: Append tests**

```ts
  it('comma-joins and sorts multi-value params alphabetically', () => {
    const state: NavState = {
      ...EMPTY_STATE,
      types: ['tutorial', 'mission', 'group'],
      levels: ['intermediate', 'beginner'],
    }
    const sp = new URL(serializeNavState(HOST, state)).searchParams
    expect(sp.get('type')).toBe('group,mission,tutorial')
    expect(sp.get('level')).toBe('beginner,intermediate')
  })

  it('does NOT mutate the input state arrays', () => {
    const types = ['tutorial', 'mission', 'group']
    const state: NavState = { ...EMPTY_STATE, types }
    serializeNavState(HOST, state)
    expect(types).toEqual(['tutorial', 'mission', 'group'])  // original order preserved
  })

  it('preserves unknown params when state is empty', () => {
    const out = serializeNavState(HOST + '?utm_source=docs', EMPTY_STATE)
    expect(new URL(out).searchParams.get('utm_source')).toBe('docs')
  })

  it('preserves unknown params under update', () => {
    const out = serializeNavState(
      HOST + '?utm_source=docs&type=mission',
      { ...EMPTY_STATE, types: ['group'] },
    )
    const sp = new URL(out).searchParams
    expect(sp.get('utm_source')).toBe('docs')
    expect(sp.get('type')).toBe('group')
  })
```

- [ ] **Step 2: Run tests**

Expected: 9 passing.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.test.ts
git commit -m "test(navigator): serializeNavState sort + unknown-param preservation (#195)"
```

---

## Phase 3 — `parseNavState` URL-only path (TDD)

### Task 3.1: Test + impl — empty URL → `EMPTY_STATE`

- [ ] **Step 1: Append failing test**

```ts
describe('parseNavState — URL only', () => {
  it('empty URL with no localStorage returns EMPTY_STATE', () => {
    expect(parseNavState(HOST)).toEqual(EMPTY_STATE)
  })
})
```

- [ ] **Step 2: Run — verify it fails with "not implemented"**

- [ ] **Step 3: Implement `parseNavState` URL-only branch**

```ts
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
```

(`readPersistedFilters` still throws — that's fine because the test passes `ls = null` so the call is skipped. The `?? {}` default here is unreachable in this test.)

- [ ] **Step 4: Run — verify it passes**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.ts hugo-apps/src/navigator/urlSync.test.ts
git commit -m "feat(navigator): parseNavState URL-only branch + EMPTY_STATE test (#195)"
```

### Task 3.2: Tests — every URL param parsed correctly

- [ ] **Step 1: Append tests**

```ts
  it('parses ?q=', () => {
    expect(parseNavState(HOST + '?q=hello').q).toBe('hello')
  })

  it('parses ?type= as comma-split lowercased array', () => {
    expect(parseNavState(HOST + '?type=mission,group').types).toEqual(['mission', 'group'])
    expect(parseNavState(HOST + '?type=Mission').types).toEqual(['mission'])  // case tolerance
  })

  it('parses ?level=, ?product=, ?topic= preserving case', () => {
    const s = parseNavState(HOST + '?level=beginner&product=sap-btp&topic=cap')
    expect(s.levels).toEqual(['beginner'])
    expect(s.products).toEqual(['sap-btp'])
    expect(s.topics).toEqual(['cap'])
  })

  it('parses ?new=1 and ?noLicense=1 as true; only literal "1" is true', () => {
    const t = parseNavState(HOST + '?new=1&noLicense=1')
    expect(t.isNew).toBe(true)
    expect(t.noLicense).toBe(true)

    const f = parseNavState(HOST + '?new=0&noLicense=true')
    expect(f.isNew).toBe(false)
    expect(f.noLicense).toBe(false)
  })

  it('parses ?page= as integer >= 2, else 1', () => {
    expect(parseNavState(HOST + '?page=3').page).toBe(3)
    expect(parseNavState(HOST + '?page=1').page).toBe(1)
    expect(parseNavState(HOST + '?page=0').page).toBe(1)
    expect(parseNavState(HOST + '?page=-2').page).toBe(1)
    expect(parseNavState(HOST + '?page=foo').page).toBe(1)
    expect(parseNavState(HOST + '?page=').page).toBe(1)
  })

  it('treats explicit-empty ?type= as URL-wins-empty (not fall-through)', () => {
    // Even with no localStorage, an explicit empty param sticks as []
    // (regression guard against future "if (!raw) fall-through" mistake).
    expect(parseNavState(HOST + '?type=').types).toEqual([])
  })

  it('filters empty splits in ?type=,,mission,,', () => {
    expect(parseNavState(HOST + '?type=,,mission,,').types).toEqual(['mission'])
  })
```

- [ ] **Step 2: Run — all should pass on existing impl**

Expected: 16 passing.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.test.ts
git commit -m "test(navigator): parseNavState URL-param coverage (#195)"
```

---

## Phase 4 — `persistFilters` / `readPersistedFilters` + migration

### Task 4.1: Implement `persistFilters` + round-trip test

- [ ] **Step 1: Append failing test**

```ts
describe('persistFilters / readPersistedFilters', () => {
  let ls: FakeStorage
  beforeEach(() => { ls = new FakeStorage() })

  it('writes filter arrays + booleans under navigator.filters.v1; never writes q or page', () => {
    persistFilters({
      ...EMPTY_STATE,
      q: 'should-not-persist',
      types: ['mission'],
      levels: ['beginner'],
      products: ['sap-btp'],
      topics: ['cap'],
      isNew: true,
      noLicense: false,
      page: 5,
    }, ls)

    const raw = ls.getItem(LS_KEY_V1)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.types).toEqual(['mission'])
    expect(parsed.isNew).toBe(true)
    expect('q' in parsed).toBe(false)
    expect('page' in parsed).toBe(false)
  })

  it('round-trips via readPersistedFilters', () => {
    const state: NavState = {
      ...EMPTY_STATE,
      types: ['mission', 'group'],
      products: ['sap-btp'],
      isNew: true,
    }
    persistFilters(state, ls)
    const read = readPersistedFilters(ls)
    expect(read.types).toEqual(['mission', 'group'])
    expect(read.products).toEqual(['sap-btp'])
    expect(read.isNew).toBe(true)
    expect(read.noLicense).toBe(false)
  })
})
```

- [ ] **Step 2: Run — verify it fails with "not implemented"**

- [ ] **Step 3: Implement both functions**

```ts
interface PersistedShape {
  types?: string[]
  levels?: string[]
  products?: string[]
  topics?: string[]
  isNew?: boolean
  noLicense?: boolean
}

export function persistFilters(state: NavState, ls: Storage): void {
  const payload: PersistedShape = {
    types:     state.types,
    levels:    state.levels,
    products:  state.products,
    topics:    state.topics,
    isNew:     state.isNew,
    noLicense: state.noLicense,
  }
  ls.setItem(LS_KEY_V1, JSON.stringify(payload))
}

export function readPersistedFilters(ls: Storage): Partial<NavState> {
  // 1. Try the v1 consolidated key first.
  const v1 = ls.getItem(LS_KEY_V1)
  if (v1 !== null) {
    try {
      const parsed = JSON.parse(v1) as PersistedShape
      const out: Partial<NavState> = {}
      if (Array.isArray(parsed.types))     out.types     = parsed.types.filter(s => typeof s === 'string')
      if (Array.isArray(parsed.levels))    out.levels    = parsed.levels.filter(s => typeof s === 'string')
      if (Array.isArray(parsed.products))  out.products  = parsed.products.filter(s => typeof s === 'string')
      if (Array.isArray(parsed.topics))    out.topics    = parsed.topics.filter(s => typeof s === 'string')
      if (typeof parsed.isNew === 'boolean')     out.isNew     = parsed.isNew
      if (typeof parsed.noLicense === 'boolean') out.noLicense = parsed.noLicense
      return out
    } catch {
      // Truncated / hand-edited JSON — fall through to legacy keys.
    }
  }

  // 2. Migration ladder: legacy `navigator.options.{new,noLicense}` keys.
  //    These were strings '1' / '0' under the old SFC code.
  const out: Partial<NavState> = {}
  const legacyNew = ls.getItem(LS_KEY_LEGACY_NEW)
  const legacyNoLicense = ls.getItem(LS_KEY_LEGACY_NO_LICENSE)
  if (legacyNew !== null) out.isNew = legacyNew === '1'
  if (legacyNoLicense !== null) out.noLicense = legacyNoLicense === '1'
  return out
}
```

- [ ] **Step 4: Run — verify it passes**

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.ts hugo-apps/src/navigator/urlSync.test.ts
git commit -m "feat(navigator): persist + read filters under navigator.filters.v1 (#195)"
```

### Task 4.2: Tests — legacy-key migration

- [ ] **Step 1: Append migration tests**

```ts
  it('migrates legacy navigator.options.* keys when v1 is absent', () => {
    ls.setItem(LS_KEY_LEGACY_NEW, '1')
    ls.setItem(LS_KEY_LEGACY_NO_LICENSE, '0')
    const read = readPersistedFilters(ls)
    expect(read.isNew).toBe(true)
    expect(read.noLicense).toBe(false)
  })

  it('v1 takes precedence over legacy keys when both exist', () => {
    ls.setItem(LS_KEY_LEGACY_NEW, '1')
    ls.setItem(LS_KEY_V1, JSON.stringify({ isNew: false }))
    const read = readPersistedFilters(ls)
    expect(read.isNew).toBe(false)  // v1 wins
  })

  it('falls through to legacy keys when v1 JSON is malformed', () => {
    ls.setItem(LS_KEY_V1, '{this is not json')
    ls.setItem(LS_KEY_LEGACY_NEW, '1')
    const read = readPersistedFilters(ls)
    expect(read.isNew).toBe(true)   // didn't throw, used legacy fallback
  })

  it('returns empty object when nothing is stored', () => {
    expect(readPersistedFilters(ls)).toEqual({})
  })

  it('does NOT delete legacy keys when persistFilters writes v1', () => {
    ls.setItem(LS_KEY_LEGACY_NEW, '1')
    persistFilters({ ...EMPTY_STATE, isNew: false }, ls)
    expect(ls.getItem(LS_KEY_LEGACY_NEW)).toBe('1')  // intentionally preserved
  })
```

- [ ] **Step 2: Run — all should pass on existing impl**

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.test.ts
git commit -m "test(navigator): legacy-key migration coverage (#195)"
```

### Task 4.3: Tests — `parseNavState` precedence (URL > localStorage)

- [ ] **Step 1: Append tests**

```ts
describe('parseNavState — URL + localStorage precedence', () => {
  let ls: FakeStorage
  beforeEach(() => { ls = new FakeStorage() })

  it('falls through to localStorage when URL param is absent', () => {
    persistFilters({ ...EMPTY_STATE, types: ['mission'] }, ls)
    expect(parseNavState(HOST, ls).types).toEqual(['mission'])
  })

  it('URL wins when both URL and localStorage have the param', () => {
    persistFilters({ ...EMPTY_STATE, types: ['mission'] }, ls)
    expect(parseNavState(HOST + '?type=group', ls).types).toEqual(['group'])
  })

  it('explicit-empty URL wins over non-empty localStorage', () => {
    persistFilters({ ...EMPTY_STATE, types: ['mission'] }, ls)
    expect(parseNavState(HOST + '?type=', ls).types).toEqual([])
  })

  it('q is NEVER read from localStorage', () => {
    // Hand-craft a v1 entry that contains a stale q (defensive — persistFilters
    // would never write this, but a malicious or future-version write could).
    ls.setItem(LS_KEY_V1, JSON.stringify({ q: 'stale-search' }))
    expect(parseNavState(HOST, ls).q).toBe('')
  })

  it('migrates legacy options.* into parsed state when URL is absent', () => {
    ls.setItem(LS_KEY_LEGACY_NEW, '1')
    expect(parseNavState(HOST, ls).isNew).toBe(true)
  })
})
```

- [ ] **Step 2: Run — all should pass**

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.test.ts
git commit -m "test(navigator): parseNavState URL+localStorage precedence (#195)"
```

### Task 4.4: Round-trip + window-wrapper tests

- [ ] **Step 1: Implement the two thin window wrappers**

```ts
export function readNavStateFromWindow(): NavState {
  const ls = (() => { try { return window.localStorage } catch { return null } })()
  try {
    return parseNavState(window.location.href, ls)
  } catch {
    return { ...EMPTY_STATE }
  }
}

export function writeNavStateToWindow(state: NavState): void {
  const next = serializeNavState(window.location.href, state)
  if (next !== window.location.href) {
    try { window.history.replaceState({}, '', next) } catch { /* defensive */ }
  }
  try {
    persistFilters(state, window.localStorage)
  } catch {
    // localStorage unavailable / quota exceeded — URL is canonical
  }
}
```

- [ ] **Step 2: Append round-trip tests**

```ts
describe('round-trip', () => {
  const fixtures: NavState[] = [
    EMPTY_STATE,
    { ...EMPTY_STATE, q: 'cap' },
    { ...EMPTY_STATE, types: ['group', 'mission'], levels: ['beginner'] },
    { ...EMPTY_STATE, products: ['sap-btp'], topics: ['cap'], isNew: true },
    { ...EMPTY_STATE, q: 'auth', types: ['tutorial'], page: 4 },
  ]

  it.each(fixtures)('parse(serialize(state)) deep-equals state %#', (state) => {
    const href = serializeNavState(HOST, state)
    expect(parseNavState(href)).toEqual(state)
  })

  it('serialize is canonicalization-stable (sorted regardless of input order)', () => {
    const a = serializeNavState(HOST, { ...EMPTY_STATE, types: ['tutorial', 'mission'] })
    const b = serializeNavState(HOST, { ...EMPTY_STATE, types: ['mission', 'tutorial'] })
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 3: Run — all should pass**

```bash
npm test -- --run hugo-apps/src/navigator/urlSync.test.ts
```

Expected: ~32 tests passing.

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/navigator/urlSync.ts hugo-apps/src/navigator/urlSync.test.ts
git commit -m "test(navigator): round-trip + window wrappers (#195)"
```

---

## Phase 5 — Wire `urlSync` into `TutorialNavigator.vue`

The pure module is fully tested. Now rewire the SFC.

### Task 5.1: Add imports

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue:1-4`

- [ ] **Step 1: Edit the import block**

Change:
```ts
import { ref, computed, onMounted, reactive, watch } from 'vue'
```
to:
```ts
import { ref, computed, onMounted, onScopeDispose, reactive, watch } from 'vue'
import {
  parseNavState, writeNavStateToWindow, type NavState,
} from './urlSync'
```

- [ ] **Step 2: Compile-check**

```bash
npm test -- --run hugo-apps/src/navigator/urlSync.test.ts
```

(The test runner transpiles all hugo-apps sources; if the new imports have a typo this fails.)

Expected: ~32 tests still passing, no transpile errors.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "refactor(navigator): import urlSync (#195)"
```

### Task 5.2: Replace `loadOptionsFromURL` / `syncOptionsToURL` with the new sync

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue:35-66`

- [ ] **Step 1: Delete lines 35-66**

Locate the comment block beginning `// Read Options toggles from the URL …` and the trailing `watch(() => [filters.isNew, filters.noLicense], syncOptionsToURL)` (currently line 66). Delete the whole block (the comment, both functions, and the watch).

- [ ] **Step 2: Insert the replacement glue at the same location**

```ts
function currentNavState(): NavState {
  return {
    q: searchQuery.value,
    types: [...filters.types],
    levels: [...filters.levels],
    products: [...filters.products],
    topics: [...filters.topics],
    isNew: filters.isNew,
    noLicense: filters.noLicense,
    page: currentPage.value,
  }
}

let urlSyncTimer: ReturnType<typeof setTimeout> | null = null
function scheduleURLSync() {
  if (urlSyncTimer) clearTimeout(urlSyncTimer)
  urlSyncTimer = setTimeout(() => writeNavStateToWindow(currentNavState()), 300)
}
// `deep: true` is meaningful for the `() => filters.X` array getters; it's
// a no-op on the bare `searchQuery` and `currentPage` refs but lets us keep
// a single watcher instead of two.
watch(
  [searchQuery, () => filters.levels, () => filters.types,
   () => filters.products, () => filters.topics,
   () => filters.isNew, () => filters.noLicense, currentPage],
  scheduleURLSync,
  { deep: true },
)
onScopeDispose(() => { if (urlSyncTimer) clearTimeout(urlSyncTimer) })
```

- [ ] **Step 3: Compile-check**

```bash
npm test -- --run hugo-apps/src/navigator
```

Expected: all hugo-apps/src/navigator tests still passing; no transpile errors. The SFC isn't unit-tested directly but its TypeScript still has to compile.

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "refactor(navigator): swap in urlSync watcher; delete inline helpers (#195)"
```

### Task 5.3: Rewrite `onMounted` URL parse

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue` — first 4 lines of `onMounted`

- [ ] **Step 1: Edit the `onMounted` head**

Locate the existing block (post Task 5.2 it sits at lines ~50-53):
```ts
  loadOptionsFromURL()                       // <- already deleted in Task 5.2
  const initialQuery = new URL(window.location.href).searchParams.get('q')
  if (initialQuery) searchQuery.value = initialQuery
```

Replace with:
```ts
  const initial = parseNavState(
    window.location.href,
    typeof localStorage !== 'undefined' ? localStorage : null,
  )
  searchQuery.value = initial.q
  filters.types     = initial.types
  filters.levels    = initial.levels
  filters.products  = initial.products
  filters.topics    = initial.topics
  filters.isNew     = initial.isNew
  filters.noLicense = initial.noLicense
  currentPage.value = initial.page
```

(If Task 5.2's deletion already removed `loadOptionsFromURL()`, only the bottom two lines remain and need replacement.)

- [ ] **Step 2: Compile-check**

```bash
npm test -- --run hugo-apps/src/navigator
```

Expected: all passing, no transpile errors.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "refactor(navigator): parseNavState in onMounted (#195)"
```

### Task 5.4: Reset `currentPage` in `clearFilters`

**Files:**
- Modify: `hugo-apps/src/navigator/TutorialNavigator.vue:542-552` (the `clearFilters` function)

- [ ] **Step 1: Add one line to `clearFilters`**

```ts
function clearFilters() {
  searchQuery.value = ''
  filters.levels = []
  filters.types = []
  filters.products = []
  filters.topics = []
  filters.isNew = false
  filters.noLicense = false
  productSearch.value = ''
  topicSearch.value = ''
+ currentPage.value = 1   // also reset page so URL drops `?page=` cleanly
}
```

- [ ] **Step 2: Compile-check**

```bash
npm test -- --run hugo-apps/src/navigator
```

Expected: all passing.

- [ ] **Step 3: Commit**

```bash
git add hugo-apps/src/navigator/TutorialNavigator.vue
git commit -m "fix(navigator): clearFilters resets currentPage (#195)"
```

---

## Phase 6 — Build, Vite check, smoke

### Task 6.1: Run the unit suite end-to-end

- [ ] **Step 1: Full `unit` project run**

```bash
npm test
```

Expected: all hugo-apps/src/navigator tests pass. Existing test count + ~32 new tests. Per [[feedback-worktree-tests-hang]], cap any hang at ~3 minutes — if it hangs without progress, kill and retry once before deferring to deployed-DEV smoke.

- [ ] **Step 2: Commit only if there are unexpected churn diffs (otherwise skip)**

### Task 6.2: Build hugo-apps via Vite

`hugo-apps/` is the Vite project that compiles the navigator island into `hugo/static/js/`. The SFC change has to survive the Vite build.

- [ ] **Step 1: Run the build**

```bash
cd hugo-apps && npm run build
```

Expected: clean build, no TypeScript errors, no warnings about unresolved imports. Vite emits the navigator island bundle into `hugo/static/js/`.

- [ ] **Step 2: Commit any lockfile or generated artifact changes (rare)**

If the build mutates `hugo-apps/package-lock.json` or similar, commit it; otherwise skip.

### Task 6.3: Local manual smoke (optional but recommended)

- [ ] **Step 1: Local approuter dev**

Per [[project-local-hybrid-dev]], start the local dev stack:

```bash
# Terminal 1: CAP backend
cds watch
# Terminal 2: approuter on port 5000
npm run start:approuter
```

- [ ] **Step 2: Manual checklist** — open `http://localhost:5000/`

- [ ] Click a "Mission" filter chip → URL updates to `?type=mission` within 300ms
- [ ] Type "cap" in the search box → URL updates to `?q=cap` after 300ms debounce
- [ ] Navigate to page 2 → URL gets `?page=2`; navigate back to page 1 → `?page=` is dropped
- [ ] Click two filter chips (Mission + Group) → URL is sorted: `?type=group,mission` (NOT `mission,group`)
- [ ] Append `?utm_source=docs` to the URL manually, then change a filter → `utm_source=docs` survives
- [ ] Click "Clear all filters" → URL drops everything except any `utm_source`
- [ ] Reload the page with `?q=cap&type=mission` → search box pre-filled, Mission chip lit
- [ ] Open DevTools → localStorage → confirm `navigator.filters.v1` exists and contains the filter snapshot but NOT `q` or `page`

### Task 6.4: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin fix/issue-195-navigator-url-sync
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head fix/issue-195-navigator-url-sync \
  --title "feat(navigator): reflect filters and search in URL (#195)" \
  --body "$(cat <<'EOF'
Closes #195.

## Summary

Selecting any filter or typing a search term updates the URL via `history.replaceState`. Pasting that URL elsewhere reproduces the same view. `localStorage` backstops filter selections (not `q`) for unattached visits.

## Implementation

- New pure module `hugo-apps/src/navigator/urlSync.ts` owns the URL ↔ NavState contract — fully unit-tested without Vue or JSDOM (~32 cases).
- `TutorialNavigator.vue` deletes `loadOptionsFromURL` / `syncOptionsToURL` and gains a single 300ms-debounced `watch` that calls `writeNavStateToWindow`.
- `clearFilters()` resets `currentPage` to 1 (closes a latent bug; `?page=` now gets dropped on clear).
- Existing `?new=1` / `?noLicense=1` URLs are byte-identical; existing `localStorage` entries (`navigator.options.new` / `navigator.options.noLicense`) are migrated transparently into the new `navigator.filters.v1` key on next persist.

## Spec & decisions

- Spec: docs/superpowers/specs/2026-06-02-navigator-url-sync-design.md
- Plan: docs/superpowers/plans/2026-06-02-navigator-url-sync.md
- Locked decisions (from issue #195 brainstorming): `?page=` only when > 1, debounce 300ms, URL > localStorage, sort multi-values, sub-threshold q still written.

## Test plan

- [x] `npm test` (unit) — all green
- [x] `cd hugo-apps && npm run build` — clean
- [ ] Reviewer: paste \`/?q=cap&type=mission&level=beginner\` on deployed DEV → confirm chips lit + 1 result
EOF
)"
```

- [ ] **Step 3: Confirm deploy scope with Tom**

Per [[feedback-confirm-deploy-scope]], ask before kicking off any deploy: "PR #N opened — backend-only, +content, or +QA scope for the deploy?" Don't deploy without explicit scope confirmation.

---

## Acceptance — final checklist

(Lifted from the spec's acceptance section; map to the PR description and merge gating.)

- [ ] Selecting any filter (`type`, `level`, `product`, `topic`) updates the corresponding URL param via `history.replaceState`.
- [ ] Typing into the search box debounces a `?q=` write at the same 300ms cadence.
- [ ] Page-2 button writes `?page=2`; page 1 emits no `?page=`.
- [ ] Multi-value filter values appear sorted alphabetically in the URL.
- [ ] Reload reproduces the same filter set + query + page.
- [ ] localStorage backstops filter selections (not `q`).
- [ ] `clearFilters()` wipes URL params AND resets `currentPage` to 1.
- [ ] Unknown params (`utm_source`) are preserved across writes.
- [ ] Existing `?new` / `?noLicense` URL behavior is byte-identical.
- [ ] Existing localStorage entries (`navigator.options.*`) migrate into v1 transparently.
- [ ] `urlSync.test.ts` passes; existing tests stay green.
- [ ] `cd hugo-apps && npm run build` succeeds.
- [ ] Smoke check on deployed DEV: pasting `?q=cap&type=mission&level=beginner` reproduces the filter set.

---

## References

- Spec: [docs/superpowers/specs/2026-06-02-navigator-url-sync-design.md](../specs/2026-06-02-navigator-url-sync-design.md)
- Issue: https://github.com/sap-tutorials/tutorials-ims/issues/195
- Parent issue: https://github.com/sap-tutorials/tutorials-ims/issues/152
- Closing PR for parent: https://github.com/sap-tutorials/tutorials-ims/pull/194
