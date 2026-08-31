import { describe, it, expect } from 'vitest'
import { buildContributorsSidecar } from '../../scripts/parsers/contributors-sidecar'

describe('buildContributorsSidecar', () => {
  it('lowercases slug and caps at 10', () => {
    const contribs = Array.from({ length: 12 }, (_, i) => ({
      login: `u${i}`, name: `N${i}`, email: `${i}@x.com`, avatarUrl: `a${i}`,
    }))
    const out = buildContributorsSidecar('My-Slug', contribs)
    expect(out.slug).toBe('my-slug')
    expect(out.contributors).toHaveLength(10)
    expect(out.contributors[0]).toEqual({ login: 'u0', name: 'N0', email: '0@x.com', avatarUrl: 'a0' })
  })
  it('returns null when no contributors', () => {
    expect(buildContributorsSidecar('s', [])).toBeNull()
  })
})
