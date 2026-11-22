import { describe, it, expect } from 'vitest'
import {
  parseChannel,
  getQaCacheDir,
  getHugoContentDir,
  getNavJsonDir,
  browseDataFile,
  keepForChannel,
} from '../fetch-tutorials'

describe('prerelease channel — parseChannel', () => {
  it('parses --channel prerelease', () => {
    expect(parseChannel(['node', 'x', '--channel', 'prerelease'])).toBe('prerelease')
  })
  it('still parses --channel qa', () => {
    expect(parseChannel(['node', 'x', '--channel', 'qa'])).toBe('qa')
  })
  it('still defaults to prod with no --channel flag', () => {
    expect(parseChannel(['node', 'x'])).toBe('prod')
  })
  it('still rejects an unknown channel', () => {
    expect(() => parseChannel(['node', 'x', '--channel', 'staging'])).toThrow('Unknown channel')
  })
})

describe('prerelease channel — dir helpers', () => {
  it('getQaCacheDir maps prerelease to .tutorial-cache-prerelease', () => {
    expect(getQaCacheDir('prerelease').replace(/\\/g, '/')).toMatch(/\.tutorial-cache-prerelease$/)
  })
  it('getQaCacheDir still maps qa to .tutorial-cache-qa', () => {
    expect(getQaCacheDir('qa').replace(/\\/g, '/')).toMatch(/\.tutorial-cache-qa$/)
  })
  it('getQaCacheDir still maps prod to .tutorial-cache', () => {
    expect(getQaCacheDir('prod').replace(/\\/g, '/')).toMatch(/\.tutorial-cache$/)
  })

  it('getHugoContentDir maps prerelease to hugo/content-prerelease', () => {
    expect(getHugoContentDir('prerelease').replace(/\\/g, '/')).toMatch(/hugo\/content-prerelease$/)
  })
  it('getHugoContentDir still maps qa to hugo/content-qa', () => {
    expect(getHugoContentDir('qa').replace(/\\/g, '/')).toMatch(/hugo\/content-qa$/)
  })
  it('getHugoContentDir still maps prod to hugo/content', () => {
    expect(getHugoContentDir('prod').replace(/\\/g, '/')).toMatch(/hugo\/content$/)
  })

  it('getNavJsonDir maps prerelease to hugo/static-prerelease/tutorials', () => {
    expect(getNavJsonDir('hugo', 'prerelease').replace(/\\/g, '/')).toMatch(/hugo\/static-prerelease\/tutorials$/)
  })
  it('getNavJsonDir still maps qa to hugo/static-qa/tutorials', () => {
    expect(getNavJsonDir('hugo', 'qa').replace(/\\/g, '/')).toMatch(/hugo\/static-qa\/tutorials$/)
  })
  it('getNavJsonDir still maps prod to hugo/static/tutorials', () => {
    expect(getNavJsonDir('hugo', 'prod').replace(/\\/g, '/')).toMatch(/hugo\/static\/tutorials$/)
  })

  it('browseDataFile maps prerelease to hugo/data-prerelease/browse.json', () => {
    expect(browseDataFile('prerelease').replace(/\\/g, '/')).toMatch(/hugo\/data-prerelease\/browse\.json$/)
  })
  it('browseDataFile still maps qa to hugo/data-qa/browse.json', () => {
    expect(browseDataFile('qa').replace(/\\/g, '/')).toMatch(/hugo\/data-qa\/browse\.json$/)
  })
  it('browseDataFile still maps prod to hugo/data/browse.json', () => {
    expect(browseDataFile('prod').replace(/\\/g, '/')).toMatch(/hugo\/data\/browse\.json$/)
  })
})

// ── Item B: keepForChannel visibility predicate (#3168) ────────────────────
//
// CRUCIAL-CORRECTNESS: prerelease must never include LISTED tutorials, and
// prod must never include ROLE_GATED tutorials. These tests pin that invariant
// directly on the extracted pure predicate so a future refactor of main() can't
// silently break the filter without a red test.
//
// TDD evidence: tests were written against the keepForChannel export before the
// implementation was added to fetch-tutorials.ts; the test suite went red
// (import of keepForChannel failed with "is not a function") until the helper
// was exported.
describe('keepForChannel — ROLE_GATED visibility filter', () => {
  // ── prerelease: ONLY ROLE_GATED pass ──────────────────────────────────────
  it('prerelease keeps ROLE_GATED', () => {
    expect(keepForChannel('ROLE_GATED', 'prerelease')).toBe(true)
  })
  it('prerelease drops LISTED', () => {
    expect(keepForChannel('LISTED', 'prerelease')).toBe(false)
  })
  it('prerelease drops undefined visibility (treated as LISTED)', () => {
    expect(keepForChannel(undefined, 'prerelease')).toBe(false)
  })
  it('prerelease drops empty-string visibility (treated as LISTED)', () => {
    expect(keepForChannel('', 'prerelease')).toBe(false)
  })
  it('prerelease drops UNLISTED', () => {
    expect(keepForChannel('UNLISTED', 'prerelease')).toBe(false)
  })

  // ── prod: ROLE_GATED is excluded, everything else passes ─────────────────
  it('prod keeps LISTED', () => {
    expect(keepForChannel('LISTED', 'prod')).toBe(true)
  })
  it('prod keeps undefined visibility (treated as LISTED)', () => {
    expect(keepForChannel(undefined, 'prod')).toBe(true)
  })
  it('prod keeps empty-string visibility (treated as LISTED)', () => {
    expect(keepForChannel('', 'prod')).toBe(true)
  })
  it('prod keeps UNLISTED', () => {
    // UNLISTED tutorials are suppressed via sitemap/private flag in Hugo
    // frontmatter, but they DO appear in the prod fetch (not gated content).
    expect(keepForChannel('UNLISTED', 'prod')).toBe(true)
  })
  it('prod drops ROLE_GATED', () => {
    expect(keepForChannel('ROLE_GATED', 'prod')).toBe(false)
  })

  // ── qa: no visibility filter — all pass regardless ────────────────────────
  it('qa passes ROLE_GATED (repo-scoped filtering, not visibility)', () => {
    expect(keepForChannel('ROLE_GATED', 'qa')).toBe(true)
  })
  it('qa passes LISTED', () => {
    expect(keepForChannel('LISTED', 'qa')).toBe(true)
  })
  it('qa passes undefined visibility', () => {
    expect(keepForChannel(undefined, 'qa')).toBe(true)
  })

  // ── mixed-catalog scenario: simulate a real catalog mix ──────────────────
  it('filters a mixed catalog correctly for prerelease channel', () => {
    const catalog = [
      { slug: 'tut-role-gated', visibility: 'ROLE_GATED' },
      { slug: 'tut-listed', visibility: 'LISTED' },
      { slug: 'tut-no-vis', visibility: undefined },
      { slug: 'tut-unlisted', visibility: 'UNLISTED' },
    ]
    const kept = catalog.filter(t => keepForChannel(t.visibility, 'prerelease'))
    expect(kept.map(t => t.slug)).toEqual(['tut-role-gated'])
  })

  it('filters a mixed catalog correctly for prod channel', () => {
    const catalog = [
      { slug: 'tut-role-gated', visibility: 'ROLE_GATED' },
      { slug: 'tut-listed', visibility: 'LISTED' },
      { slug: 'tut-no-vis', visibility: undefined },
      { slug: 'tut-unlisted', visibility: 'UNLISTED' },
    ]
    const kept = catalog.filter(t => keepForChannel(t.visibility, 'prod'))
    expect(kept.map(t => t.slug)).toEqual(['tut-listed', 'tut-no-vis', 'tut-unlisted'])
  })

  it('filters a mixed catalog correctly for qa channel (all pass)', () => {
    const catalog = [
      { slug: 'tut-role-gated', visibility: 'ROLE_GATED' },
      { slug: 'tut-listed', visibility: 'LISTED' },
      { slug: 'tut-no-vis', visibility: undefined },
    ]
    const kept = catalog.filter(t => keepForChannel(t.visibility, 'qa'))
    expect(kept).toHaveLength(3)
  })
})
