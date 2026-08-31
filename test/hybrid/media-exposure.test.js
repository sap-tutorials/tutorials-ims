import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('media exposure (hybrid)', () => {
  let admin
  beforeAll(async () => { admin = await cds.connect.to('AdminService') })
  it('reads images for a tutorial without LOB errors', async () => {
    const t = await admin.run(SELECT.one.from('AdminService.Tutorials').columns('ID', 'slug'))
    expect(t).toBeTruthy()
    // metadata-only read (no BLOB mix — never select 'content')
    const imgs = await admin.run(SELECT.from('AdminService.TutorialImages').columns('ID', 'sourceUrl', 'mimeType', 'byteSize').where({ slug: t.slug }))
    expect(Array.isArray(imgs)).toBe(true)
  })
})
