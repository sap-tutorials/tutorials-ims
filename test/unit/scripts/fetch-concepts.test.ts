import { describe, it, expect } from 'vitest'
import { yamlEscape, frontmatter, type ConceptPayload } from '../../../scripts/fetch-concepts.ts'

// #446 Track 3-A — yamlEscape unit tests.
//
// Covers control chars (\n, \r, \t), backslash and double-quote escaping,
// null/undefined/empty handling, and UTF-8 passthrough. Admin-edited
// Concepts.description values can include any of these; an unescaped newline
// inside a YAML double-quoted scalar breaks the Hugo build.

describe('yamlEscape', () => {
  it('wraps a plain string in double quotes', () => {
    expect(yamlEscape('hello')).toBe('"hello"')
  })

  it('escapes embedded double quotes', () => {
    expect(yamlEscape('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('escapes embedded backslashes', () => {
    expect(yamlEscape('path\\to\\file')).toBe('"path\\\\to\\\\file"')
  })

  it('escapes newlines, carriage returns, tabs', () => {
    expect(yamlEscape('line1\nline2')).toBe('"line1\\nline2"')
    expect(yamlEscape('a\r\nb')).toBe('"a\\r\\nb"')
    expect(yamlEscape('col1\tcol2')).toBe('"col1\\tcol2"')
  })

  it('returns empty quoted string for null/undefined/empty', () => {
    expect(yamlEscape('')).toBe('""')
    // @ts-expect-error — runtime tolerates null
    expect(yamlEscape(null)).toBe('""')
    // @ts-expect-error — runtime tolerates undefined
    expect(yamlEscape(undefined)).toBe('""')
  })

  it('passes non-ASCII UTF-8 through unchanged', () => {
    expect(yamlEscape('café — 日本')).toBe('"café — 日本"')
  })
})

// Phase 4.1 (#447) — frontmatter() learningJourneys emission.
//
// The Hugo template at hugo/layouts/concepts/single.html reads
// `.Params.learningJourneys` to render the "Learning journeys covering this"
// section. Without this pipeline step the section would never render — the
// `/build/concepts` payload carries learningJourneys[] but it has to be
// emitted into the per-concept Hugo frontmatter for the template to see it.

describe('frontmatter — learningJourneys', () => {
  const baseConcept: ConceptPayload = {
    slug: 'cap',
    name: 'CAP',
    description: 'SAP Cloud Application Programming Model',
    teaches: [],
    requires: [],
    requiredBy: [],
    relatedTo: [],
  }

  it('omits the learningJourneys key entirely when the array is empty', () => {
    const out = frontmatter({ ...baseConcept, learningJourneys: [] })
    expect(out).not.toContain('learningJourneys')
  })

  it('omits the learningJourneys key entirely when undefined', () => {
    const out = frontmatter(baseConcept)
    expect(out).not.toContain('learningJourneys')
  })

  it('emits one journey with all fields', () => {
    const out = frontmatter({
      ...baseConcept,
      learningJourneys: [
        {
          slug: 'develop-side-by-side-extensions',
          title: 'Develop Side-by-Side Extensions',
          url: 'https://learning.sap.com/learning-journeys/develop-side-by-side-extensions',
          level: 'intermediate',
          durationHours: 12.5,
        },
      ],
    })
    expect(out).toContain('learningJourneys:')
    expect(out).toContain('- slug: "develop-side-by-side-extensions"')
    expect(out).toContain('    title: "Develop Side-by-Side Extensions"')
    expect(out).toContain('    url: "https://learning.sap.com/learning-journeys/develop-side-by-side-extensions"')
    expect(out).toContain('    level: "intermediate"')
    expect(out).toContain('    durationHours: 12.5')
  })

  it('omits optional level / durationHours fields when absent', () => {
    const out = frontmatter({
      ...baseConcept,
      learningJourneys: [
        { slug: 'foo', title: 'Foo', url: 'https://example.com/foo' },
      ],
    })
    expect(out).toContain('learningJourneys:')
    expect(out).toContain('- slug: "foo"')
    expect(out).not.toContain('level:')
    expect(out).not.toContain('durationHours:')
  })

  it('emits multiple journeys preserving order', () => {
    const out = frontmatter({
      ...baseConcept,
      learningJourneys: [
        { slug: 'a', title: 'A', url: 'https://example.com/a' },
        { slug: 'b', title: 'B', url: 'https://example.com/b' },
      ],
    })
    const aIdx = out.indexOf('"a"')
    const bIdx = out.indexOf('"b"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  it('escapes title/url for YAML safety', () => {
    const out = frontmatter({
      ...baseConcept,
      learningJourneys: [
        {
          slug: 'tricky',
          title: 'Title with "quotes" and \\backslash',
          url: 'https://example.com/x',
        },
      ],
    })
    expect(out).toContain('Title with \\"quotes\\" and \\\\backslash')
  })
})

