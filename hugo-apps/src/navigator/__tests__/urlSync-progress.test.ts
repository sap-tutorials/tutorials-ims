// hugo-apps/src/navigator/__tests__/urlSync-progress.test.ts
import { describe, it, expect } from 'vitest'
import {
  parseNavState, serializeNavState, persistFilters, readPersistedFilters,
  EMPTY_STATE, PARAM,
  type NavState,
} from '../urlSync'

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

describe('urlSync-progress: completed and inProgress fields', () => {
  describe('serializeNavState', () => {
    it('writes ?completed=1 when completed is true; omits when false', () => {
      expect(new URL(serializeNavState(HOST, { ...EMPTY_STATE, completed: true })).searchParams.get('completed')).toBe('1')
      expect(new URL(serializeNavState(HOST, EMPTY_STATE)).searchParams.has('completed')).toBe(false)
    })

    it('writes ?inProgress=1 when inProgress is true; omits when false', () => {
      expect(new URL(serializeNavState(HOST, { ...EMPTY_STATE, inProgress: true })).searchParams.get('inProgress')).toBe('1')
      expect(new URL(serializeNavState(HOST, EMPTY_STATE)).searchParams.has('inProgress')).toBe(false)
    })

    it('both can be true independently', () => {
      const sp = new URL(serializeNavState(HOST, { ...EMPTY_STATE, completed: true, inProgress: true })).searchParams
      expect(sp.get('completed')).toBe('1')
      expect(sp.get('inProgress')).toBe('1')
    })
  })

  describe('parseNavState — URL only', () => {
    it('parses ?completed=1 and ?inProgress=1 as true; only literal "1" is true', () => {
      const t = parseNavState(HOST + '?completed=1&inProgress=1')
      expect(t.completed).toBe(true)
      expect(t.inProgress).toBe(true)

      const f = parseNavState(HOST + '?completed=0&inProgress=false')
      expect(f.completed).toBe(false)
      expect(f.inProgress).toBe(false)
    })

    it('defaults to false when URL params are absent', () => {
      expect(parseNavState(HOST).completed).toBe(false)
      expect(parseNavState(HOST).inProgress).toBe(false)
    })
  })

  describe('persistFilters / readPersistedFilters', () => {
    let ls: FakeStorage
    beforeEach(() => { ls = new FakeStorage() })

    it('writes completed and inProgress under navigator.filters.v1', () => {
      persistFilters({
        ...EMPTY_STATE,
        completed: true,
        inProgress: false,
      }, ls)

      const raw = ls.getItem('navigator.filters.v1')
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw!)
      expect(parsed.completed).toBe(true)
      expect(parsed.inProgress).toBe(false)
    })

    it('round-trips completed/inProgress via readPersistedFilters', () => {
      const state: NavState = {
        ...EMPTY_STATE,
        completed: true,
        inProgress: false,
      }
      persistFilters(state, ls)
      const read = readPersistedFilters(ls)
      expect(read.completed).toBe(true)
      expect(read.inProgress).toBe(false)
    })

    it('defaults to false when not persisted', () => {
      const read = readPersistedFilters(ls)
      expect(read.completed).toBeUndefined()
      expect(read.inProgress).toBeUndefined()
    })
  })

  describe('round-trip with persistence', () => {
    let ls: FakeStorage
    beforeEach(() => { ls = new FakeStorage() })

    it('parse(serialize(state)) deep-equals state for completed/inProgress', () => {
      const state: NavState = { ...EMPTY_STATE, completed: true, inProgress: true }
      const href = serializeNavState(HOST, state)
      expect(parseNavState(href)).toEqual(state)
    })

    it('falls through to localStorage when URL params are absent', () => {
      persistFilters({ ...EMPTY_STATE, completed: true, inProgress: false }, ls)
      const parsed = parseNavState(HOST, ls)
      expect(parsed.completed).toBe(true)
      expect(parsed.inProgress).toBe(false)
    })

    it('URL wins when both URL and localStorage have the param', () => {
      persistFilters({ ...EMPTY_STATE, completed: true, inProgress: true }, ls)
      expect(parseNavState(HOST + '?completed=0&inProgress=0', ls).completed).toBe(false)
      expect(parseNavState(HOST + '?completed=0&inProgress=0', ls).inProgress).toBe(false)
    })
  })
})
