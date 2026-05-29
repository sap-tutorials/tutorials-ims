import { describe, it, expect } from 'vitest'
import { isCatalogSlug, stripCatalogSlugs } from '../publish-content.js'

describe('isCatalogSlug', () => {
  it('matches group-* slugs', () => {
    expect(isCatalogSlug('group-test-two')).toBe(true)
    expect(isCatalogSlug('group-')).toBe(true)
  })

  it('matches mission-* slugs', () => {
    expect(isCatalogSlug('mission-cap-getting-started')).toBe(true)
    expect(isCatalogSlug('mission-')).toBe(true)
  })

  it('does not match real tutorial slugs', () => {
    expect(isCatalogSlug('cap-create-application')).toBe(false)
    expect(isCatalogSlug('hana-cloud-trial-qgis-1')).toBe(false)
  })

  it('does not match the chrome-shell sentinel or other reserved keys', () => {
    // Belt-and-suspenders: the real reserved slug ('__shell__') is not a
    // catalog slug; a future reserved slug should similarly not get caught.
    expect(isCatalogSlug('__shell__')).toBe(false)
    expect(isCatalogSlug('_index')).toBe(false)
  })

  it('does not match slugs that merely contain "group" or "mission"', () => {
    // The bug being prevented is specifically the "group-" / "mission-"
    // namespace that catalog SSR claims; "group" or "mission" inside a slug
    // is fine.
    expect(isCatalogSlug('build-mission-control')).toBe(false)
    expect(isCatalogSlug('hana-discussion-group')).toBe(false)
  })
})

describe('stripCatalogSlugs', () => {
  it('removes group-/mission- entries from a discovery map', () => {
    const map = new Map<string, string>([
      ['real-tutorial', '/path/real.html'],
      ['group-test-two', '/path/group.html'],
      ['mission-foo', '/path/mission.html'],
      ['another-tutorial', '/path/another.html'],
    ])

    const dropped = stripCatalogSlugs(map)

    expect(dropped).toEqual(['group-test-two', 'mission-foo'])
    expect([...map.keys()].sort()).toEqual(['another-tutorial', 'real-tutorial'])
  })

  it('returns empty array when nothing to drop', () => {
    const map = new Map<string, string>([['cap-create', '/p1'], ['hana-cloud', '/p2']])
    expect(stripCatalogSlugs(map)).toEqual([])
    expect(map.size).toBe(2)
  })

  it('returns dropped slugs sorted for deterministic logging', () => {
    const map = new Map<string, string>([
      ['mission-z', '/'], ['group-a', '/'], ['mission-a', '/'], ['group-z', '/'],
    ])
    expect(stripCatalogSlugs(map)).toEqual([
      'group-a', 'group-z', 'mission-a', 'mission-z',
    ])
  })
})
