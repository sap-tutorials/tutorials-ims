// hugo-apps/src/navigator/url-params.test.ts
//
// Issue #161 — pure parsers used by TutorialNavigator.vue's onMounted
// block to seed filters.products / filters.levels from URL query params.
// Kept as a pure module so the heavy Vue mount isn't required for unit
// coverage of URL handling. The component-level wiring is exercised by
// the smoke test in test/smoke/clickable-chips.smoke.test.ts.

import { describe, it, expect } from 'vitest'
import { parseTagParams, parseLevelParams } from './url-params'

describe('parseTagParams', () => {
  it('returns [] when no tag param is present', () => {
    const sp = new URLSearchParams('q=foo')
    expect(parseTagParams(sp)).toEqual([])
  })

  it('returns the single decoded slug for ?tag=topic%3Eabap-development', () => {
    const sp = new URLSearchParams('tag=topic%3Eabap-development')
    expect(parseTagParams(sp)).toEqual(['topic>abap-development'])
  })

  it('returns every value when ?tag is repeated', () => {
    const sp = new URLSearchParams('tag=topic%3Eabap-development&tag=software-product%3Esap-hana')
    expect(parseTagParams(sp)).toEqual([
      'topic>abap-development',
      'software-product>sap-hana',
    ])
  })

  it('drops empty string values', () => {
    const sp = new URLSearchParams('tag=&tag=topic%3Eabap-development')
    expect(parseTagParams(sp)).toEqual(['topic>abap-development'])
  })

  it('preserves duplicates as-is (caller dedupes)', () => {
    const sp = new URLSearchParams('tag=topic%3Eabap-development&tag=topic%3Eabap-development')
    expect(parseTagParams(sp)).toEqual([
      'topic>abap-development',
      'topic>abap-development',
    ])
  })
})

describe('parseLevelParams', () => {
  it('returns [] when no level param is present', () => {
    expect(parseLevelParams(new URLSearchParams(''))).toEqual([])
  })

  it.each(['beginner', 'intermediate', 'advanced'])(
    'accepts the canonical level %s',
    (lvl) => {
      const sp = new URLSearchParams(`level=${lvl}`)
      expect(parseLevelParams(sp)).toEqual([lvl])
    },
  )

  it('lowercases mixed-case input', () => {
    const sp = new URLSearchParams('level=Beginner')
    expect(parseLevelParams(sp)).toEqual(['beginner'])
  })

  it('drops unknown level values silently', () => {
    const sp = new URLSearchParams('level=expert&level=beginner')
    expect(parseLevelParams(sp)).toEqual(['beginner'])
  })

  it('drops empty string values', () => {
    const sp = new URLSearchParams('level=&level=advanced')
    expect(parseLevelParams(sp)).toEqual(['advanced'])
  })
})
