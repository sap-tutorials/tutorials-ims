import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

describe('Contributors LineItem', () => {
  let m
  beforeAll(async () => { m = await cds.load('*') })
  it('LineItem includes login column', () => {
    const e = m.definitions['AdminService.TutorialContributors']
    const li = e['@UI.LineItem']
    const values = li.map((x) => x.Value?.['='] || x.Value)
    expect(values).toContain('login')
  })
})
