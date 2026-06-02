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
})

describe('parseNavState — URL only', () => {
  it('empty URL with no localStorage returns EMPTY_STATE', () => {
    expect(parseNavState(HOST)).toEqual(EMPTY_STATE)
  })

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
})

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
})

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

  it('explicit-false ?new=0 wins over localStorage isNew=true', () => {
    // Regression guard: the implementation distinguishes "param absent"
    // (asBool returns undefined → fall through) from "param present but
    // not '1'" (asBool returns false → URL wins). If asBool ever changes
    // shape, this test catches the silent precedence regression.
    persistFilters({ ...EMPTY_STATE, isNew: true }, ls)
    expect(parseNavState(HOST + '?new=0', ls).isNew).toBe(false)
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

describe('round-trip', () => {
  const fixtures: NavState[] = [
    EMPTY_STATE,
    { ...EMPTY_STATE, q: 'cap' },
    { ...EMPTY_STATE, types: ['group', 'mission'], levels: ['beginner'] },
    { ...EMPTY_STATE, products: ['sap-btp'], topics: ['cap'], isNew: true },
    { ...EMPTY_STATE, q: 'auth', types: ['tutorial'], page: 4 },
    { ...EMPTY_STATE, noLicense: true, levels: ['intermediate'] },
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
