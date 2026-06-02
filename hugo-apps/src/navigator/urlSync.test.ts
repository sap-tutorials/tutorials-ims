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
})
