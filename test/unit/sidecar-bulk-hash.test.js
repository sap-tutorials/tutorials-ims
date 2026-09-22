// test/unit/sidecar-bulk-hash.test.js
// Server-side coverage for the bulk REPLACE handlers (#2463) and the sidecar
// hash feeds (#2464), including the client↔server hash-agreement invariant that
// makes delta-skip correct.
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import cds from '@sap/cds'
import {
  replaceContributorsBulk, contributorHashesBySlug,
} from '../../srv/lib/contributors-publish.js'
import {
  replaceValidationRulesBulk, validationRuleHashesBySlug,
} from '../../srv/lib/validation-rules-publish.js'
import { hashContributors, hashValidationRules } from '../../srv/lib/sidecar-hash.js'

const NS = 'com.sap.developers.ims'

describe('sidecar bulk + hash (#2463 / #2464)', () => {
  let db
  beforeAll(async () => {
    await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:')
    db = cds.db
    const { Tutorials } = cds.entities(NS)
    await db.run(INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), slug: 'a', title: 'A' },
      { ID: cds.utils.uuid(), slug: 'b', title: 'B' },
    ]))
  })

  it('replaceContributorsBulk isolates slugs and reports notFound', async () => {
    const { TutorialContributors } = cds.entities(NS)
    const res = await replaceContributorsBulk(db, [
      { slug: 'a', contributors: [{ login: 'octocat', name: 'O', email: 'o@x', avatarUrl: 'av' }] },
      { slug: 'b', contributors: [{ login: 'hubot', name: 'H', email: 'h@x', avatarUrl: 'av' }] },
      { slug: 'ghost', contributors: [{ login: 'nope' }] },
    ])
    expect(res.replaced).toBe(2)
    expect(res.notFound).toEqual(['ghost'])
    const all = await db.run(SELECT.from(TutorialContributors).columns('login'))
    expect(all.map((r) => r.login).sort()).toEqual(['hubot', 'octocat'])

    // Re-publishing slug 'a' does not touch slug 'b' rows.
    await replaceContributorsBulk(db, [{ slug: 'a', contributors: [] }])
    const bRows = await db.run(SELECT.from(TutorialContributors))
    expect(bRows).toHaveLength(1)
    expect(bRows[0].login).toBe('hubot')
  })

  it('contributorHashesBySlug matches the client hash of the same sidecar', async () => {
    const contributors = [{ login: 'octocat', name: 'O', email: 'o@x', avatarUrl: 'av' }]
    await replaceContributorsBulk(db, [{ slug: 'a', contributors }])
    const serverMap = await contributorHashesBySlug(db)
    // Client hashes the sidecar JSON with the SAME helper — they must agree,
    // otherwise delta-skip (#2464) never fires.
    expect(serverMap['a']).toBe(hashContributors(contributors))
  })

  it('replaceValidationRulesBulk isolates slugs and reports notFound', async () => {
    const { TutorialValidationRules } = cds.entities(NS)
    const res = await replaceValidationRulesBulk(db, [
      { slug: 'a', rules: [{ stepNumber: 1, questionId: 'q1', ruleType: 'single-choice', questionType: 'MCQ' }] },
      { slug: 'ghost', rules: [] },
    ])
    expect(res.replaced).toBe(1)
    expect(res.notFound).toEqual(['ghost'])
    const rows = await db.run(SELECT.from(TutorialValidationRules))
    expect(rows).toHaveLength(1)
    expect(rows[0].questionId).toBe('q1')
  })

  it('validationRuleHashesBySlug matches the client hash of the same sidecar', async () => {
    const rules = [{ stepNumber: 2, questionId: 'q2', questionText: 'T', ruleType: 'single-choice', questionType: 'MCQ', aiGrading: false }]
    await replaceValidationRulesBulk(db, [{ slug: 'b', rules }])
    const serverMap = await validationRuleHashesBySlug(db)
    expect(serverMap['b']).toBe(hashValidationRules(rules))
  })
})
