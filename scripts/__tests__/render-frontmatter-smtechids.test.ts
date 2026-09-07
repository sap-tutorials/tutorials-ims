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
})
