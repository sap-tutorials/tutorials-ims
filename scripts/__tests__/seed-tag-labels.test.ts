import { describe, it, expect } from 'vitest'
import { parseAemTagPayload, aemTagTitleToHanaTitlePath } from '../seed-tag-labels'

describe('parseAemTagPayload', () => {
  it('extracts {tagTitle, label} pairs from the solr response .tags map', () => {
    const solrResponse = {
      tags: {
        'uuid-1:path-1': { title: 'SAP S/4HANA Cloud Public Edition', tagTitle: 'software-product:enterprise-management/sap-s-4hana-cloud/sap-s-4hana-cloud-public-edition', tagAlternativeTitles: [] },
        'uuid-2:path-2': { title: 'Advanced', tagTitle: 'tutorial:experience/advanced', tagAlternativeTitles: ['advanced'] },
      }
    }
    const result = parseAemTagPayload(solrResponse)
    expect(result).toEqual([
      { tagTitle: 'software-product:enterprise-management/sap-s-4hana-cloud/sap-s-4hana-cloud-public-edition', label: 'SAP S/4HANA Cloud Public Edition' },
      { tagTitle: 'tutorial:experience/advanced', label: 'Advanced' },
    ])
  })

  it('skips entries missing tagTitle or title', () => {
    const solrResponse = { tags: {
      'a:b': { title: 'OK', tagTitle: 'ns:foo' },
      'c:d': { title: 'Missing tagTitle' },
      'e:f': { tagTitle: 'ns:bar' },     // missing title
      'g:h': { title: '', tagTitle: 'ns:baz' },  // empty label
    } }
    const result = parseAemTagPayload(solrResponse)
    expect(result).toEqual([{ tagTitle: 'ns:foo', label: 'OK' }])
  })

  it('returns empty array when .tags is missing', () => {
    expect(parseAemTagPayload({})).toEqual([])
    expect(parseAemTagPayload({ tags: null })).toEqual([])
  })

  it('trims whitespace from labels', () => {
    expect(parseAemTagPayload({ tags: { 'a:b': { title: '  Foo  ', tagTitle: 'ns:foo' } } }))
      .toEqual([{ tagTitle: 'ns:foo', label: 'Foo' }])
  })
})

describe('aemTagTitleToHanaTitlePath', () => {
  // Returns an ORDERED array of candidate titlePaths to try against HANA.
  it('produces the simple namespace + last segment first', () => {
    const candidates = aemTagTitleToHanaTitlePath('software-product:enterprise-management/sap-s-4hana-cloud/sap-s-4hana-cloud-public-edition')
    expect(candidates[0]).toBe('software-product>sap-s-4hana-cloud-public-edition')
  })

  it('handles single-segment paths (no /)', () => {
    const candidates = aemTagTitleToHanaTitlePath('language:english')
    expect(candidates).toContain('language>english')
  })

  it('strips redundant namespace prefix from last segment', () => {
    const candidates = aemTagTitleToHanaTitlePath('programming-tool:programming-tool-api')
    // Without strip: programming-tool>programming-tool-api
    // With strip:    programming-tool>api
    expect(candidates).toContain('programming-tool>programming-tool-api')
    expect(candidates).toContain('programming-tool>api')
  })

  it('produces a double-hyphen variant (HANA encodes comma/slash)', () => {
    const candidates = aemTagTitleToHanaTitlePath('software-product:enterprise-management/sap-build-work-zone/sap-build-work-zone-advanced-edition')
    expect(candidates).toContain('software-product>sap-build-work-zone-advanced-edition')
    expect(candidates).toContain('software-product>sap-build-work-zone--advanced-edition')
  })

  it('returns [] for malformed input', () => {
    expect(aemTagTitleToHanaTitlePath('')).toEqual([])
    expect(aemTagTitleToHanaTitlePath('no-colon-path')).toEqual([])
  })
})
