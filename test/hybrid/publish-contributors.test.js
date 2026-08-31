import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { replaceContributorsForSlug } from '../../srv/lib/contributors-publish.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe('contributors publish (hybrid)', () => {
  let db
  beforeAll(async () => { db = await cds.connect.to('db') })
  it('links contributor rows to an existing tutorial by slug', async () => {
    const { Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims')
    const t = await db.run(SELECT.one.from(Tutorials).columns('ID', 'slug'))
    expect(t).toBeTruthy()
    await replaceContributorsForSlug(db, t.slug, [
      { login: 'octocat', name: 'Octo', email: 'o@x.com', avatarUrl: 'https://github.com/octocat.png' },
    ])
    const rows = await db.run(SELECT.from(TutorialContributors).where({ tutorial_ID: t.ID, login: 'octocat' }))
    expect(rows.length).toBe(1)
    expect(rows[0].profileUrl).toBe('https://github.com/octocat')
    // cleanup
    await db.run(DELETE.from(TutorialContributors).where({ tutorial_ID: t.ID, login: 'octocat' }))
  })
})
