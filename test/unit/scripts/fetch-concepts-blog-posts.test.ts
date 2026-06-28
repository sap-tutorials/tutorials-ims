import { describe, it, expect } from 'vitest'
import { frontmatter, type ConceptPayload } from '../../../scripts/fetch-concepts.ts'

// Phase 4.2 (#447 §9) — frontmatter() blogPosts emission.
//
// The Hugo template at hugo/layouts/concepts/single.html reads
// `.Params.blogPosts` to render the "Blog posts discussing this" section.
// Without this pipeline step the section would never render — the
// `/build/concepts` payload carries blogPosts[] (added in Task 2 via
// srv/lib/published-concepts-query.js) but it has to be emitted into the
// per-concept Hugo frontmatter for the template to see it.
//
// Mirrors the Phase 4.1 learningJourneys test pattern.

describe('frontmatter — blogPosts', () => {
  const baseConcept: ConceptPayload = {
    slug: 'cap-handlers',
    name: 'CAP handlers',
    description: 'd',
    teaches: [],
    requires: [],
    requiredBy: [],
    relatedTo: [],
  }

  it('omits the blogPosts key entirely when the array is empty', () => {
    const out = frontmatter({ ...baseConcept, blogPosts: [] })
    expect(out).not.toContain('blogPosts')
  })

  it('omits the blogPosts key entirely when undefined', () => {
    const out = frontmatter(baseConcept)
    expect(out).not.toContain('blogPosts')
  })

  it('emits one blog post with all fields', () => {
    const out = frontmatter({
      ...baseConcept,
      blogPosts: [{
        slug: 'bp-99999',
        title: 'A Post',
        url: 'https://example.com/p',
        authorName: 'A User',
        postedAt: '2026-05-15T00:00:00Z',
      }],
    })
    expect(out).toContain('blogPosts:')
    expect(out).toContain('- slug: "bp-99999"')
    expect(out).toContain('    title: "A Post"')
    expect(out).toContain('    url: "https://example.com/p"')
    expect(out).toContain('    authorName: "A User"')
    expect(out).toContain('    postedAt: "2026-05-15T00:00:00Z"')
  })

  it('emits multiple blog posts preserving order', () => {
    const out = frontmatter({
      ...baseConcept,
      blogPosts: [
        {
          slug: 'bp-aaa',
          title: 'A',
          url: 'https://example.com/a',
          authorName: 'Alice',
          postedAt: '2026-01-01T00:00:00Z',
        },
        {
          slug: 'bp-bbb',
          title: 'B',
          url: 'https://example.com/b',
          authorName: 'Bob',
          postedAt: '2026-02-01T00:00:00Z',
        },
      ],
    })
    const aIdx = out.indexOf('"bp-aaa"')
    const bIdx = out.indexOf('"bp-bbb"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  it('escapes title/url/authorName for YAML safety', () => {
    const out = frontmatter({
      ...baseConcept,
      blogPosts: [{
        slug: 'bp-tricky',
        title: 'Title with "quotes" and \\backslash',
        url: 'https://example.com/x',
        authorName: 'Author "Nick" Surname',
        postedAt: '2026-05-15T00:00:00Z',
      }],
    })
    expect(out).toContain('Title with \\"quotes\\" and \\\\backslash')
    expect(out).toContain('Author \\"Nick\\" Surname')
  })
})
