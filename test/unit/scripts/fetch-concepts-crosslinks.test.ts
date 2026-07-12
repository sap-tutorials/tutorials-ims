import { describe, it, expect } from 'vitest'
import { frontmatter, type ConceptPayload } from '../../../scripts/fetch-concepts.ts'

// #1127 — cross-link enrichment: teaches carries experienceTag + stepCount;
// requires/requiredBy/relatedTo carry description. All optional/omit-when-absent.

const base: ConceptPayload = {
  slug: 'cap',
  name: 'CAP',
  description: 'SAP Cloud Application Programming Model',
  teaches: [],
  requires: [],
  requiredBy: [],
  relatedTo: [],
}

describe('frontmatter — teaches enrichment', () => {
  it('emits experienceTag + stepCount when present', () => {
    const out = frontmatter({
      ...base,
      teaches: [{ slug: 'my-tut', title: 'My Tutorial', experienceTag: 'beginner', stepCount: 7 }],
    })
    expect(out).toContain('teaches:')
    expect(out).toContain('- slug: "my-tut"')
    expect(out).toContain('    title: "My Tutorial"')
    expect(out).toContain('    experienceTag: "beginner"')
    expect(out).toContain('    stepCount: 7')
  })

  it('omits experienceTag / stepCount when absent', () => {
    const out = frontmatter({ ...base, teaches: [{ slug: 't', title: 'T' }] })
    expect(out).toContain('- slug: "t"')
    expect(out).not.toContain('experienceTag:')
    expect(out).not.toContain('stepCount:')
  })

  it('emits stepCount: 0 (guards on != null, not truthiness)', () => {
    const out = frontmatter({
      ...base,
      teaches: [{ slug: 't', title: 'T', stepCount: 0 }],
    })
    expect(out).toContain('    stepCount: 0')
  })
})

describe('frontmatter — concept edge description enrichment', () => {
  it('emits description on requires/requiredBy/relatedTo when present', () => {
    const out = frontmatter({
      ...base,
      requires: [{ slug: 'sql', name: 'SQL', description: 'Structured Query Language' }],
      relatedTo: [{ slug: 'odata', name: 'OData', description: 'Open Data Protocol' }],
      requiredBy: [{ slug: 'rap', name: 'RAP', description: 'RESTful ABAP Prog Model' }],
    })
    expect(out).toContain('    description: "Structured Query Language"')
    expect(out).toContain('    description: "Open Data Protocol"')
    expect(out).toContain('    description: "RESTful ABAP Prog Model"')
  })

  it('omits description when absent, keeping slug+title', () => {
    const out = frontmatter({ ...base, requires: [{ slug: 'sql', name: 'SQL' }] })
    expect(out).toContain('- slug: "sql"')
    expect(out).toContain('    title: "SQL"')
    expect(out).not.toContain('description: "SQL"') // no phantom description
  })

  it('still emits empty arrays as " []" (YAML validity guard)', () => {
    const out = frontmatter(base)
    expect(out).toContain('teaches: []')
    expect(out).toContain('requires: []')
    expect(out).toContain('relatedTo: []')
  })

  it('escapes description for YAML safety', () => {
    const out = frontmatter({
      ...base,
      requires: [{ slug: 'x', name: 'X', description: 'has "quotes"\nand newline' }],
    })
    expect(out).toContain('description: "has \\"quotes\\"\\nand newline"')
  })
})
