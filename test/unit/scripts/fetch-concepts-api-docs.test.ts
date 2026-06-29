import { describe, it, expect } from 'vitest'
import { frontmatter, type ConceptPayload } from '../../../scripts/fetch-concepts.ts'

// Phase 4.5 (#746 §5) — frontmatter() apiDocs emission.
//
// The Hugo template at hugo/layouts/concepts/single.html reads
// `.Params.apiDocs` to render the "Official reference documentation"
// section. Without this pipeline step the section would never render —
// the `/build/concepts` payload carries apiDocs[] (added in Task 2 via
// srv/lib/published-concepts-query.js) but it has to be emitted into
// the per-concept Hugo frontmatter for the template to see it.
//
// Pass-through emitter (mirrors Phase 4.4 videos): `category` and
// `apiType` flow through verbatim. No helper transformation.

describe('fetch-concepts api-docs frontmatter', () => {
  const baseConcept: ConceptPayload = {
    slug: 'cap-cqn',
    name: 'CAP CQN',
    description: 'd',
    teaches: [],
    requires: [],
    requiredBy: [],
    relatedTo: [],
  }

  it('emits apiDocs YAML block when non-empty', () => {
    const fm = frontmatter({
      ...baseConcept,
      apiDocs: [{
        slug: 'ad-cap_cqn_reference',
        title: 'CAP CQN Reference',
        url: 'https://api.sap.com/package/CAP_CQN_Reference',
        category: 'CAP',
        apiType: 'reference',
      }],
    })
    expect(fm).toContain('apiDocs:')
    expect(fm).toContain('slug: "ad-cap_cqn_reference"')
    expect(fm).toContain('title: "CAP CQN Reference"')
    expect(fm).toContain('url: "https://api.sap.com/package/CAP_CQN_Reference"')
    expect(fm).toContain('category: "CAP"')
    expect(fm).toContain('apiType: "reference"')
  })

  it('omits the apiDocs block when empty', () => {
    const fm = frontmatter({ ...baseConcept, apiDocs: [] })
    expect(fm).not.toContain('apiDocs:')
  })

  it('omits the apiDocs block when undefined', () => {
    const fm = frontmatter(baseConcept)
    expect(fm).not.toContain('apiDocs:')
  })

  it('passes category + apiType through verbatim (no transformation)', () => {
    const fm = frontmatter({
      ...baseConcept,
      slug: 's4-bp',
      name: 'S/4 Business Partner',
      apiDocs: [{
        slug: 'ad-api_business_partner',
        title: 'Business Partner API',
        url: 'https://api.sap.com/api/API_BUSINESS_PARTNER',
        category: 'S/4HANA',
        apiType: 'odata-v2',
      }],
    })
    expect(fm).toContain('category: "S/4HANA"')
    expect(fm).toContain('apiType: "odata-v2"')
  })

  it('omits optional fields when undefined and keeps required (slug/title/url)', () => {
    const fm = frontmatter({
      ...baseConcept,
      apiDocs: [{
        slug: 'ad-bare',
        title: 'Bare API Doc',
        url: 'https://api.sap.com/something',
        // no category, no apiType
      }],
    })
    expect(fm).toContain('apiDocs:')
    expect(fm).toContain('- slug: "ad-bare"')
    expect(fm).toContain('    title: "Bare API Doc"')
    expect(fm).toContain('    url: "https://api.sap.com/something"')
    expect(fm).not.toContain('category:')
    expect(fm).not.toContain('apiType:')
  })

  it('emits multiple api-docs preserving order', () => {
    const fm = frontmatter({
      ...baseConcept,
      apiDocs: [
        { slug: 'ad-a', title: 'A', url: 'https://api.sap.com/a' },
        { slug: 'ad-b', title: 'B', url: 'https://api.sap.com/b' },
      ],
    })
    const aIdx = fm.indexOf('"ad-a"')
    const bIdx = fm.indexOf('"ad-b"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  it('escapes title for YAML safety', () => {
    const fm = frontmatter({
      ...baseConcept,
      apiDocs: [{
        slug: 'ad-tricky',
        title: 'API "Quoted" and \\backslash',
        url: 'https://api.sap.com/tricky',
      }],
    })
    expect(fm).toContain('API \\"Quoted\\" and \\\\backslash')
  })
})
