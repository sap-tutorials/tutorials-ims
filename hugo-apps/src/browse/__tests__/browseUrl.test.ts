// hugo-apps/src/browse/__tests__/browseUrl.test.ts
import { describe, it, expect } from 'vitest'
import {
  readSort, writeSort, isValidSort, DEFAULT_SORT, SORTS,
} from '../browseUrl'

describe('browseUrl', () => {
  describe('readSort', () => {
    it('returns DEFAULT_SORT when ?sort is missing', () => {
      expect(readSort('http://x/browse/')).toBe(DEFAULT_SORT)
    })

    it('returns the sort value when valid', () => {
      expect(readSort('http://x/browse/?sort=updated')).toBe('updated')
      expect(readSort('http://x/browse/?sort=title')).toBe('title')
    })

    it('falls back to DEFAULT_SORT for an invalid sort value', () => {
      expect(readSort('http://x/browse/?sort=bogus')).toBe(DEFAULT_SORT)
      expect(readSort('http://x/browse/?sort=')).toBe(DEFAULT_SORT)
    })
  })

  describe('writeSort', () => {
    it('drops ?sort when value is the default', () => {
      const out = writeSort('http://x/browse/?sort=title', DEFAULT_SORT)
      expect(new URL(out).searchParams.has('sort')).toBe(false)
    })

    it('sets ?sort when value is non-default', () => {
      const out = writeSort('http://x/browse/', 'time')
      expect(new URL(out).searchParams.get('sort')).toBe('time')
    })

    it('preserves unrelated params (urlSync.ts owns them)', () => {
      const out = writeSort('http://x/browse/?q=hello&page=3', 'title')
      const u = new URL(out)
      expect(u.searchParams.get('q')).toBe('hello')
      expect(u.searchParams.get('page')).toBe('3')
      expect(u.searchParams.get('sort')).toBe('title')
    })
  })

  describe('isValidSort', () => {
    it('returns true for every value in SORTS and false otherwise', () => {
      for (const s of SORTS) expect(isValidSort(s)).toBe(true)
      expect(isValidSort('bogus')).toBe(false)
      expect(isValidSort('')).toBe(false)
    })
  })
})
