import { describe, it, expect } from 'vitest'
import { humanizeTag } from '../parsers/frontmatter-utils'

describe('humanizeTag with registry', () => {
  it('looks up the registry first when present (recovers info that the heuristic cannot)', () => {
    const reg = {
      'software-product>sap-s-4hana': 'SAP S/4HANA',
      'software-product>sap-s-4hana-cloud-public-edition': 'SAP S/4HANA Cloud Public Edition',
    }
    expect(humanizeTag('software-product>sap-s-4hana', reg)).toBe('SAP S/4HANA')
    expect(humanizeTag('software-product>sap-s-4hana-cloud-public-edition', reg)).toBe('SAP S/4HANA Cloud Public Edition')
  })

  it('falls back to the heuristic when the slug is not in the registry', () => {
    expect(humanizeTag('software-product>my-new-product', {})).toBe('My New Product')
    expect(humanizeTag('foo>sap-cap', {})).toBe('SAP CAP')
  })

  it('preserves existing back-compat behavior when no registry is passed', () => {
    // No second argument: today's behavior must be unchanged
    expect(humanizeTag('software-product>sap-s-4hana')).toBe('SAP S 4hana')
    expect(humanizeTag('foo>sap-cap')).toBe('SAP CAP')
  })

  it('treats undefined registry the same as missing argument', () => {
    expect(humanizeTag('software-product>sap-s-4hana', undefined)).toBe('SAP S 4hana')
  })

  it('keeps the heuristic acronym promotion when registry is empty', () => {
    expect(humanizeTag('foo>btp-bus', {})).toBe('BTP Bus')
  })

  it('handles slug with no namespace prefix (no `>`) under both modes', () => {
    expect(humanizeTag('plain-slug', { 'plain-slug': 'Plain Label' })).toBe('Plain Label')
    expect(humanizeTag('plain-slug', {})).toBe('Plain Slug')
    expect(humanizeTag('plain-slug')).toBe('Plain Slug')
  })
})
