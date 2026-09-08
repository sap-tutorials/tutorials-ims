import { describe, it, expect } from 'vitest'
import { renderHugoFrontmatter } from '../parsers/render-frontmatter.js'

const base = {
  slug: 't', title: 'T', description: 'd', time: 10, level: 'beginner',
  author: 'A', authorProfile: 'p', youWillLearn: [], prerequisites: '',
  steps: [], nav: { prev: null, next: null }, lastUpdated: '', createdAt: '',
  contributors: [],
}

describe('renderHugoFrontmatter smTechIds', () => {
  it('emits smTechIds for tags that hit the semaphore map', () => {
    const out = renderHugoFrontmatter({
      ...base,
      tags: ['software-product>sap-hana'],
      primaryTag: 'software-product>sap-hana',
      semaphoreMap: { 'software-product>sap-hana': '7355001' },
    })
    expect(out).toContain('smTechIds:')
    expect(out).toContain('7355001')
  })

  it('omits the smTechIds key entirely when no tag matches', () => {
    const out = renderHugoFrontmatter({
      ...base,
      tags: ['topic>something'],
      primaryTag: 'topic>something',
      semaphoreMap: { 'software-product>sap-hana': '7355001' },
    })
    expect(out).not.toContain('smTechIds')
  })

  it('omits smTechIds when no map is passed', () => {
    const out = renderHugoFrontmatter({
      ...base,
      tags: ['software-product>sap-hana'],
      primaryTag: 'software-product>sap-hana',
    })
    expect(out).not.toContain('smTechIds')
  })

  it('dedupes smTechIds when two distinct tag slugs resolve to the same semaphoreId', () => {
    // Two different product-tag slugs map to the same ID — the rendered
    // frontmatter must contain that ID exactly once (byte-identical with the
    // SSR path which already de-dupes via Set).
    const out = renderHugoFrontmatter({
      ...base,
      tags: ['software-product>sap-hana', 'software-product>sap-hana-cloud'],
      primaryTag: 'software-product>sap-hana',
      semaphoreMap: {
        'software-product>sap-hana': '7355001',
        'software-product>sap-hana-cloud': '7355001',
      },
    })
    expect(out).toContain('smTechIds:')
    // The ID string must appear exactly once in the whole frontmatter output.
    const occurrences = (out.match(/7355001/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})
