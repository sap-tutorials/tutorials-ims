// test/unit/contributors-publish.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'
import { replaceContributorsForSlug } from '../../srv/lib/contributors-publish.js'

describe('replaceContributorsForSlug', () => {
  let db
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:')
    db = cds.db
  })

  it('replaces rows for the slug and derives profileUrl', async () => {
    const { Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims')
    const ID = cds.utils.uuid()
    await db.run(INSERT.into(Tutorials).entries({ ID, slug: 'demo', title: 'Demo' }))

    await replaceContributorsForSlug(db, 'DEMO', [
      { login: 'octocat', name: 'Octo Cat', email: 'o@x.com', avatarUrl: 'https://github.com/octocat.png' },
    ])
    let rows = await db.run(SELECT.from(TutorialContributors).where({ tutorial_ID: ID }))
    expect(rows).toHaveLength(1)
    expect(rows[0].login).toBe('octocat')
    expect(rows[0].profileUrl).toBe('https://github.com/octocat')

    // Second publish REPLACES, does not append.
    await replaceContributorsForSlug(db, 'demo', [
      { login: 'hubot', name: 'Hubot', email: 'h@x.com', avatarUrl: 'https://github.com/hubot.png' },
    ])
    rows = await db.run(SELECT.from(TutorialContributors).where({ tutorial_ID: ID }))
    expect(rows).toHaveLength(1)
    expect(rows[0].login).toBe('hubot')
  })
})
