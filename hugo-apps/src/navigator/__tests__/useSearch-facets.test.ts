// hugo-apps/src/navigator/__tests__/useSearch-facets.test.ts
//
// Unit tests for buildFacetsUrl — verifies that the products and
// isNewCutoffISO optional params are forwarded to the getFacets OData
// action URL correctly, and that the 4-arg (legacy) form emits neither.

import { describe, it, expect } from 'vitest'
import { buildFacetsUrl } from '../useSearch'

describe('buildFacetsUrl', () => {
  it('4-arg call emits no products or isNewCutoffISO params', () => {
    const url = buildFacetsUrl('cap', ['TUTORIAL'], [], '/search')
    expect(url).not.toContain('products=@p')
    expect(url).not.toContain('@p=')
    expect(url).not.toContain('isNewCutoffISO=@n')
    expect(url).not.toContain('@n=')
  })

  it('6-arg call with products + isNewCutoffISO appends both correctly', () => {
    const iso = '2026-01-01T00:00:00.000Z'
    const url = buildFacetsUrl('cap', ['TUTORIAL'], [], '/search', ['abap'], iso)

    // products param alias present in function args
    expect(url).toContain('products=@p')

    // @p is a JSON array literal ["abap"] — percent-encoded
    // encodeURIComponent('["abap"]') === '%5B%22abap%22%5D'
    const encodedArr = encodeURIComponent('["abap"]')
    expect(url).toContain(`@p=${encodedArr}`)

    // isNewCutoffISO param alias present
    expect(url).toContain('isNewCutoffISO=@n')

    // @n is a single-quoted OData string literal '2026-01-01T00:00:00.000Z' — percent-encoded
    const encodedIso = encodeURIComponent(`'${iso}'`)
    expect(url).toContain(`@n=${encodedIso}`)
  })

  it('6-arg call with empty products array emits no products param', () => {
    const iso = '2026-01-01T00:00:00.000Z'
    const url = buildFacetsUrl('cap', ['TUTORIAL'], [], '/search', [], iso)
    expect(url).not.toContain('products=@p')
    expect(url).not.toContain('@p=')
    // isNewCutoffISO should still be present
    expect(url).toContain('isNewCutoffISO=@n')
  })

  it('6-arg call with empty isNewCutoffISO emits no isNewCutoffISO param', () => {
    const url = buildFacetsUrl('cap', ['TUTORIAL'], [], '/search', ['abap'], '')
    expect(url).toContain('products=@p')
    expect(url).not.toContain('isNewCutoffISO=@n')
    expect(url).not.toContain('@n=')
  })

  it('multiple products are encoded as a JSON array', () => {
    const url = buildFacetsUrl('cap', [], [], '/search', ['abap', 'hana'], '')
    const encodedArr = encodeURIComponent('["abap","hana"]')
    expect(url).toContain(`@p=${encodedArr}`)
  })
})
