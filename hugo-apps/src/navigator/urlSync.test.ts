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
