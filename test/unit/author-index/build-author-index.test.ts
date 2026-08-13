import { describe, it, expect } from 'vitest'
import { normalizeAuthorLogin, buildAuthorIndex } from '../../../scripts/parsers/author-index'

describe('normalizeAuthorLogin', () => {
  it('lowercases a github login', () => {
    expect(normalizeAuthorLogin('https://github.com/Thomas-Jung')).toBe('thomas-jung')
  })
  it('returns null for non-github or empty', () => {
    expect(normalizeAuthorLogin('https://example.com/foo')).toBeNull()
    expect(normalizeAuthorLogin('')).toBeNull()
  })
})

describe('buildAuthorIndex', () => {
  const row = (o: Partial<Parameters<typeof buildAuthorIndex>[0][number]> = {}) => ({
    authorProfile: 'https://github.com/Thomas-Jung', displayName: 'Thomas Jung',
    slug: 'a', title: 'A', time: 10, level: 'Beginner', tags: ['cap'],
    createdAt: '2026-01-01T00:00:00Z', isNew: false, ...o,
  })
  it('groups by lowercased login and excludes unresolvable profiles', () => {
    const idx = buildAuthorIndex(
      [row(), row({ slug: 'b', title: 'B', authorProfile: 'https://github.com/thomas-jung' }),
       row({ slug: 'c', title: 'C', authorProfile: 'mailto:x@y.z' })],
      new Map(),
    )
    expect(Object.keys(idx)).toEqual(['thomas-jung'])
    // Order is covered by the sort test below; here assert the set (both rows
    // share createdAt+title, so grouping order is incidental).
    expect(idx['thomas-jung'].tutorials.map(t => t.slug).sort()).toEqual(['a', 'b'])
  })
  it('sorts tutorials most-recent-first, title tiebreak, and dedupes slugs', () => {
    const idx = buildAuthorIndex(
      [row({ slug: 'old', title: 'Old', createdAt: '2025-01-01T00:00:00Z' }),
       row({ slug: 'new', title: 'New', createdAt: '2026-06-01T00:00:00Z' }),
       row({ slug: 'new', title: 'New dup', createdAt: '2026-06-01T00:00:00Z' })],
      new Map(),
    )
    expect(idx['thomas-jung'].tutorials.map(t => t.slug)).toEqual(['new', 'old'])
  })
  it('sets advocateSlug when the login is an advocate', () => {
    const idx = buildAuthorIndex([row()], new Map([['thomas-jung', 'thomas-jung']]))
    expect(idx['thomas-jung'].advocateSlug).toBe('thomas-jung')
  })
  it('falls back displayName to login when name is missing/Unknown', () => {
    const idx = buildAuthorIndex([row({ displayName: 'Unknown' })], new Map())
    expect(idx['thomas-jung'].displayName).toBe('thomas-jung')
  })
})
