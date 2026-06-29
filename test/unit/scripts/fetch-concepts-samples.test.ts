import { describe, it, expect } from 'vitest'
import { frontmatter, type ConceptPayload } from '../../../scripts/fetch-concepts.ts'

// Phase 4.6 (#747 §5) — frontmatter() samples emission.
//
// The Hugo template at hugo/layouts/concepts/single.html reads
// `.Params.samples` to render the "Code samples embodying this" section.
// Without this pipeline step the section would never render — the
// `/build/concepts` payload carries samples[] (added in Task 2 via
// srv/lib/published-concepts-query.js) but it has to be emitted into
// the per-concept Hugo frontmatter for the template to see it.
//
// Pass-through emitter (mirrors Phase 4.5 apiDocs): `language`, `stars`,
// and `lastCommitAt` flow through verbatim. No helper transformation.

describe('fetch-concepts samples frontmatter', () => {
  const baseConcept: ConceptPayload = {
    slug: 'cap-handlers',
    name: 'CAP handlers',
    description: 'd',
    teaches: [],
    requires: [],
    requiredBy: [],
    relatedTo: [],
  }

  it('emits samples YAML block when non-empty', () => {
    const fm = frontmatter({
      ...baseConcept,
      samples: [{
        slug: 'sa-sap_samples__cloud_cap_samples',
        title: 'cloud-cap-samples',
        url: 'https://github.com/SAP-samples/cloud-cap-samples',
        language: 'JavaScript',
        stars: 423,
        lastCommitAt: '2026-06-15T14:32:11Z',
      }],
    })
    expect(fm).toContain('samples:')
    expect(fm).toContain('slug: "sa-sap_samples__cloud_cap_samples"')
    expect(fm).toContain('title: "cloud-cap-samples"')
    expect(fm).toContain('url: "https://github.com/SAP-samples/cloud-cap-samples"')
    expect(fm).toContain('language: "JavaScript"')
    expect(fm).toContain('stars: 423')
    expect(fm).toContain('lastCommitAt: "2026-06-15T14:32:11Z"')
  })

  it('omits the samples block when empty', () => {
    const fm = frontmatter({ ...baseConcept, samples: [] })
    expect(fm).not.toContain('samples:')
  })

  it('omits the samples block when undefined', () => {
    const fm = frontmatter(baseConcept)
    expect(fm).not.toContain('samples:')
  })

  it('passes optional fields through verbatim (no transformation)', () => {
    const fm = frontmatter({
      ...baseConcept,
      slug: 's4',
      name: 'S4',
      samples: [{
        slug: 'sa-s4',
        title: 'S4 Sample',
        url: 'https://github.com/SAP-samples/s4',
        language: 'Java',
        stars: 12,
        lastCommitAt: '2026-03-20T09:15:22Z',
      }],
    })
    expect(fm).toContain('language: "Java"')
    expect(fm).toContain('stars: 12')
    expect(fm).toContain('lastCommitAt: "2026-03-20T09:15:22Z"')
  })

  it('omits optional fields when undefined and keeps required (slug/title/url)', () => {
    const fm = frontmatter({
      ...baseConcept,
      samples: [{
        slug: 'sa-min',
        title: 'Minimal',
        url: 'https://github.com/SAP-samples/min',
      }],
    })
    expect(fm).toContain('samples:')
    expect(fm).toContain('- slug: "sa-min"')
    expect(fm).toContain('    title: "Minimal"')
    expect(fm).toContain('    url: "https://github.com/SAP-samples/min"')
    expect(fm).not.toContain('language:')
    expect(fm).not.toContain('stars:')
    expect(fm).not.toContain('lastCommitAt:')
  })

  it('emits multiple samples preserving order', () => {
    const fm = frontmatter({
      ...baseConcept,
      samples: [
        { slug: 'sa-a', title: 'A', url: 'https://github.com/SAP-samples/a' },
        { slug: 'sa-b', title: 'B', url: 'https://github.com/SAP-samples/b' },
      ],
    })
    const aIdx = fm.indexOf('"sa-a"')
    const bIdx = fm.indexOf('"sa-b"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  it('escapes title for YAML safety', () => {
    const fm = frontmatter({
      ...baseConcept,
      samples: [{
        slug: 'sa-tricky',
        title: 'Sample "Quoted" and \\backslash',
        url: 'https://github.com/SAP-samples/tricky',
      }],
    })
    expect(fm).toContain('Sample \\"Quoted\\" and \\\\backslash')
  })

  it('handles stars: 0 by still emitting the line (falsy-safe)', () => {
    const fm = frontmatter({
      ...baseConcept,
      samples: [{
        slug: 'sa-zero',
        title: 'Zero Stars',
        url: 'https://github.com/SAP-samples/zero',
        stars: 0,
      }],
    })
    expect(fm).toContain('stars: 0')
  })
})
