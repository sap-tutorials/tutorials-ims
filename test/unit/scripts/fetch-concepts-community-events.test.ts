// Phase 4.8 (#765): fetch-concepts emits `communityEvents` YAML block into
// per-concept frontmatter when the /build/concepts payload includes a
// non-empty communityEvents[]. Hide-when-empty; pass-through of all fields.

import { describe, it, expect } from 'vitest'
import { frontmatter } from '../../../scripts/fetch-concepts.ts'

const concept = {
  slug: 'cap-cds-modeling',
  name: 'CAP CDS modeling',
  description: '',
  teaches: [],
  requires: [],
  requiredBy: [],
  relatedTo: [],
  communityEvents: [
    { slug: 'ce-codejam-1', title: 'CodeJam A', url: 'https://a', location: 'Berlin', startDate: '2027-01-15', virtualOrInPerson: 'in-person' },
    { slug: 'ce-codejam-2', title: 'CodeJam B', url: 'https://b', location: 'virtual', startDate: '2027-02-01', virtualOrInPerson: 'virtual' },
  ],
} as any

describe('fetch-concepts communityEvents frontmatter (Phase 4.8)', () => {
  it('emits communityEvents block when non-empty', () => {
    const yaml = frontmatter(concept)
    expect(yaml).toContain('communityEvents:')
    expect(yaml).toContain('ce-codejam-1')
  })

  it('preserves upstream sort order (first codejam-1, then codejam-2)', () => {
    const yaml = frontmatter(concept)
    const a = yaml.indexOf('ce-codejam-1')
    const b = yaml.indexOf('ce-codejam-2')
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(b)
  })

  it('passes through virtualOrInPerson field', () => {
    const yaml = frontmatter(concept)
    expect(yaml).toContain('virtualOrInPerson: virtual')
  })

  it('passes through location field', () => {
    const yaml = frontmatter(concept)
    expect(yaml).toContain('location: "Berlin"')
  })

  it('passes through startDate field', () => {
    const yaml = frontmatter(concept)
    expect(yaml).toContain('startDate: 2027-01-15')
  })

  it('omits communityEvents key when the array is empty', () => {
    const fm = frontmatter({
      slug: 'no-events',
      name: 'No Events',
      description: '',
      teaches: [],
      requires: [],
      requiredBy: [],
      relatedTo: [],
      communityEvents: [],
    } as any)
    expect(fm).not.toContain('communityEvents:')
  })

  it('omits optional fields when absent', () => {
    const fm = frontmatter({
      slug: 'x',
      name: 'X',
      description: '',
      teaches: [],
      requires: [],
      requiredBy: [],
      relatedTo: [],
      communityEvents: [{
        slug: 'ce-minimal',
        title: 'Minimal Event',
        url: 'https://example.com/event',
      }],
    } as any)
    expect(fm).toContain('ce-minimal')
    // Optional fields must not appear as null/undefined in YAML
    expect(fm).not.toMatch(/virtualOrInPerson:\s*(null|undefined)/)
    expect(fm).not.toMatch(/location:\s*(null|undefined)/)
  })
})
