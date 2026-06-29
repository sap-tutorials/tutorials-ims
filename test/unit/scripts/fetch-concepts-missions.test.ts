import { describe, it, expect } from 'vitest'
import { frontmatter, type ConceptPayload } from '../../../scripts/fetch-concepts.ts'

// Phase 4.3 (#447 §8) — frontmatter() discoveryMissions emission.
//
// The Hugo template at hugo/layouts/concepts/single.html reads
// `.Params.discoveryMissions` to render the "Discovery missions teaching
// this" section. Without this pipeline step the section would never
// render — the `/build/concepts` payload carries discoveryMissions[]
// (added in Task 2 via srv/lib/published-concepts-query.js) but it has
// to be emitted into the per-concept Hugo frontmatter for the template
// to see it.
//
// Key wrinkle vs. learningJourneys/blogPosts: the wire ships a raw
// `categorySlug` short-code (from the Discovery Center MCP), but the
// template renders a user-facing English label. Resolution happens
// at frontmatter emission time via the shared helper at
// srv/lib/discovery-mission-categories.js. Known slugs map to canonical
// English; unknown slugs fall back to title-case.

describe('frontmatter — discoveryMissions', () => {
  const baseConcept: ConceptPayload = {
    slug: 'cap-handlers',
    name: 'CAP handlers',
    description: 'd',
    teaches: [],
    requires: [],
    requiredBy: [],
    relatedTo: [],
  }

  it('omits the discoveryMissions key entirely when the array is empty', () => {
    const out = frontmatter({ ...baseConcept, discoveryMissions: [] })
    expect(out).not.toContain('discoveryMissions')
  })

  it('omits the discoveryMissions key entirely when undefined', () => {
    const out = frontmatter(baseConcept)
    expect(out).not.toContain('discoveryMissions')
  })

  it('emits one mission with all fields and resolves a known categorySlug to its label', () => {
    const out = frontmatter({
      ...baseConcept,
      discoveryMissions: [{
        slug: 'dm-3019',
        title: 'Get Started with SAP BTP Enterprise Account',
        url: 'https://discovery-center.cloud.sap/missiondetail/3019/',
        effortLevel: 2,
        categorySlug: 'onboard',
      }],
    })
    expect(out).toContain('discoveryMissions:')
    expect(out).toContain('- slug: "dm-3019"')
    expect(out).toContain('    title: "Get Started with SAP BTP Enterprise Account"')
    expect(out).toContain('    url: "https://discovery-center.cloud.sap/missiondetail/3019/"')
    expect(out).toContain('    effortLevel: 2')
    // Known slug resolves to canonical English label, not the raw slug.
    expect(out).toContain('    categoryLabel: "Onboarding"')
    expect(out).not.toContain('categorySlug')
  })

  it('falls back to title-case for unknown category slugs', () => {
    const out = frontmatter({
      ...baseConcept,
      discoveryMissions: [{
        slug: 'dm-9999',
        title: 'IoT Mission',
        url: 'https://discovery-center.cloud.sap/missiondetail/9999/',
        effortLevel: 3,
        categorySlug: 'iot', // not in the known table
      }],
    })
    expect(out).toContain('    categoryLabel: "Iot"')
  })

  it('emits multiple missions preserving order', () => {
    const out = frontmatter({
      ...baseConcept,
      discoveryMissions: [
        {
          slug: 'dm-aaa',
          title: 'A',
          url: 'https://discovery-center.cloud.sap/missiondetail/aaa/',
          effortLevel: 1,
          categorySlug: 'develop',
        },
        {
          slug: 'dm-bbb',
          title: 'B',
          url: 'https://discovery-center.cloud.sap/missiondetail/bbb/',
          effortLevel: 4,
          categorySlug: 'intgn',
        },
      ],
    })
    const aIdx = out.indexOf('"dm-aaa"')
    const bIdx = out.indexOf('"dm-bbb"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  it('omits effortLevel when null/undefined and omits categoryLabel when slug absent', () => {
    const out = frontmatter({
      ...baseConcept,
      discoveryMissions: [{
        slug: 'dm-bare',
        title: 'Bare Mission',
        url: 'https://discovery-center.cloud.sap/missiondetail/bare/',
        // no effortLevel, no categorySlug
      }],
    })
    expect(out).toContain('discoveryMissions:')
    expect(out).toContain('- slug: "dm-bare"')
    expect(out).toContain('    title: "Bare Mission"')
    expect(out).not.toContain('effortLevel:')
    expect(out).not.toContain('categoryLabel:')
  })

  it('escapes title/url for YAML safety', () => {
    const out = frontmatter({
      ...baseConcept,
      discoveryMissions: [{
        slug: 'dm-tricky',
        title: 'Title with "quotes" and \\backslash',
        url: 'https://discovery-center.cloud.sap/missiondetail/tricky/',
        effortLevel: 2,
        categorySlug: 'develop',
      }],
    })
    expect(out).toContain('Title with \\"quotes\\" and \\\\backslash')
  })
})
