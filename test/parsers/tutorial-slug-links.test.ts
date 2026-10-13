import { describe, it, expect } from 'vitest'
import { resolveTutorialSlugLinks, isBareTutorialSlug } from '../../scripts/parsers/tutorial-slug-links.js'

describe('resolveTutorialSlugLinks', () => {
  it('rewrites a bare tutorial slug to a site-relative /tutorials/<slug> URL (#2752)', () => {
    // The exact case from the issue.
    const src = 'Complete the steps in [Start Using SAP HANA Cloud Free Tier Service in SAP BTP Cockpit](hana-cloud-mission-trial-2) to set up your account'
    const out = 'Complete the steps in [Start Using SAP HANA Cloud Free Tier Service in SAP BTP Cockpit](/tutorials/hana-cloud-mission-trial-2) to set up your account'
    expect(resolveTutorialSlugLinks(src)).toBe(out)
  })

  it('rewrites multiple bare slugs on the same line', () => {
    expect(resolveTutorialSlugLinks('[a](slug-one) and [b](slug-two)'))
      .toBe('[a](/tutorials/slug-one) and [b](/tutorials/slug-two)')
  })

  it('rewrites a single-segment slug and a hyphenated/numeric slug', () => {
    expect(resolveTutorialSlugLinks('[x](abap)')).toBe('[x](/tutorials/abap)')
    expect(resolveTutorialSlugLinks('[x](rap100)')).toBe('[x](/tutorials/rap100)')
  })

  it('leaves images (![]) untouched', () => {
    expect(resolveTutorialSlugLinks('![alt](some-slug)')).toBe('![alt](some-slug)')
  })

  it('leaves absolute, root-relative, anchor, and mailto links untouched', () => {
    for (const s of [
      '[a](https://developers.sap.com/tutorials/x)',
      '[a](http://x.com)',
      '[a](/tutorials/already-absolute)',
      '[a](#section)',
      '[a](mailto:x@y.z)',
    ]) {
      expect(resolveTutorialSlugLinks(s)).toBe(s)
    }
  })

  it('leaves attachment/extension and ../ targets untouched (handled elsewhere / not slugs)', () => {
    for (const s of ['[a](EX2.txt)', '[a](guide.md)', '[a](page.html)', '[a](../sib/f.txt)']) {
      expect(resolveTutorialSlugLinks(s)).toBe(s)
    }
  })

  it('leaves non-slug-shaped bare targets untouched (uppercase, underscore, path, query)', () => {
    for (const s of ['[a](Some-Slug)', '[a](some_slug)', '[a](a/b)', '[a](slug?x=1)']) {
      expect(resolveTutorialSlugLinks(s)).toBe(s)
    }
  })

  it('does not touch link-like text inside a fenced code block', () => {
    const src = '```md\n[x](some-slug)\n```'
    expect(resolveTutorialSlugLinks(src)).toBe(src)
  })

  it('is idempotent (already-rewritten /tutorials/<slug> is left as-is)', () => {
    const once = resolveTutorialSlugLinks('[a](hana-cloud-mission-trial-2)')
    expect(resolveTutorialSlugLinks(once)).toBe(once)
  })
})

describe('isBareTutorialSlug', () => {
  it('accepts lowercase/digit/hyphen slugs', () => {
    for (const s of ['abap', 'rap100', 'hana-cloud-mission-trial-2', 'a1-b2-c3']) {
      expect(isBareTutorialSlug(s)).toBe(true)
    }
  })
  it('rejects anything with a scheme, slash, dot, anchor, query, underscore, or uppercase', () => {
    for (const s of ['http://x', 'https://x', '/abs', '#frag', 'mailto:a@b', 'file.html', 'a/b', 'slug?x=1', 'some_slug', 'Some-Slug', '-leading', '']) {
      expect(isBareTutorialSlug(s)).toBe(false)
    }
  })
})
