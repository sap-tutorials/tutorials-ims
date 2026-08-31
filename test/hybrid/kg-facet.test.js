import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('KG facet reads (hybrid)', () => {
  let admin
  beforeAll(async () => { admin = await cds.connect.to('AdminService') })
  it('reads a tutorial with KG associations expanded without error', async () => {
    const t = await admin.run(SELECT.one.from('AdminService.Tutorials').columns('ID', 'slug'))
    expect(t).toBeTruthy()
    const links = await admin.run(SELECT.from('AdminService.TutorialConceptLinks').where({ tutorial_ID: t.ID }))
    expect(Array.isArray(links)).toBe(true)          // may be empty in DEV — that's fine
    const co = await admin.run(SELECT.from('AdminService.CoCompletions').limit(1))
    expect(Array.isArray(co)).toBe(true)
  })
})
